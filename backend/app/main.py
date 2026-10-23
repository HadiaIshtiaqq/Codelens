import asyncio
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from app import mcp_server
from app.config import PROJECT_DIR, get_settings
from app.routers import analysis, executions, explain, rea
from app.services.access import AccessCodeMiddleware, parse_codes
from app.services.llm import select_provider
from app.services.ratelimit import RateLimiter, RateLimitMiddleware
from app.services.rea import ReaService
from app.services.sandbox import build_runner
from app.services.store import Stores

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("codelens")
FRONTEND_DIST = PROJECT_DIR / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.runner = build_runner(settings)
    app.state.stores = Stores(settings.store_max_entries, settings.db_path)
    app.state.rate_limiter = RateLimiter(settings.rate_limit_per_minute)
    app.state.execution_slots = asyncio.Semaphore(settings.max_concurrent_executions)
    app.state.llm_provider = select_provider(settings)
    app.state.rea = ReaService(settings)
    if settings.sandbox_backend == "docker" and settings.docker_pool_size <= 0:
        # No container pool: start one throwaway container now so the first run isn't a cold start.
        asyncio.get_running_loop().run_in_executor(
            None, lambda: app.state.runner.run("warmup", "pass\n", timeout=2.0, max_events=1)
        )
    purge_task = asyncio.create_task(_purge_loop(app, settings.retention_hours))
    log.info(
        "sandbox=%s llm=%s%s access_code=%s rea=%s",
        settings.sandbox_backend,
        app.state.llm_provider.name,
        f" ({app.state.llm_provider.model})" if app.state.llm_provider.model else "",
        "on" if settings.access_code else "off",
        " ".join(settings.rea_command),
    )
    # The MCP endpoint's tools call this same app in-process, with an access code when one is required.
    codes = parse_codes(settings.access_code)
    mcp_server.ACCESS_CODE = next(iter(codes.values()), "")
    _mcp_endpoint.rebuild(settings)
    async with mcp_server.mcp.session_manager.run():
        yield
    purge_task.cancel()
    app.state.runner.close()
    app.state.rea.mcp.close()
    app.state.stores.close()


async def _purge_loop(app: FastAPI, retention_hours: float) -> None:
    """Delete stored runs older than the retention window, at startup and then hourly."""
    if retention_hours <= 0:
        return
    while True:
        removed = await asyncio.to_thread(app.state.stores.purge, retention_hours * 3600)
        if removed:
            log.info("retention: removed %d stored records older than %.0f h", removed, retention_hours)
        await asyncio.sleep(3600)


app = FastAPI(
    title="CodeLens AI + REA",
    version="1.0.0",
    description="Evidence-grounded Python tracing, AI debugging and REA reverse engineering",
    lifespan=lifespan,
)

# Order matters: the last one added runs first (CORS, then compression, access code, rate limit).
app.add_middleware(RateLimitMiddleware)
app.add_middleware(AccessCodeMiddleware, code_getter=lambda: get_settings().access_code)
app.add_middleware(GZipMiddleware, minimum_size=1024)  # the editor bundle shrinks ~4x
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-CodeLens-Access"],
)

class _McpExactPath:
    """Agents are configured with ".../mcp"; the mounted MCP app lives at "/mcp/" (no redirect for POSTs)."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] == "/mcp":
            scope = {**scope, "path": "/mcp/", "raw_path": b"/mcp/"}
        await self.inner(scope, receive, send)


app.add_middleware(_McpExactPath)

app.include_router(executions.router)
app.include_router(analysis.router)
app.include_router(explain.router)
app.include_router(rea.router)


# MCP over Streamable HTTP at /mcp: for Alexa+ and other agents, and for the in-app Alexa+ simulator.
# It is guarded like the REST API (access code, rate limits) and its tools call the API in-process.
class _McpEndpoint:
    """The mounted MCP app, rebuilt at every startup (its session manager can only run once)."""

    def __init__(self):
        self.inner = None

    def rebuild(self, settings) -> None:
        public = [h.strip() for h in settings.mcp_public_hosts.split(",") if h.strip()]
        self.inner = mcp_server.http_app(None, public_hosts=public, path="/", local_browsers=True)

    async def __call__(self, scope, receive, send):
        if self.inner is None:
            await Response("MCP endpoint is starting", status_code=503)(scope, receive, send)
            return
        await self.inner(scope, receive, send)


mcp_server._transport = httpx.ASGITransport(app=app)
mcp_server.API_URL = "http://codelens.internal"
_mcp_endpoint = _McpEndpoint()
app.mount("/mcp", _mcp_endpoint)


@app.get("/health")
async def health() -> dict[str, object]:
    settings = get_settings()
    provider = app.state.llm_provider
    return {
        "status": "ok",
        "sandbox": settings.sandbox_backend,
        "llm_provider": provider.name,
        "llm_model": provider.model or "",
        "features": {
            "rea_ui": settings.show_rea_ui,
            "access_code_required": bool(settings.access_code),
        },
    }


class _CachedStatic(StaticFiles):
    """Hashed build assets are cached for a year; index.html is always revalidated."""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if path.replace("\\", "/").startswith("assets/"):  # Starlette uses OS separators
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


# Serve the built React workspace (frontend/dist) from the same origin in production.
# Registered last so every API route above takes precedence.
if FRONTEND_DIST.is_dir():
    app.mount("/", _CachedStatic(directory=FRONTEND_DIST, html=True), name="frontend")
