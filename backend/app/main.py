import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from app.config import PROJECT_DIR, get_settings
from app.routers import analysis, convert, executions, explain, rea
from app.services.access import AccessCodeMiddleware
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

app.include_router(executions.router)
app.include_router(analysis.router)
app.include_router(convert.router)
app.include_router(explain.router)
app.include_router(rea.router)


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
            "convert": provider.name != "offline",
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
