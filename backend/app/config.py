import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import shlex
import shutil

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
WORKER_SCRIPT = BACKEND_DIR / "worker" / "tracer.py"
try:  # .env is optional; real environment variables take precedence
    from dotenv import load_dotenv

    load_dotenv(BACKEND_DIR / ".env", override=False)
except ImportError:
    pass

LOCAL_REA_SCRIPT =PROJECT_DIR / "rea" / "node_modules" / "rea-agents" / "scripts" / "rea.mjs"
REA_VERSION = "6.7.0"


def _env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


def _rea_command() -> list[str]:
    if override := os.getenv("REA_COMMAND"):
        return shlex.split(override, posix=os.name == "posix")
    if LOCAL_REA_SCRIPT.exists():
        return ["node", str(LOCAL_REA_SCRIPT)]
    npx = shutil.which("npx") or "npx"
    return [npx, "-y", f"rea-agents@{REA_VERSION}"]


@dataclass(frozen=True)
class Settings:
    # "docker" (production, spec §3.4) or "subprocess" (local dev only: an isolated
    # child process with no container boundary).
    sandbox_backend: str = field(default_factory=lambda: os.getenv("CODELENS_SANDBOX", "docker"))
    docker_image: str = field(default_factory=lambda: os.getenv("CODELENS_WORKER_IMAGE", "codelens-worker:latest"))
    docker_memory: str = field(default_factory=lambda: os.getenv("CODELENS_WORKER_MEMORY", "256m"))
    docker_cpus: str = field(default_factory=lambda: os.getenv("CODELENS_WORKER_CPUS", "0.5"))
    docker_pids_limit: int = field(default_factory=lambda: int(os.getenv("CODELENS_WORKER_PIDS", "64")))
    subprocess_memory_bytes: int = 256 * 1024 * 1024
    # Containers started ahead of time so runs skip Docker's startup delay (0 disables).
    docker_pool_size: int = field(default_factory=lambda: int(os.getenv("CODELENS_DOCKER_POOL", "2")))

    max_source_bytes: int = 100 * 1024
    max_timeout_seconds: float = 5.0
    max_trace_events: int = 1000
    # Long runs keep recording into a ring buffer (first 30% + most recent 70% of the cap)
    # until this many events, then stop tracing while the program keeps running.
    trace_budget: int = field(default_factory=lambda: int(os.getenv("CODELENS_TRACE_BUDGET", "20000")))
    # Extra time the parent watchdog allows for interpreter/container startup before
    # it SIGKILLs the sandbox. The worker enforces the user-code deadline itself.
    hard_kill_grace_seconds: float = field(
        # Docker Desktop can take several seconds to start a container (especially the first one).
        default_factory=lambda: float(os.getenv(
            "CODELENS_KILL_GRACE_SECONDS", "10.0" if os.getenv("CODELENS_SANDBOX", "docker") == "docker" else "2.0"
        ))
    )
    max_worker_result_bytes: int = 48 * 1024 * 1024
    max_concurrent_executions: int = field(
        default_factory=lambda: int(os.getenv("CODELENS_MAX_CONCURRENT", "4"))
    )
    store_max_entries: int = 500
    # SQLite file for executions/explanations/patches; empty = memory only.
    db_path: str = field(default_factory=lambda: os.getenv("CODELENS_DB_PATH", str(BACKEND_DIR / "data" / "codelens.db")))
    # Saved runs, explanations and patches older than this are deleted (0 = keep until pruned by count).
    retention_hours: float = field(default_factory=lambda: float(os.getenv("CODELENS_RETENTION_HOURS", "72")))
    # Hosted deployments: require this code on every API call (empty = open, for local use).
    access_code: str = field(default_factory=lambda: os.getenv("CODELENS_ACCESS_CODE", ""))
    # Public host names the /mcp endpoint answers to (DNS-rebinding protection), e.g. "codelens.example.com".
    mcp_public_hosts: str = field(default_factory=lambda: os.getenv("CODELENS_MCP_PUBLIC_HOSTS", ""))
    # Requests per minute per client IP on run/AI endpoints; 0 disables.
    rate_limit_per_minute: int = field(default_factory=lambda: int(os.getenv("CODELENS_RATE_LIMIT_PER_MIN", "60")))

    # ---- AI orchestration (spec §2.3.2) ---------------------------------------
    # "auto" picks Nebius when NEBIUS_API_KEY is set, else Ollama when OLLAMA_MODEL is
    # set, else the deterministic offline engine.
    llm_provider: str = field(default_factory=lambda: os.getenv("CODELENS_LLM_PROVIDER", "auto"))
    nebius_api_key: str = field(default_factory=lambda: os.getenv("NEBIUS_API_KEY", ""))
    nebius_base_url: str = field(
        default_factory=lambda: os.getenv("NEBIUS_BASE_URL", "https://api.tokenfactory.nebius.com/v1")
    )
    nebius_model: str = field(
        # Empty = auto-select a Nemotron model from the live /models catalogue.
        default_factory=lambda: os.getenv("NEBIUS_MODEL", "")
    )
    # Google Gemini through its OpenAI-compatible endpoint (free tier keys from aistudio.google.com).
    gemini_api_key: str = field(default_factory=lambda: os.getenv("GEMINI_API_KEY", ""))
    gemini_base_url: str = field(
        default_factory=lambda: os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
    )
    gemini_model: str = field(default_factory=lambda: os.getenv("GEMINI_MODEL", ""))  # empty: pick a Flash model
    ollama_base_url: str = field(default_factory=lambda: os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"))
    ollama_model: str = field(default_factory=lambda: os.getenv("OLLAMA_MODEL", ""))
    # Hackathon/production: never silently fall back to offline rules when the provider fails.
    require_llm_provider: bool = field(default_factory=lambda: os.getenv("CODELENS_REQUIRE_PROVIDER", "") == "1")
    llm_timeout_seconds: float = field(default_factory=lambda: float(os.getenv("CODELENS_LLM_TIMEOUT", "90")))

    # ---- Patch validation ---------------------------------------------------
    validation_timeout_seconds: float = 5.0

    # ---- REA reverse-engineering subsystem (spec §2.3, FR-02) ---------------
    # Command that launches the rea CLI; the MCP server is started with `--mcp`.
    rea_command: list[str] = field(default_factory=lambda: _rea_command())
    # REA reads host files, so path arguments are confined to this directory.
    rea_workspace_root: Path = field(
        default_factory=lambda: Path(os.getenv("REA_WORKSPACE_ROOT", str(PROJECT_DIR / "rea-workspace"))).resolve()
    )
    rea_allow_any_path: bool = field(default_factory=lambda: os.getenv("REA_ALLOW_ANY_PATH", "") == "1")
    # Tools annotated destructive (debuggers, Frida, write-back, device mutation) are
    # refused unless explicitly enabled.
    rea_allow_destructive: bool = field(default_factory=lambda: os.getenv("REA_ALLOW_DESTRUCTIVE", "") == "1")
    rea_tool_timeout_seconds: float = field(default_factory=lambda: float(os.getenv("REA_TOOL_TIMEOUT", "300")))

    # The Reverse Engineering tab is hidden by default (the REA backend and MCP tools stay available).
    show_rea_ui: bool = field(default_factory=lambda: os.getenv("CODELENS_SHOW_REA", "") == "1")

    cors_origins: list[str] = field(
        default_factory=lambda: _env_list(
            "CODELENS_CORS_ORIGINS", "http://localhost:5173,http://localhost:3000"
        )
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
