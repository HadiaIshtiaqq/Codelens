import os
import sys
import tempfile
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "worker"))

# Tests run without Docker and without a real LLM unless explicitly requested.
os.environ.setdefault("CODELENS_SANDBOX", "subprocess")
os.environ.setdefault("CODELENS_LLM_PROVIDER", "offline")
os.environ["REA_WORKSPACE_ROOT"] = tempfile.mkdtemp(prefix="codelens-rea-test-")
os.environ.pop("REA_ALLOW_ANY_PATH", None)
os.environ["CODELENS_DB_PATH"] = os.path.join(tempfile.mkdtemp(prefix="codelens-db-"), "test.db")
os.environ["CODELENS_RATE_LIMIT_PER_MIN"] = "0"  # rate limiting has its own tests
os.environ.pop("REA_ALLOW_DESTRUCTIVE", None)


@pytest.fixture(scope="session")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def run(client):
    def _run(source: str, **extra):
        resp = client.post("/api/v1/executions", json={"source_code": source, **extra})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        trace = client.get(f"/api/v1/executions/{body['execution_id']}/trace", params={"limit": 500})
        events = trace.json()["events"]
        start = 500
        while trace.json()["next_start"] is not None:
            trace = client.get(
                f"/api/v1/executions/{body['execution_id']}/trace", params={"start": start, "limit": 500}
            )
            events += trace.json()["events"]
            start += 500
        return body, events

    return _run
