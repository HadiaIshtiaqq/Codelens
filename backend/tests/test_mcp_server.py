"""FR-08: the CodeLens MCP server end-to-end, over an in-memory MCP transport."""

import asyncio
import json

import httpx
import pytest

from app import mcp_server


class _SyncASGIBridge(httpx.AsyncBaseTransport):
    """Forward the MCP server's API calls to the FastAPI TestClient (which owns the app lifespan)."""

    def __init__(self, client):
        self._client = client

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        resp = await asyncio.to_thread(
            self._client.request, request.method, request.url.raw_path.decode(),
            content=request.content, headers={"content-type": request.headers.get("content-type", "")},
        )
        return httpx.Response(resp.status_code, content=resp.content, headers={"content-type": "application/json"})


@pytest.fixture
def mcp_bridge(client, monkeypatch):
    monkeypatch.setattr(mcp_server, "_transport", _SyncASGIBridge(client))


def _payload(result):
    assert not result.is_error, result
    if getattr(result, "structured_content", None):
        sc = result.structured_content
        return sc.get("result", sc) if isinstance(sc, dict) else sc
    return json.loads(result.content[0].text)


def test_mcp_debug_workflow(mcp_bridge):
    from mcp.client.client import Client

    async def flow():
        async with Client(mcp_server.mcp) as c:
            names = {t.name for t in (await c.list_tools()).tools}
            assert {"run_python", "get_step_state", "explain_execution", "propose_patch", "validate_patch",
                    "rea_analyze_javascript_application", "rea_call_tool"} <= names

            run = _payload(await c.call_tool("run_python", {"source_code": "def f(a, b):\n    return a / b\nf(1, 0)\n"}))
            assert run["error"]["type"] == "ZeroDivisionError"
            exec_id = run["execution_id"]

            # Step 5 is the exception inside f: stack is <module> -> f, with f's locals.
            state = _payload(await c.call_tool("get_step_state", {"execution_id": exec_id, "step": 5}))
            assert [f["function"] for f in state["call_stack"]] == ["<module>", "f"]
            assert state["event"]["locals"] == {"a": "1", "b": "0"}
            assert state["event"]["local_types"] == {"a": "int", "b": "int"}

            exp = _payload(await c.call_tool("explain_execution", {"execution_id": exec_id}))
            assert "Variable 'b' was 0" in exp["observed_facts"]

            patch = _payload(await c.call_tool("propose_patch", {"execution_id": exec_id}))
            tests = "from main import f\n\ndef test_zero():\n    assert f(1, 0) is None\n"
            val = _payload(await c.call_tool("validate_patch", {"patch_id": patch["patch_id"], "tests": tests}))
            assert val["status"] == "validated"

            missing = await c.call_tool("get_trace", {"execution_id": "exec_missing"})
            assert missing.is_error

    asyncio.run(flow())


def test_mcp_conversational_tools(mcp_bridge):
    from mcp.client.client import Client

    src = "def avg(xs):\n    total = 0\n    for x in xs:\n        total += x\n    return total / len(xs)\n\nprint(avg([]))\n"

    async def flow():
        async with Client(mcp_server.mcp) as c:
            names = {t.name for t in (await c.list_tools()).tools}
            assert {"explain_code", "get_execution_state", "get_variable_state", "get_debugging_summary",
                    "propose_fix", "validate_fix"} <= names

            exp = _payload(await c.call_tool("explain_code", {"source_code": src}))
            assert "ZeroDivisionError on line 5" in exp["speech"]
            exec_id = exp["execution_id"]

            state = _payload(await c.call_tool("get_execution_state", {"execution_id": exec_id}))
            assert "line 5" in state["speech"] and "avg" in state["speech"]

            var = _payload(await c.call_tool("get_variable_state", {"execution_id": exec_id, "name": "total"}))
            assert var["found"] and "total is 0" in var["speech"]
            missing = _payload(await c.call_tool("get_variable_state", {"execution_id": exec_id, "name": "nope"}))
            assert missing["found"] is False

            summary = _payload(await c.call_tool("get_debugging_summary", {"execution_id": exec_id}))
            assert summary["speech"].startswith("The program crashed")

            fix = _payload(await c.call_tool("propose_fix", {"execution_id": exec_id}))
            assert "Say validate" in fix["speech"]
            tests = "from main import avg\n\ndef test_empty():\n    assert avg([]) is None\n\ndef test_avg():\n    assert avg([2, 4]) == 3\n"
            val = _payload(await c.call_tool("validate_fix", {"patch_id": fix["patch_id"], "tests": tests}))
            assert val["status"] == "validated" and "all 2 tests passed" in val["speech"]

    asyncio.run(flow())


def test_http_transport_requires_token():
    from starlette.testclient import TestClient as StarletteClient

    app = mcp_server.http_app("s3cret", public_hosts=["testserver"])
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
    with StarletteClient(app) as c:
        assert c.post("/mcp", json=init, headers=headers).status_code == 401
        assert c.post("/mcp", json=init, headers={**headers, "authorization": "Bearer wrong"}).status_code == 401
        ok = c.post("/mcp", json=init, headers={**headers, "authorization": "Bearer s3cret"})
        assert ok.status_code == 200, ok.text
        assert "codelens" in ok.text


def test_http_transport_rejects_unlisted_host():
    from starlette.testclient import TestClient as StarletteClient

    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}
    headers = {"accept": "application/json, text/event-stream", "authorization": "Bearer s3cret"}
    with StarletteClient(mcp_server.http_app("s3cret")) as c:  # "testserver" not listed
        assert c.post("/mcp", json=init, headers=headers).status_code == 421
