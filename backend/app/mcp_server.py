"""CodeLens MCP server (spec FR-08).

Exposes execution tracing, step-state queries, explanations, patching and
patch validation, plus REA reverse-engineering, as MCP tools for agent
clients (Claude Code, Alexa+, ...). It is a thin client over the CodeLens REST
API, so agents see the same executions as the web workspace.

    python -m app.mcp_server                    # stdio (default)
    python -m app.mcp_server --http --port 8765  # Streamable HTTP at /mcp

Register with Claude Code:
    claude mcp add codelens -- <backend>/.venv/Scripts/python -m app.mcp_server
"""

import argparse
import os
import re
import secrets
from typing import Any, Optional

import httpx
from mcp.server.mcpserver import MCPServer

API_URL = os.getenv("CODELENS_API_URL", "http://127.0.0.1:8000").rstrip("/")
ACCESS_CODE = os.getenv("CODELENS_ACCESS_CODE", "")  # sent when the API requires one
TIMEOUT = httpx.Timeout(float(os.getenv("CODELENS_MCP_TIMEOUT", "330")), connect=10.0)

mcp = MCPServer(
    name="codelens",
    title="CodeLens AI + REA",
    version="1.0.0",
    instructions=(
        "CodeLens runs Python in a sandbox and records an evidence trace (every line, call, return, "
        "exception and variable). Typical flow: run_python -> get_step_state / get_trace -> "
        "explain_execution -> propose_patch -> validate_patch (supply tests). Facts in explanations "
        "come from the trace; never claim a variable value that the trace does not show. "
        "REA tools reverse-engineer binaries and JavaScript/Electron apps inside the REA workspace."
    ),
)


class CodeLensAPIError(RuntimeError):
    pass


_transport: Optional[httpx.AsyncBaseTransport] = None  # injectable for tests


async def _call(method: str, path: str, **kwargs: Any) -> Any:
    try:
        headers = {"X-CodeLens-Access": ACCESS_CODE} if ACCESS_CODE else {}
        async with httpx.AsyncClient(base_url=API_URL, timeout=TIMEOUT, transport=_transport,
                                     headers=headers) as client:
            resp = await client.request(method, path, **kwargs)
    except httpx.HTTPError as exc:
        raise CodeLensAPIError(f"CodeLens API unreachable at {API_URL}: {exc}") from exc
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = resp.text
        raise CodeLensAPIError(f"HTTP {resp.status_code}: {detail}")
    return resp.json()


@mcp.tool(description="Run Python source in the CodeLens sandbox with full sys.settrace tracing. Returns status, "
                      "exit code, stdout/stderr, the error (type, message, line) and the number of trace steps.")
async def run_python(source_code: str, timeout_seconds: float = 5.0, stdin: str = "",
                     files: Optional[dict[str, str]] = None) -> dict[str, Any]:
    # `stdin` feeds input(); `files` adds importable modules, e.g. {"utils.py": "..."}.
    return await _call("POST", "/api/v1/executions",
                       json={"source_code": source_code, "limits": {"timeout_seconds": timeout_seconds},
                             "stdin": stdin, "files": files or {}})


@mcp.tool(description="Page through the recorded trace events (call/line/return/exception/stdout/exit) of an execution.")
async def get_trace(execution_id: str, start: int = 0, limit: int = 50) -> dict[str, Any]:
    return await _call("GET", f"/api/v1/executions/{execution_id}/trace", params={"start": start, "limit": limit, "include_viz": False})


@mcp.tool(description="Debugger state at one trace step: current line and function, local variables with types, "
                      "the call stack and stdout printed so far.")
async def get_step_state(execution_id: str, step: int) -> dict[str, Any]:
    return await _call("GET", f"/api/v1/executions/{execution_id}/steps/{step}")


@mcp.tool(description="Get the source code that was executed.")
async def get_source(execution_id: str) -> dict[str, Any]:
    return await _call("GET", f"/api/v1/executions/{execution_id}/source")


@mcp.tool(description="Evidence-grounded explanation of an execution (defaults to the failing step). "
                      "observed_facts are read directly from the trace.")
async def explain_execution(execution_id: str, step: Optional[int] = None,
                            question: Optional[str] = None) -> dict[str, Any]:
    return await _call("POST", "/api/v1/explanations",
                       json={"execution_id": execution_id, "step": step, "question": question})


@mcp.tool(description="Propose a fix as a unified diff of main.py. Omit `diff` to have CodeLens generate one from the "
                      "execution evidence; pass your own unified diff to register it for validation. The original "
                      "source is never modified.")
async def propose_patch(execution_id: str, explanation_id: Optional[str] = None,
                        diff: Optional[str] = None) -> dict[str, Any]:
    return await _call("POST", "/api/v1/patches",
                       json={"execution_id": execution_id, "explanation_id": explanation_id, "diff": diff})


@mcp.tool(description="Validate a patch in a fresh sandbox. `tests` is a Python module of test_* functions using "
                      "assert (import the program with `from main import ...`). Status is 'validated' only if every "
                      "test passes; 'untested' when no tests are given.")
async def validate_patch(patch_id: str, tests: Optional[str] = None) -> dict[str, Any]:
    return await _call("POST", "/api/v1/patches/validate", json={"patch_id": patch_id, "tests": tests})


@mcp.tool(description="Statically reconstruct a JavaScript/Electron application (ASAR or directory) with REA: "
                      "entrypoints, modules, IPC channels, context-bridge APIs and native add-ons. `path` is relative "
                      "to the REA workspace (or absolute inside it).")
async def rea_analyze_javascript_application(path: str) -> dict[str, Any]:
    result = await _call("POST", "/api/v1/rea/javascript", json={"path": path})
    result.pop("nodes", None)  # keep agent context small; full Evidence is at /api/v1/rea/results/{id}
    return result


@mcp.tool(description="Search REA's reverse-engineering tool catalogue (Ghidra/Hopper/IDA decompilation, binary "
                      "layout, APK, WASM, EVM, firmware, ...). Returns names, descriptions and whether each is allowed.")
async def rea_list_tools(query: Optional[str] = None) -> dict[str, Any]:
    data = await _call("GET", "/api/v1/rea/tools")
    tools = data["tools"]
    if query:
        q = query.lower()
        tools = [t for t in tools if q in t["name"].lower() or q in t["description"].lower()]
    return {"count": len(tools), "tools": [{**t, "description": t["description"][:300]} for t in tools]}


@mcp.tool(description="Get the input JSON schema of one REA tool before calling it.")
async def rea_tool_schema(name: str) -> dict[str, Any]:
    return await _call("GET", f"/api/v1/rea/tools/{name}")


@mcp.tool(description="Call one REA tool with JSON arguments. Destructive tools are refused unless the server "
                      "enables them; path arguments must be inside the REA workspace.")
async def rea_call_tool(name: str, arguments: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return await _call("POST", "/api/v1/rea/tools/call", json={"name": name, "arguments": arguments or {}})


# ---------------------------------------------------------------------------
# Conversational tools (Alexa+ / voice & chat assistants)
#
# Each returns a short `speech` string suitable for reading aloud, plus the
# structured data behind it. Every fact in `speech` comes from the trace.
# ---------------------------------------------------------------------------

async def _all_events(execution_id: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    start: Optional[int] = 0
    while start is not None:
        page = await _call("GET", f"/api/v1/executions/{execution_id}/trace",
                           params={"start": start, "limit": 500, "include_viz": False})
        events.extend(page["events"])
        start = page["next_start"]
    return events


def _place(function: str) -> str:
    return "the main program" if function == "<module>" else f"{function}()"


def _number(text: str) -> Optional[float]:
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


async def _endless_loop_speech(execution_id: str) -> str:
    """Which loop never ended and why, read from the end of the trace (falls back to a general sentence)."""
    general = "The program never finished: it ran out of time, which usually means a loop never ends."
    try:
        events = await _all_events(execution_id)
        source = (await _call("GET", f"/api/v1/executions/{execution_id}/source"))["source_code"].splitlines()
    except CodeLensAPIError:
        return general
    tail = [e for e in events[-300:] if e["event"] == "line" and e.get("file", "main.py") == "main.py"]
    counts: dict[int, int] = {}
    for e in tail:
        counts[e["line"]] = counts.get(e["line"], 0) + 1
    loops = [ln for ln in counts if 0 < ln <= len(source) and re.match(r"\s*(while|for)\b", source[ln - 1])]
    if not loops:
        return general
    line = max(loops, key=lambda ln: counts[ln])
    header = source[line - 1].strip().rstrip(":")
    speech = f"The program never finished. The loop on line {line}, {header}, kept repeating until time ran out."
    condition = header[len("while"):].strip() if header.startswith("while") else ""
    names = [n for n in re.findall(r"[A-Za-z_]\w*", condition)] or list(tail[-1].get("locals", {}))
    for name in names:
        values: list[str] = []
        for e in events:  # the whole run, so the story starts where the variable started
            v = e.get("locals", {}).get(name)
            if v is not None and (not values or values[-1] != v):
                values.append(v)
        if len(values) < 3:
            continue
        first, last = _number(values[0]), _number(values[-1])
        trend = ""
        if first is not None and last is not None and first != last:
            trend = " kept getting bigger" if last > first else " kept getting smaller"
        speech += f" {name}{trend}: {', '.join(values[:3])}, and on up to {values[-1]}"
        speech += f", so {condition} never became false." if condition else "."
        break
    return speech


def _outcome_speech(run: dict[str, Any]) -> str:
    if run["status"] == "timed_out":
        return "The program ran out of time, which usually means a loop never ends."
    if run["status"] == "failed":
        return "The sandbox could not run the program."
    err = run.get("error")
    if err:
        article = "an" if err["type"][:1].upper() in "AEIOU" else "a"
        return f"The program crashed with {article} {err['type']} on line {err['line']}: {err['message']}."
    return f"The program finished successfully in {run['total_steps']} steps."


@mcp.tool(description="Voice-friendly: run Python code and explain what happened. Returns `speech` (a short spoken "
                      "answer), the execution id for follow-up questions, and the evidence-backed explanation.")
async def explain_code(source_code: str, question: Optional[str] = None) -> dict[str, Any]:
    run = await run_python(source_code)
    exp = await _call("POST", "/api/v1/explanations",
                      json={"execution_id": run["execution_id"], "question": question})
    if run["status"] == "timed_out":
        speech = await _endless_loop_speech(run["execution_id"]) + " Say fix it, and I'll suggest a change."
    else:
        speech = _outcome_speech(run)
        if exp.get("likely_cause"):
            speech += f" {exp['likely_cause']}"
    return {"speech": speech, "execution_id": run["execution_id"], "run": run, "explanation": exp}


@mcp.tool(description="Voice-friendly: answer an open question about how the code works (\"how is the path "
                      "calculated?\", \"what does visited do?\") from the code itself, without running it. Returns "
                      "`speech`, the relevant lines with their explanations, and the main line to point at.")
async def ask_about_code(source_code: str, question: str) -> dict[str, Any]:
    from app.services.code_answers import answer

    return answer(source_code, question)


@mcp.tool(description="Voice-friendly: where the program is at a step (default: the failing or last step): line, "
                      "function, call stack and variables, with a `speech` summary.")
async def get_execution_state(execution_id: str, step: Optional[int] = None) -> dict[str, Any]:
    timed_out = False
    asked_for_step = step is not None
    if step is None:
        summary = await _call("GET", f"/api/v1/executions/{execution_id}")
        timed_out = summary["status"] == "timed_out"
        events = await _all_events(execution_id)
        step = len(events) - 1
        if summary.get("error"):
            fail = [e["step"] for e in events if e["event"] == "exception" and e["line"] == summary["error"]["line"]]
            step = fail[0] if fail else step
    state = await _call("GET", f"/api/v1/executions/{execution_id}/steps/{step}")
    ev = state["event"]
    stack = " inside ".join(_place(f["function"]) for f in reversed(state["call_stack"])) or "the main program"
    variables = ", ".join(f"{k} is {v}" for k, v in list(ev["locals"].items())[:6] if not v.startswith("<"))
    if timed_out:
        speech = f"It never stopped by itself: time ran out while it was on line {ev['line']} in {stack}."
    elif asked_for_step:
        speech = f"At step {step + 1}, the program is on line {ev['line']} in {stack}."
    elif ev["event"] == "exception":
        speech = f"It stopped on line {ev['line']} in {stack}."
    else:
        speech = f"It finished on line {ev['line']} in {stack}."
    if ev.get("narration") and ev["event"] != "exception":  # the exception sentence below says it already
        speech += f" {ev['narration'].rstrip('.')}."
    if variables:
        speech += f" {variables}."
    if ev["event"] == "exception":
        speech += f" Here it raised {ev['exception']['type']}: {ev['exception']['message']}."
    return {"speech": speech, **state}


@mcp.tool(description="Voice-friendly: the value and type of one variable at a step (default: last step it exists), "
                      "and how its value changed over the run.")
async def get_variable_state(execution_id: str, name: str, step: Optional[int] = None) -> dict[str, Any]:
    events = await _all_events(execution_id)
    history: list[dict[str, Any]] = []
    for ev in events:
        if name in ev.get("locals", {}) and (not history or history[-1]["value"] != ev["locals"][name]):
            history.append({"step": ev["step"], "line": ev["line"], "function": ev["function"],
                            "value": ev["locals"][name], "type": ev.get("local_types", {}).get(name)})
    if not history:
        return {"speech": f"I never saw a variable called {name} in this run.", "found": False, "history": []}
    current = history[-1]
    if step is not None:
        upto = [h for h in history if h["step"] <= step]
        current = upto[-1] if upto else history[0]
    values = [h["value"] for h in history]
    speech = f"{name} is {current['value']}, a {current['type']}, on line {current['line']}."
    if len(values) > 1:
        shown = ", then ".join(values[:6]) + (", and more" if len(values) > 6 else "")
        speech += f" Over the run it went: {shown}."
    return {"speech": speech, "found": True, "current": current, "history": history[:200]}


@mcp.tool(description="Voice-friendly: one-paragraph debugging summary of an execution: outcome, failing line, "
                      "observed facts and the most likely cause.")
async def get_debugging_summary(execution_id: str) -> dict[str, Any]:
    run = await _call("GET", f"/api/v1/executions/{execution_id}")
    exp = await _call("POST", "/api/v1/explanations", json={"execution_id": execution_id})
    if run["status"] == "timed_out":
        speech = await _endless_loop_speech(execution_id)
    else:
        speech = _outcome_speech(run)
        if exp.get("likely_cause"):
            speech += f" Likely cause: {exp['likely_cause']}"
    if exp.get("suggested_next_step"):
        speech += f" Next, {exp['suggested_next_step'][0].lower()}{exp['suggested_next_step'][1:]}"
    return {"speech": speech, "run": run, "observed_facts": exp["observed_facts"], "explanation": exp}


@mcp.tool(description="Voice-friendly: propose a fix for a failed execution. Returns `speech`, the patch id and the "
                      "unified diff. The fix is not trusted until validate_fix passes.")
async def propose_fix(execution_id: str) -> dict[str, Any]:
    try:
        patch = await _call("POST", "/api/v1/patches", json={"execution_id": execution_id})
    except CodeLensAPIError as exc:
        if "HTTP 422" not in str(exc):
            raise
        return {"speech": "I couldn't find a safe automatic fix for this one. Ask me why it crashed, and I'll explain "
                          "what went wrong so you can change it yourself.", "found": False}
    added = sum(1 for ln in patch["diff"].splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in patch["diff"].splitlines() if ln.startswith("-") and not ln.startswith("---"))
    speech = (f"I have a fix that adds {added} line{'s' if added != 1 else ''} and removes {removed}. "
              f"{patch['rationale']} Say validate to test it.")
    return {"speech": speech, "found": True, **patch}


@mcp.tool(description="Voice-friendly: test a proposed fix in a fresh sandbox. `tests` holds test_* functions using "
                      "assert; without tests the fix is only smoke-run and reported as untested.")
async def validate_fix(patch_id: str, tests: Optional[str] = None) -> dict[str, Any]:
    result = await _call("POST", "/api/v1/patches/validate", json={"patch_id": patch_id, "tests": tests})
    status = result["status"]
    if status == "validated":
        speech = f"Great news: all {result['tests_passed']} tests passed, so the fix is validated."
    elif status == "failed":
        speech = f"The fix is not ready: {result['tests_failed']} test{'s' if result['tests_failed'] != 1 else ''} failed."
    else:
        smoke = result["smoke"]
        ran = "runs without crashing" if not smoke.get("error") else f"still crashes with {smoke['error']['type']}"
        speech = f"The fixed program {ran}, but I had no tests, so it is untested."
    return {"speech": speech, **result}


def http_app(token: Optional[str], host: str = "127.0.0.1", public_hosts: Optional[list[str]] = None,
             path: str = "/mcp", local_browsers: bool = False):
    """Streamable HTTP MCP app at `path`, optionally guarded by a static bearer token.

    DNS-rebinding protection stays on: only localhost and the explicitly listed public
    host names (CODELENS_MCP_PUBLIC_HOSTS, e.g. your tunnel domain) are accepted.
    `local_browsers` also accepts pages served from localhost (the in-app Alexa+ simulator).
    """
    from mcp.server.transport_security import TransportSecuritySettings

    allowed = ["127.0.0.1", "127.0.0.1:*", "localhost", "localhost:*", *(public_hosts or [])]
    allowed += [f"{h}:*" for h in public_hosts or [] if ":" not in h]
    origins = [f"https://{h}" for h in public_hosts or []]
    if local_browsers:
        origins += ["http://127.0.0.1", "http://127.0.0.1:*", "http://localhost", "http://localhost:*"]
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=allowed,
                                         allowed_origins=origins)
    inner = mcp.streamable_http_app(host=host, transport_security=security, streamable_http_path=path)
    if not token:
        return inner
    expected = f"Bearer {token}".encode()

    async def guarded(scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            if not secrets.compare_digest(headers.get(b"authorization", b""), expected):
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json"), (b"www-authenticate", b"Bearer")]})
                await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
                return
        await inner(scope, receive, send)

    return guarded


def main() -> None:
    parser = argparse.ArgumentParser(description="CodeLens MCP server")
    parser.add_argument("--http", action="store_true", help="serve Streamable HTTP at /mcp instead of stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if not args.http:
        mcp.run("stdio")
        return
    import uvicorn

    token = os.getenv("CODELENS_MCP_TOKEN")
    if not token and args.host not in ("127.0.0.1", "localhost"):
        raise SystemExit("Refusing to serve MCP publicly without auth: set CODELENS_MCP_TOKEN")
    public = [h.strip() for h in os.getenv("CODELENS_MCP_PUBLIC_HOSTS", "").split(",") if h.strip()]
    uvicorn.run(http_app(token, args.host, public), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
