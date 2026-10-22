"""SQLite persistence and rate limiting."""

from app.services.ratelimit import RateLimiter
from app.services.sandbox import SandboxResult
from app.services.store import ExecutionRecord, PatchRecord, Stores


def test_records_survive_restart(tmp_path):
    db = str(tmp_path / "c.db")
    s1 = Stores(10, db)
    result = SandboxResult(status="completed", exit_code=0, stdout="hi\n", events=[{"step": 0, "event": "exit"}])
    s1.executions.put("e1", ExecutionRecord(source="print('hi')\n", result=result))
    s1.patches.put("p1", PatchRecord("p1", "e1", "a\n", "b\n", "diff", "why", "offline"))
    s1.close()

    s2 = Stores(10, db)  # fresh process: empty cache, same file
    rec = s2.executions.get("e1")
    assert rec.source == "print('hi')\n" and rec.result.stdout == "hi\n" and rec.result.events[0]["event"] == "exit"
    patch = s2.patches.get("p1")
    patch.status = "validated"
    s2.patches.put("p1", patch)
    s2.close()
    assert Stores(10, db).patches.get("p1").status == "validated"


def test_old_rows_are_pruned(tmp_path):
    s = Stores(3, str(tmp_path / "c.db"))
    for i in range(6):
        s.patches.put(f"p{i}", PatchRecord(f"p{i}", "e", "", "", "", "", ""))
    fresh = Stores(3, str(tmp_path / "c.db"))
    assert fresh.patches.get("p0") is None and fresh.patches.get("p5") is not None


def test_memory_only_mode():
    s = Stores(5, "")
    s.patches.put("x", PatchRecord("x", "e", "", "", "", "", ""))
    assert s.patches.get("x") is not None


def test_execution_persists_through_api(client):
    from app.main import app

    exec_id = client.post("/api/v1/executions", json={"source_code": "x = 1\n"}).json()["execution_id"]
    app.state.stores.executions._items.clear()  # drop the cache: must come back from SQLite
    assert client.get(f"/api/v1/executions/{exec_id}/trace").status_code == 200


def test_token_bucket():
    rl = RateLimiter(per_minute=2)
    assert rl.check("a", now=0) == 0 and rl.check("a", now=0) == 0
    assert rl.check("a", now=0) > 0          # burst exhausted
    assert rl.check("b", now=0) == 0          # other clients unaffected
    assert rl.check("a", now=31) == 0         # refilled after half a minute
    assert RateLimiter(0).check("a") == 0     # disabled


def test_rate_limit_returns_429(client):
    from app.main import app

    saved = app.state.rate_limiter
    app.state.rate_limiter = RateLimiter(per_minute=1)
    try:
        assert client.post("/api/v1/executions", json={"source_code": "x = 1\n"}).status_code == 200
        resp = client.post("/api/v1/executions", json={"source_code": "x = 1\n"})
        assert resp.status_code == 429 and int(resp.headers["retry-after"]) >= 1
        assert client.get("/health").status_code == 200  # reads are never limited
    finally:
        app.state.rate_limiter = saved
