"""Sandbox runners: launch the trace worker in isolation and supervise it.

User code never runs in the API process. The parent side here only spawns the
worker, feeds it the payload over stdin, enforces a hard wall-clock watchdog and
a cap on bytes read back, and parses the nonce-tagged result line.
"""

import json
import logging
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from app.config import WORKER_SCRIPT, Settings

log = logging.getLogger(__name__)

OOM_EXIT_CODES = {137, -9}


@dataclass
class SandboxResult:
    status: str  # completed | timed_out | failed
    exit_code: Optional[int]
    stdout: str = ""
    stderr: str = ""
    error: Optional[dict[str, Any]] = None
    events: list[dict[str, Any]] = field(default_factory=list)
    trace_truncated: bool = False
    output_truncated: bool = False
    duration_ms: float = 0.0
    # Test mode only.
    tests: list[dict[str, Any]] = field(default_factory=list)
    collection_error: bool = False
    runner: str = "builtin"
    omitted_steps: int = 0
    recording_stopped: bool = False

    @classmethod
    def from_worker(cls, data: dict[str, Any]) -> "SandboxResult":
        return cls(
            status=data["status"],
            exit_code=data["exit_code"],
            stdout=data.get("stdout", ""),
            stderr=data.get("stderr", ""),
            error=data.get("error"),
            events=data.get("events", []),
            trace_truncated=data.get("trace_truncated", False),
            output_truncated=data.get("output_truncated", False),
            duration_ms=data.get("duration_ms", 0.0),
            tests=data.get("tests", []),
            collection_error=data.get("collection_error", False),
            runner=data.get("runner", "builtin"),
            omitted_steps=data.get("omitted_steps", 0),
            recording_stopped=data.get("recording_stopped", False),
        )


class _CappedReader(threading.Thread):
    """Drain a pipe into memory, stopping (and flagging) once `limit` bytes are read."""

    def __init__(self, pipe, limit: int, on_overflow: Callable[[], None]):
        super().__init__(daemon=True)
        self._pipe = pipe
        self._limit = limit
        self._on_overflow = on_overflow
        self.chunks: list[bytes] = []
        self.size = 0
        self.overflowed = False

    def run(self) -> None:
        try:
            while chunk := self._pipe.read(65536):
                if self.size + len(chunk) > self._limit:
                    self.overflowed = True
                    self._on_overflow()
                    break
                self.chunks.append(chunk)
                self.size += len(chunk)
        except (OSError, ValueError):
            pass

    @property
    def data(self) -> bytes:
        return b"".join(self.chunks)


class SandboxRunner:
    def __init__(self, settings: Settings):
        self.settings = settings

    # Subclasses supply the command line and how to tear the sandbox down.
    def _command(self, run_name: str) -> list[str]:
        raise NotImplementedError

    def _popen_kwargs(self, workdir: str) -> dict[str, Any]:
        return {}

    def _kill(self, proc: subprocess.Popen, run_name: str) -> None:
        proc.kill()

    def _extra_payload(self) -> dict[str, Any]:
        return {}

    def _diagnose(self, stderr_tail: str) -> Optional[str]:
        """Explain an infrastructure failure from the launcher's stderr, if recognisable."""
        return None

    def _start(self, run_name: str, workdir: str) -> tuple[subprocess.Popen, str]:
        """Start a sandbox process; returns it and the name used to kill it."""
        proc = subprocess.Popen(
            self._command(run_name),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **self._popen_kwargs(workdir),
        )
        return proc, run_name

    def _after_start(self, proc: subprocess.Popen) -> Callable[[], None]:
        """Per-process setup (e.g. resource limits); returns a cleanup callback."""
        return lambda: None

    def close(self) -> None:
        """Release long-lived resources (e.g. pre-started containers)."""

    def run(self, execution_id: str, source: str, *, timeout: float, max_events: int,
            files: Optional[dict[str, str]] = None, stdin: str = "") -> SandboxResult:
        """Trace mode: run the program under sys.settrace."""
        return self._invoke(
            execution_id,
            {"mode": "trace", "source": source, "max_events": max_events, "files": files or {}, "stdin": stdin,
             "trace_budget": self.settings.trace_budget},
            timeout,
        )

    def run_tests(self, run_id: str, source: str, tests: str, *, timeout: float,
                  files: Optional[dict[str, str]] = None, stdin: str = "") -> SandboxResult:
        """Test mode: import the program as `main` and run the test_* tests (pytest when installed)."""
        return self._invoke(run_id, {"mode": "test", "source": source, "tests": tests, "files": files or {},
                                     "stdin": stdin}, timeout)

    def _invoke(self, run_id: str, job: dict[str, Any], timeout: float) -> SandboxResult:
        nonce = f"@@CODELENS-{secrets.token_hex(16)}@@"
        payload = {
            "execution_id": run_id,
            "timeout_seconds": timeout,
            "nonce": nonce,
            **job,
            **self._extra_payload(),
        }
        run_name = f"codelens-{run_id}"
        hard_deadline = timeout + self.settings.hard_kill_grace_seconds
        started = time.monotonic()

        with tempfile.TemporaryDirectory(prefix="codelens-") as workdir:
            try:
                proc, run_name = self._start(run_name, workdir)
            except OSError as exc:
                log.error("cannot start sandbox: %s", exc)
                return SandboxResult(
                    status="failed",
                    exit_code=None,
                    error={"type": "SandboxError", "message": f"cannot start sandbox: {exc}", "line": 0},
                )
            cleanup = self._after_start(proc)
            kill = lambda: self._kill(proc, run_name)  # noqa: E731
            out = _CappedReader(proc.stdout, self.settings.max_worker_result_bytes, kill)
            err = _CappedReader(proc.stderr, 64 * 1024, lambda: None)
            out.start()
            err.start()

            try:
                proc.stdin.write(json.dumps(payload).encode("utf-8"))
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass

            watchdog_fired = False
            try:
                proc.wait(timeout=hard_deadline)
            except subprocess.TimeoutExpired:
                watchdog_fired = True
                kill()
                proc.wait()
            out.join(timeout=5)
            err.join(timeout=5)
            cleanup()

        elapsed_ms = round((time.monotonic() - started) * 1000, 1)
        data = _parse_result(out.data, nonce)
        if data is not None:
            return SandboxResult.from_worker(data)

        if watchdog_fired:
            return SandboxResult(
                status="timed_out",
                exit_code=124,
                error={"type": "TimeoutError", "message": f"sandbox killed after {hard_deadline:.1f}s", "line": 0},
                duration_ms=elapsed_ms,
            )
        tail = err.data.decode("utf-8", "replace")[-2000:]
        if out.overflowed:
            message = "worker result exceeded size limit"
        elif proc.returncode in OOM_EXIT_CODES:
            message = "worker killed: memory limit exceeded"
        elif diagnosis := self._diagnose(tail):
            message = diagnosis
        else:
            log.warning("worker %s exited %s without result: %s", run_id, proc.returncode, tail)
            message = f"worker exited with code {proc.returncode} without a result"
        return SandboxResult(
            status="failed",
            exit_code=proc.returncode,
            error={"type": "SandboxError", "message": message, "line": 0},
            duration_ms=elapsed_ms,
        )


def _parse_result(stdout: bytes, nonce: str) -> Optional[dict[str, Any]]:
    marker = nonce.encode("ascii")
    idx = stdout.rfind(marker)
    if idx < 0:
        return None
    line = stdout[idx + len(marker):].split(b"\n", 1)[0]
    try:
        return json.loads(line)
    except ValueError:
        return None


class DockerSandboxRunner(SandboxRunner):
    """Production runner (spec §3.4): one throwaway, locked-down container per run.

    Starting a container costs ~1 s (much more on a cold Docker Desktop), so a few are
    started ahead of time. Each one blocks reading its job from stdin and is used once.
    """

    POOL_MAX_AGE_SECONDS = 600

    def __init__(self, settings: Settings):
        super().__init__(settings)
        self._pool: list[tuple[subprocess.Popen, str, float]] = []
        self._pool_lock = threading.Lock()
        self._closed = False
        self._refill()

    def _spawn(self) -> tuple[subprocess.Popen, str, float]:
        name = f"codelens-pool-{uuid.uuid4().hex[:12]}"
        proc = subprocess.Popen(self._command(name), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        return proc, name, time.monotonic()

    def _refill(self) -> None:
        if self.settings.docker_pool_size <= 0:
            return

        def fill() -> None:
            while not self._closed:
                with self._pool_lock:
                    if len(self._pool) >= self.settings.docker_pool_size:
                        return
                try:
                    entry = self._spawn()
                except OSError:
                    return  # docker CLI missing; runs will report it
                with self._pool_lock:
                    if self._closed:
                        self._discard(entry)
                        return
                    self._pool.append(entry)

        threading.Thread(target=fill, name="docker-pool", daemon=True).start()

    def _discard(self, entry: tuple[subprocess.Popen, str, float]) -> None:
        proc, name, _ = entry
        if proc.poll() is None:
            self._kill(proc, name)

    def _start(self, run_name: str, workdir: str) -> tuple[subprocess.Popen, str]:
        entry = None
        with self._pool_lock:
            while self._pool:
                candidate = self._pool.pop(0)
                fresh = time.monotonic() - candidate[2] < self.POOL_MAX_AGE_SECONDS
                if candidate[0].poll() is None and fresh:
                    entry = candidate
                    break
                threading.Thread(target=self._discard, args=(candidate,), daemon=True).start()
        self._refill()
        if entry is not None:
            return entry[0], entry[1]
        return super()._start(run_name, workdir)

    def close(self) -> None:
        self._closed = True
        with self._pool_lock:
            pool, self._pool = self._pool, []
        for entry in pool:
            self._discard(entry)

    def _command(self, run_name: str) -> list[str]:
        s = self.settings
        return [
            "docker", "run", "--rm", "-i",
            "--name", run_name,
            "--network", "none",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--read-only",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
            "--memory", s.docker_memory,
            "--memory-swap", s.docker_memory,
            "--cpus", s.docker_cpus,
            "--pids-limit", str(s.docker_pids_limit),
            "--user", "10001:10001",
            "--env", "PYTHONIOENCODING=utf-8",
            s.docker_image,
        ]

    def _diagnose(self, stderr_tail: str) -> Optional[str]:
        lowered = stderr_tail.lower()
        if "unable to find image" in lowered or "pull access denied" in lowered:
            return f"worker image {self.settings.docker_image!r} not found; build it with: docker build -t {self.settings.docker_image} backend/worker"
        if "docker daemon" in lowered or "docker api" in lowered or "dockerdesktop" in lowered:
            return "docker daemon is not reachable; start Docker or set CODELENS_SANDBOX=subprocess for local dev"
        return None

    def _kill(self, proc: subprocess.Popen, run_name: str) -> None:
        # Killing the `docker run` client does not stop the container itself.
        try:
            subprocess.run(["docker", "kill", run_name], capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass
        proc.kill()


class SubprocessSandboxRunner(SandboxRunner):
    """Local development runner. Process isolation only: NOT a security boundary."""

    def _command(self, run_name: str) -> list[str]:
        return [sys.executable, "-I", "-X", "utf8", str(WORKER_SCRIPT)]

    def _popen_kwargs(self, workdir: str) -> dict[str, Any]:
        # Minimal environment: API keys and other host secrets must never reach user code.
        env = {"PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
        for key in ("SYSTEMROOT", "PATH"):  # SYSTEMROOT is required by Python on Windows
            if key in os.environ:
                env[key] = os.environ[key]
        kwargs: dict[str, Any] = {"cwd": workdir, "env": env}
        if os.name == "posix":
            kwargs["start_new_session"] = True
        return kwargs

    def _kill(self, proc: subprocess.Popen, run_name: str) -> None:
        if os.name == "posix":
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # whole process group
            except ProcessLookupError:
                pass
        proc.kill()

    def _extra_payload(self) -> dict[str, Any]:
        return {"memory_limit_bytes": self.settings.subprocess_memory_bytes}

    def _after_start(self, proc: subprocess.Popen) -> Callable[[], None]:
        # POSIX caps memory with RLIMIT_AS inside the worker; Windows needs a Job Object.
        if sys.platform != "win32":
            return lambda: None
        return _windows_memory_job(proc, self.settings.subprocess_memory_bytes)


def _windows_memory_job(proc: subprocess.Popen, limit_bytes: int) -> Callable[[], None]:
    """Put the process in a Job Object with a per-process memory cap (kills it on close)."""
    import ctypes
    from ctypes import wintypes

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMITS(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMITS(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMITS), ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x100
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JobObjectExtendedLimitInformation = 9

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        log.warning("could not create Windows job object; dev sandbox has no memory cap")
        return lambda: None
    info = EXTENDED_LIMITS()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    info.ProcessMemoryLimit = limit_bytes
    ok = kernel32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info))
    ok = ok and kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(int(proc._handle)))  # type: ignore[attr-defined]
    if not ok:
        log.warning("could not apply Windows memory limit (error %s)", ctypes.get_last_error())
    return lambda: kernel32.CloseHandle(job)


def build_runner(settings: Settings) -> SandboxRunner:
    if settings.sandbox_backend == "docker":
        return DockerSandboxRunner(settings)
    if settings.sandbox_backend == "subprocess":
        log.warning("CODELENS_SANDBOX=subprocess: user code runs WITHOUT container isolation (dev only)")
        return SubprocessSandboxRunner(settings)
    raise ValueError(f"unknown CODELENS_SANDBOX backend: {settings.sandbox_backend!r}")
