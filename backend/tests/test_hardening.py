"""Access code, compression/caching, retention, and the dev sandbox memory cap."""

import dataclasses
import sys
import time

import pytest

from app.config import get_settings
from app.services.sandbox import SubprocessSandboxRunner
from app.services.store import ExecutionRecord, Stores
from app.services.sandbox import SandboxResult


def test_access_code_guards_the_api(client, monkeypatch):
    import app.main as main

    locked = dataclasses.replace(get_settings(), access_code="let-me-in")
    monkeypatch.setattr(main, "get_settings", lambda: locked)
    body = {"source_code": "x = 1\n"}
    assert client.post("/api/v1/executions", json=body).status_code == 401
    assert client.post("/api/v1/executions", json=body, headers={"X-CodeLens-Access": "wrong"}).status_code == 401
    assert client.post("/api/v1/executions", json=body, headers={"X-CodeLens-Access": "let-me-in"}).status_code == 200
    health = client.get("/health").json()  # stays public so the UI can ask for the code
    assert health["features"]["access_code_required"] is True


def test_static_assets_are_compressed_and_cached(client):
    from app.main import FRONTEND_DIST

    if not (FRONTEND_DIST / "index.html").exists():
        pytest.skip("frontend not built")
    index = client.get("/", headers={"Accept-Encoding": "gzip"})
    assert index.headers["cache-control"] == "no-cache"
    asset = next((FRONTEND_DIST / "assets").glob("index-*.js"))
    resp = client.get(f"/assets/{asset.name}", headers={"Accept-Encoding": "gzip"})
    assert resp.headers["content-encoding"] == "gzip"
    assert "immutable" in resp.headers["cache-control"]
    assert int(resp.headers.get("content-length", 0) or 0) < asset.stat().st_size / 2


def test_retention_purges_old_records(tmp_path):
    stores = Stores(10, str(tmp_path / "r.db"))
    stores.executions.put("old", ExecutionRecord(source="x", result=SandboxResult(status="completed", exit_code=0)))
    time.sleep(0.05)
    assert stores.purge(retention_seconds=0.01) == 1
    assert stores.executions.get("old") is None


def test_dev_sandbox_caps_memory():
    runner = SubprocessSandboxRunner(get_settings())
    result = runner.run("mem", "blob = 'a' * (10 ** 9)\nprint(len(blob))\n", timeout=5, max_events=5)
    assert "1000000000" not in result.stdout
    assert result.error and result.error["type"] in ("MemoryError", "SandboxError"), result.error


def test_multiple_access_codes(client, monkeypatch):
    import app.main as main
    from app.services.access import parse_codes

    assert parse_codes("judges:abc, team:xyz") == {"judges": "abc", "team": "xyz"}
    assert parse_codes("solo") == {"default": "solo"}
    locked = dataclasses.replace(get_settings(), access_code="judges:abc, team:xyz")
    monkeypatch.setattr(main, "get_settings", lambda: locked)
    body = {"source_code": "x = 1\n"}
    for code, status in (("abc", 200), ("xyz", 200), ("judges:abc", 401), ("nope", 401)):
        assert client.post("/api/v1/executions", json=body, headers={"X-CodeLens-Access": code}).status_code == status


def test_mcp_accepts_the_access_code_as_a_bearer_token(client, monkeypatch):
    """Alexa+ and other MCP clients authenticate with `Authorization: Bearer <code>`."""
    import app.main as main

    locked = dataclasses.replace(get_settings(), access_code="judges:let-me-in")
    monkeypatch.setattr(main, "get_settings", lambda: locked)
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    headers = {"Accept": "application/json, text/event-stream", "Host": "127.0.0.1:8000"}
    refused = client.post("/mcp", json=init, headers=headers)
    assert refused.status_code == 401 and refused.headers["www-authenticate"] == "Bearer"
    assert client.post("/mcp", json=init, headers={**headers, "Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/mcp", json=init, headers={**headers, "Authorization": "Bearer let-me-in"}).status_code == 200
