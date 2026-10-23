"""The MCP server mounted in the API at /mcp (Streamable HTTP), as Alexa+ and the in-app simulator use it."""

import json

from fastapi.testclient import TestClient

from app.main import app

HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json", "Host": "127.0.0.1:8000"}


def _message(resp):
    if resp.headers.get("content-type", "").startswith("text/event-stream"):
        return next(json.loads(line[5:]) for line in resp.text.splitlines() if line.startswith("data:"))
    return resp.json()


def _session(client):
    resp = client.post("/mcp", headers=HEADERS, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}},
    })
    assert resp.status_code == 200, resp.text
    result = _message(resp)["result"]
    headers = {**HEADERS, "mcp-session-id": resp.headers["mcp-session-id"], "mcp-protocol-version": result["protocolVersion"]}
    client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    return result, headers


def test_initialize_negotiates_a_current_protocol_and_lists_tools():
    with TestClient(app) as client:
        result, headers = _session(client)
        assert result["protocolVersion"] >= "2025-11-25"
        assert result["serverInfo"]["name"] == "codelens"
        tools = _message(client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
        names = {t["name"] for t in tools["result"]["tools"]}
        assert {"explain_code", "get_debugging_summary", "propose_fix", "validate_fix", "get_variable_state"} <= names


def test_voice_tool_runs_code_in_process_and_answers_in_speech():
    with TestClient(app) as client:
        _, headers = _session(client)
        resp = client.post("/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "explain_code", "arguments": {"source_code": "total = 2 + 3\nprint(total)\n"}},
        })
        content = _message(resp)["result"]
        data = content.get("structuredContent") or json.loads(content["content"][0]["text"])
        assert "finished" in data["speech"] or "ran" in data["speech"]
        assert data["run"]["stdout"] == "5\n"


def test_foreign_browser_origins_are_refused():
    with TestClient(app) as client:
        resp = client.post("/mcp", headers={**HEADERS, "Origin": "https://evil.example"}, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "x", "version": "1"}},
        })
        assert resp.status_code == 403
