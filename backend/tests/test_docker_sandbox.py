"""Spec §5.3 adversarial security matrix against the real Docker sandbox.

Skipped automatically when Docker or the codelens-worker image is unavailable.
"""

import dataclasses
import shutil
import subprocess
import time
import uuid

import pytest

from app.config import get_settings
from app.services.sandbox import DockerSandboxRunner


def _docker_ready() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return subprocess.run(["docker", "image", "inspect", "codelens-worker:latest"],
                              capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


pytestmark = pytest.mark.skipif(not _docker_ready(), reason="Docker daemon or codelens-worker image not available")


@pytest.fixture(scope="module")
def docker():
    settings = dataclasses.replace(get_settings(), sandbox_backend="docker", hard_kill_grace_seconds=10.0,
                                   docker_pool_size=2)
    runner = DockerSandboxRunner(settings)

    def run(source, timeout=5.0, **kwargs):
        return runner.run(f"t{uuid.uuid4().hex[:8]}", source, timeout=timeout, max_events=200, **kwargs)

    run.runner = runner
    yield run
    runner.close()


def test_traces_normally(docker):
    r = docker("def f(a, b):\n    return a / b\nprint(f(1, 0))\n")
    assert r.status == "completed" and r.error["type"] == "ZeroDivisionError" and r.error["line"] == 2
    assert any(e["event"] == "exception" for e in r.events)


def test_sec01_infinite_loop_times_out(docker):
    started = time.monotonic()
    r = docker("while True:\n    pass\n", timeout=2.0)
    assert r.status == "timed_out"
    assert time.monotonic() - started < 15


def test_sec02_unprivileged_user_and_no_capabilities(docker):
    r = docker(
        "import os\n"
        "print(os.getuid(), os.getgid())\n"
        "caps = [l for l in open('/proc/self/status') if l.startswith('CapEff')][0].split()[1]\n"
        "print(caps)\n"
    )
    uid_line, caps = r.stdout.split("\n")[:2]
    assert uid_line == "10001 10001"
    assert int(caps, 16) == 0  # every Linux capability dropped


def test_sec03_read_only_filesystem(docker):
    r = docker(
        "for path in ['/etc/passwd', '/opt/codelens/tracer.py', '/usr/x']:\n"
        "    try:\n"
        "        open(path, 'a').write('x')\n"
        "        print('WROTE', path)\n"
        "    except OSError as e:\n"
        "        print('blocked', type(e).__name__)\n"
        "open('/tmp/ok.txt', 'w').write('scratch is fine')\n"
        "print(open('/tmp/ok.txt').read())\n"
    )
    assert "WROTE" not in r.stdout
    assert r.stdout.count("blocked") == 3
    assert "scratch is fine" in r.stdout


def test_sec04_no_network(docker):
    r = docker(
        "import socket\n"
        "try:\n"
        "    socket.create_connection(('1.1.1.1', 80), timeout=2)\n"
        "    print('CONNECTED')\n"
        "except OSError as e:\n"
        "    print('no network', type(e).__name__)\n"
    )
    assert "CONNECTED" not in r.stdout and "no network" in r.stdout


def test_sec05_memory_limit(docker):
    r = docker("blob = 'a' * (10 ** 9)\nprint(len(blob))\n")
    assert "1000000000" not in r.stdout
    oom_killed = r.status == "failed" and "memory" in r.error["message"].lower()
    memory_error = r.error is not None and r.error["type"] == "MemoryError"
    assert oom_killed or memory_error, r


def test_host_secrets_not_in_container(docker, monkeypatch):
    monkeypatch.setenv("NEBIUS_API_KEY", "must-not-leak")
    # (GPG_KEY is the python base image's public release-signing fingerprint, not a secret.)
    r = docker("import os\nprint(sorted(k for k in os.environ if 'NEBIUS' in k or 'TOKEN' in k or 'SECRET' in k))\n")
    assert r.stdout.strip() == "[]"


def test_warm_pool_makes_runs_fast(docker):
    docker("x = 1\n")  # make sure the pool has been used and refilled
    time.sleep(4)  # let the pool start replacement containers
    started = time.monotonic()
    r = docker("print('hi')\n")
    assert r.stdout == "hi\n"
    # No container start-up on the request path (a cold start takes several seconds on Docker Desktop);
    # the margin allows for busy CI machines.
    assert time.monotonic() - started < 3.0


def test_numpy_and_input_and_files_in_container(docker):
    r = docker(
        "import numpy as np\n"
        "from shapes import square\n"
        "n = int(input('n? '))\n"
        "arr = np.arange(n)\n"
        "print(square(arr).sum())\n",
        stdin="4\n",
        files={"shapes.py": "def square(x):\n    return x * x\n"},
    )
    assert r.error is None, r.error
    assert r.stdout.endswith("14\n")
    assert any("array(" in str(e.get("locals", {}).get("arr", "")) for e in r.events)


def test_pytest_runs_in_container():
    settings = dataclasses.replace(get_settings(), sandbox_backend="docker", hard_kill_grace_seconds=10.0,
                                   docker_pool_size=0)
    runner = DockerSandboxRunner(settings)
    tests = (
        "import pytest\n"
        "from main import f\n\n"
        "@pytest.mark.parametrize('x', [1, 2])\n"
        "def test_f(x):\n"
        "    assert f(x) == x * 2\n"
    )
    r = runner.run_tests("pt", "def f(x):\n    return x * 2\n", tests, timeout=5.0)
    assert r.runner == "pytest", r
    assert [t["outcome"] for t in r.tests] == ["passed", "passed"]
