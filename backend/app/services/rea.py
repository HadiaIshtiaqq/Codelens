"""REA (rea-agents) reverse-engineering subsystem (spec FR-02, §2.3, §4.3.1-2).

Two integration paths:
  * CLI      `rea <command> ... --format json` for one-shot jobs (doctor, JS app analysis)
  * MCP      a persistent stdio session to `rea --mcp` for the full tool catalogue
             (Ghidra/Hopper/IDA decompilation, binary layout, APK, WASM, ...)

Safety: REA reads host files and some tools drive debuggers or instrument
processes, so path arguments are confined to REA_WORKSPACE_ROOT and tools
annotated destructive are refused unless REA_ALLOW_DESTRUCTIVE=1.
"""

import asyncio
import collections
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Optional

from app.config import Settings

log = logging.getLogger(__name__)

MAX_CLI_OUTPUT_BYTES = 256 * 1024 * 1024
DOCTOR_CACHE_SECONDS = 300


class ReaError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


# ---------------------------------------------------------------------------
# Path confinement
# ---------------------------------------------------------------------------

def confine_path(settings: Settings, raw: str) -> str:
    """Resolve `raw` (absolute, or relative to the workspace root) and enforce confinement."""
    root = settings.rea_workspace_root
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    if not settings.rea_allow_any_path and resolved != root and root not in resolved.parents:
        raise ReaError(
            f"path {raw!r} is outside the REA workspace ({root}); copy the target there or set REA_ALLOW_ANY_PATH=1",
            status_code=403,
        )
    return str(resolved)


def _path_like_keys(schema: dict[str, Any]) -> set[str]:
    props = (schema or {}).get("properties", {}) or {}
    keys = set()
    for key, spec in props.items():
        desc = str((spec or {}).get("description", "")).lower()
        # `source_paths` are relative to the analysed application root, not host paths.
        if key.endswith("path") or (key.endswith("_paths") and key != "source_paths") or "filesystem path" in desc:
            keys.add(key)
    return keys


def confine_arguments(settings: Settings, schema: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    out = dict(arguments)
    for key in _path_like_keys(schema):
        value = out.get(key)
        if isinstance(value, str) and value:
            out[key] = confine_path(settings, value)
        elif isinstance(value, list):
            out[key] = [confine_path(settings, v) if isinstance(v, str) else v for v in value]
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _rea_env() -> dict[str, str]:
    # REA needs its provider variables (GHIDRA_INSTALL_DIR, REA_*_TIMEOUT_MS, ...) but
    # never the LLM credentials held by this process.
    return {k: v for k, v in os.environ.items() if k not in {"NEBIUS_API_KEY"}}


def run_cli(settings: Settings, args: list[str], timeout: float) -> dict[str, Any]:
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            proc = subprocess.run(
                [*settings.rea_command, *args, "--format", "json"],
                stdout=out,
                stderr=err,
                stdin=subprocess.DEVNULL,
                timeout=timeout,
                env=_rea_env(),
                cwd=str(settings.rea_workspace_root),
            )
        except FileNotFoundError as exc:
            raise ReaError(f"REA is not installed ({exc}); run `npm install` in the rea/ directory", 503) from exc
        except subprocess.TimeoutExpired as exc:
            raise ReaError(f"REA command timed out after {timeout:.0f}s", 504) from exc
        size = out.seek(0, os.SEEK_END)
        if size > MAX_CLI_OUTPUT_BYTES:
            raise ReaError(f"REA output too large ({size} bytes)")
        out.seek(0)
        stdout = out.read().decode("utf-8", "replace")
        err.seek(0)
        stderr_lines = [ln for ln in err.read().decode("utf-8", "replace").splitlines() if "rea_progress" not in ln]
    try:
        data = json.loads(stdout)
    except ValueError:
        detail = (stdout.strip() or "\n".join(stderr_lines))[-1500:]
        raise ReaError(f"REA exited {proc.returncode} without JSON output: {detail}")
    if proc.returncode != 0 and isinstance(data, dict) and ("error" in data or "code" in data):
        raise ReaError(f"REA error: {json.dumps(data)[:1500]}", 422)
    return data


# ---------------------------------------------------------------------------
# JavaScript / Electron projection (spec §4.3.1)
# ---------------------------------------------------------------------------

def _loc(observation: dict[str, Any]) -> tuple[Optional[str], Optional[int]]:
    value = ((observation.get("evidence") or {}).get("location") or {}).get("value") or {}
    return value.get("source"), (value.get("start") or {}).get("line")


def project_javascript_analysis(evidence: dict[str, Any]) -> dict[str, Any]:
    """Condense REA's JavaScript Application Graph Evidence into a UI/agent-friendly summary."""
    nr = evidence.get("normalized_result") or {}
    nodes = (nr.get("graph") or {}).get("nodes", [])
    kinds = collections.Counter(n.get("kind") for n in nodes)

    application: dict[str, Any] = {"name": (evidence.get("subject") or {}).get("name")}
    entrypoints, ipc, bridges, modules, external, native, compact = [], [], [], [], set(), [], []
    for node in nodes:
        kind = node.get("kind", "")
        obs = (node.get("observations") or [{}])[0]
        props = obs.get("properties") or {}
        label = obs.get("label")
        source, line = _loc(obs)
        compact.append({"kind": kind, "label": label, "source": source, "line": line})
        if kind == "package":
            application.update(
                {"name": props.get("name") or application["name"], "version": props.get("version"), "main": props.get("main")}
            )
        elif kind.startswith("electron-") and kind not in ("electron-fuse",):
            entrypoints.append({"type": kind.removeprefix("electron-"), "path": props.get("resolved_path") or label,
                                "mechanism": props.get("mechanism")})
        elif kind.startswith("ipc-"):
            ipc.append({
                "channel": props.get("channel") or label,
                "kind": kind,
                "side": props.get("side"),
                "operation": props.get("operation"),
                "location": f"{source}:{line}" if source else None,
            })
        elif kind == "context-bridge-api":
            bridges.append({"api": props.get("api_key") or label, "world": props.get("world"),
                            "location": f"{source}:{line}" if source else None})
        elif kind == "javascript-module":
            if props.get("semantic_role") == "source-module":
                modules.append({"path": props.get("path") or label, "format": props.get("module_format")})
            elif props.get("resolution_status") == "external":
                external.add(props.get("declared_specifier") or props.get("specifier") or label)
        if "native" in kind or (isinstance(label, str) and label.endswith(".node")):
            native.append({"kind": kind, "label": label, "location": f"{source}:{line}" if source else None})

    return {
        "evidence_id": evidence.get("evidence_id"),
        "application": application,
        "confidence": evidence.get("confidence"),
        "authority": evidence.get("authority"),
        "summary": nr.get("summary"),
        "statistics": nr.get("statistics"),
        "entrypoints": entrypoints,
        "modules": modules,
        "external_modules": sorted(x for x in external if x),
        "ipc_channels": ipc,
        "context_bridge_apis": bridges,
        "native_addons": native,
        "node_kinds": dict(kinds.most_common()),
        "nodes": compact[:2000],
        "coverage": (nr.get("graph") or {}).get("coverage"),
        "limitations": nr.get("limitations") or evidence.get("limitations") or [],
    }


# ---------------------------------------------------------------------------
# MCP bridge
# ---------------------------------------------------------------------------

class ReaMcpBridge:
    """Keeps one `rea --mcp` stdio session alive on a private event-loop thread.

    REA's Hopper/Ghidra/IDA bridges are stateful (open documents, sessions), so a
    persistent session matters; it also avoids ~2 s of startup per call.
    """

    def __init__(self, settings: Settings):
        self.settings = settings
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._session = None
        self._stack = None
        self._lock = threading.Lock()
        self._tools: Optional[list[dict[str, Any]]] = None
        self._call_lock: Optional[asyncio.Lock] = None

    # -- loop management ---------------------------------------------------
    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._loop is None:
                factory = asyncio.ProactorEventLoop if sys.platform == "win32" else asyncio.new_event_loop
                loop = factory()
                thread = threading.Thread(target=loop.run_forever, name="rea-mcp", daemon=True)
                thread.start()
                self._loop, self._thread = loop, thread
            return self._loop

    def _submit(self, coro, timeout: float) -> Any:
        fut: Future = asyncio.run_coroutine_threadsafe(coro, self._ensure_loop())
        try:
            return fut.result(timeout=timeout)
        except TimeoutError as exc:
            fut.cancel()
            raise ReaError(f"REA MCP call timed out after {timeout:.0f}s", 504) from exc

    async def _connect(self):
        from contextlib import AsyncExitStack

        from mcp.client.session import ClientSession
        from mcp.client.stdio import StdioServerParameters, stdio_client

        if self._session is not None:
            return self._session
        command, *args = self.settings.rea_command
        params = StdioServerParameters(
            command=command, args=[*args, "--mcp"], env=_rea_env(), cwd=str(self.settings.rea_workspace_root)
        )
        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(stdio_client(params, errlog=_DevNull()))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except BaseException:
            await stack.aclose()
            raise
        self._session, self._stack = session, stack
        self._call_lock = asyncio.Lock()
        return session

    async def _reset(self):
        stack, self._session, self._stack, self._tools = self._stack, None, None, None
        if stack is not None:
            try:
                await stack.aclose()
            except BaseException:  # noqa: BLE001
                pass

    # -- public API ----------------------------------------------------------
    def list_tools(self) -> list[dict[str, Any]]:
        if self._tools is None:
            self._tools = self._submit(self._list_tools(), timeout=120)
        return self._tools

    async def _list_tools(self) -> list[dict[str, Any]]:
        try:
            session = await self._connect()
            tools, cursor = [], None
            while True:
                from mcp import types

                page = await session.list_tools(params=types.PaginatedRequestParams(cursor=cursor) if cursor else None)
                tools.extend(page.tools)
                cursor = getattr(page, "next_cursor", None)
                if not cursor:
                    break
        except ReaError:
            raise
        except Exception as exc:  # noqa: BLE001
            await self._reset()
            raise ReaError(f"cannot start REA MCP server: {type(exc).__name__}: {exc}", 503) from exc
        out = []
        for tool in tools:
            ann = tool.annotations
            destructive = bool(ann and ann.destructive_hint)
            out.append({
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": tool.input_schema,
                "read_only": bool(ann and ann.read_only_hint),
                "destructive": destructive,
                "open_world": bool(ann and ann.open_world_hint),
                "allowed": self.settings.rea_allow_destructive or not destructive,
            })
        return out

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        tool = next((t for t in self.list_tools() if t["name"] == name), None)
        if tool is None:
            raise ReaError(f"unknown REA tool {name!r}", 404)
        if not tool["allowed"]:
            raise ReaError(
                f"REA tool {name!r} is annotated destructive (it can modify state or run code); "
                "set REA_ALLOW_DESTRUCTIVE=1 to enable it",
                403,
            )
        args = confine_arguments(self.settings, tool["input_schema"], arguments)
        timeout = self.settings.rea_tool_timeout_seconds
        return self._submit(self._call(name, args, timeout), timeout=timeout + 15)

    async def _call(self, name: str, args: dict[str, Any], timeout: float) -> dict[str, Any]:
        started = time.monotonic()
        try:
            session = await self._connect()
            async with self._call_lock:
                result = await session.call_tool(name, args, read_timeout_seconds=timeout)
        except Exception as exc:  # noqa: BLE001
            await self._reset()
            raise ReaError(f"REA tool call failed: {type(exc).__name__}: {exc}") from exc
        content = []
        for block in getattr(result, "content", None) or []:
            if getattr(block, "type", None) == "text":
                text = block.text
                try:
                    content.append({"type": "json", "value": json.loads(text)})
                except ValueError:
                    content.append({"type": "text", "value": text})
            else:
                content.append({"type": getattr(block, "type", "unknown"), "value": None})
        return {
            "tool": name,
            "is_error": bool(getattr(result, "is_error", False)),
            "structured": getattr(result, "structured_content", None),
            "content": content,
            "duration_ms": round((time.monotonic() - started) * 1000, 1),
        }

    def close(self) -> None:
        if self._loop is None:
            return
        try:
            self._submit(self._reset(), timeout=10)
        except Exception:  # noqa: BLE001
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)


_ERRLOG = None


def _DevNull():
    """errlog sink: REA writes progress JSON to stderr, which we do not need."""
    global _ERRLOG
    if _ERRLOG is None:
        _ERRLOG = open(os.devnull, "w")  # noqa: SIM115 - lives for the process
    return _ERRLOG


class ReaService:
    def __init__(self, settings: Settings):
        self.settings = settings
        try:
            settings.rea_workspace_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:  # REA is optional: never stop the app from starting
            log.warning("REA workspace %s unavailable: %s", settings.rea_workspace_root, exc)
        self.mcp = ReaMcpBridge(settings)
        self._doctor: Optional[tuple[float, dict[str, Any]]] = None

    def status(self, refresh: bool = False) -> dict[str, Any]:
        if refresh or self._doctor is None or time.time() - self._doctor[0] > DOCTOR_CACHE_SECONDS:
            report = run_cli(self.settings, ["doctor"], timeout=180)
            self._doctor = (time.time(), report)
        report = self._doctor[1]
        checks = report.get("scope_checks") or report.get("checks") or []
        return {
            "command": self.settings.rea_command,
            "workspace_root": str(self.settings.rea_workspace_root),
            "allow_any_path": self.settings.rea_allow_any_path,
            "allow_destructive": self.settings.rea_allow_destructive,
            "healthy": report.get("healthy"),
            "checks": [
                {"name": c.get("name"), "ok": c.get("ok"), "classification": c.get("classification"),
                 "detail": c.get("detail"), "remediation": c.get("remediation")}
                for c in checks
            ],
        }

    def analyze_javascript(self, path: str, artifact_format: str = "auto") -> dict[str, Any]:
        target = confine_path(self.settings, path)
        if not Path(target).exists():
            raise ReaError(f"path not found: {target}", 404)
        evidence = run_cli(
            self.settings,
            ["analyze-javascript-application", target, "--artifact-format", artifact_format],
            timeout=self.settings.rea_tool_timeout_seconds,
        )
        return {"projection": project_javascript_analysis(evidence), "evidence": evidence}

    def workspace_listing(self, limit: int = 500) -> list[dict[str, Any]]:
        root = self.settings.rea_workspace_root
        entries = []
        for path in sorted(root.rglob("*")):
            rel = path.relative_to(root)
            if len(rel.parts) > 3 or any(p in ("node_modules", ".git") for p in rel.parts):
                continue
            entries.append({"path": rel.as_posix(), "is_dir": path.is_dir(),
                            "size": path.stat().st_size if path.is_file() else None})
            if len(entries) >= limit:
                break
        return entries
