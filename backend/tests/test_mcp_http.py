"""The MCP server mounted in the API at /mcp (Streamable HTTP), as Alexa+ and the in-app simulator use it."""

import json

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


# `client` is the shared app (one lifespan for the whole session; a second one would close its database).
def test_initialize_negotiates_a_current_protocol_and_lists_tools(client):
    result, headers = _session(client)
    assert result["protocolVersion"] >= "2025-11-25"
    assert result["serverInfo"]["name"] == "codelens"
    tools = _message(client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
    names = {t["name"] for t in tools["result"]["tools"]}
    assert {"explain_code", "get_debugging_summary", "propose_fix", "validate_fix", "get_variable_state"} <= names


def test_voice_tool_runs_code_in_process_and_answers_in_speech(client):
    _, headers = _session(client)
    resp = client.post("/mcp", headers=headers, json={
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "explain_code", "arguments": {"source_code": "total = 2 + 3\nprint(total)\n"}},
    })
    content = _message(resp)["result"]
    data = content.get("structuredContent") or json.loads(content["content"][0]["text"])
    assert "finished" in data["speech"]
    assert data["run"]["stdout"] == "5\n"


def test_foreign_browser_origins_are_refused(client):
    resp = client.post("/mcp", headers={**HEADERS, "Origin": "https://evil.example"}, json={
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "x", "version": "1"}},
    })
    assert resp.status_code == 403


def _call(client, headers, name, arguments, call_id):
    resp = client.post("/mcp", headers=headers, json={
        "jsonrpc": "2.0", "id": call_id, "method": "tools/call", "params": {"name": name, "arguments": arguments},
    })
    content = _message(resp)["result"]
    assert not content.get("isError"), content
    return content.get("structuredContent") or json.loads(content["content"][0]["text"])


def test_a_loop_that_never_ends_is_explained_and_fixed(client):
    _, headers = _session(client)
    run = _call(client, headers, "explain_code", {"source_code": "count = 10\nwhile count > 0:\n    count += 1\n"}, 10)
    speech = run["speech"]
    assert "never finished" in speech and "line 2, while count > 0" in speech
    assert "count kept getting bigger: 10, 11, 12" in speech and "never became false" in speech
    state = _call(client, headers, "get_execution_state", {"execution_id": run["execution_id"]}, 11)
    assert state["speech"].startswith("It never stopped by itself") and "<module>" not in state["speech"]
    fix = _call(client, headers, "propose_fix", {"execution_id": run["execution_id"]}, 12)
    assert fix["found"] and "count -= 1" in fix["patched_source"]


def test_no_automatic_fix_is_an_answer_not_an_error(client):
    _, headers = _session(client)
    run = _call(client, headers, "explain_code", {"source_code": "x = 5\nprint(x)\n"}, 20)
    fix = _call(client, headers, "propose_fix", {"execution_id": run["execution_id"]}, 21)
    assert fix["found"] is False and "couldn't find" in fix["speech"]
