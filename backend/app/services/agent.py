"""Alexa's autopilot: work toward a goal ("debug my code") by chaining CodeLens tools.

With an AI provider, the model plans: it is given the tools below (OpenAI-style function calling),
decides which to call, sees each result and calls the next, then answers in a few spoken
sentences. Without one, a fixed plan does the same chain: run -> diagnose -> fix -> test.

Every tool is one of the CodeLens MCP tools, so each fact comes from the recorded run; the agent
can only summarise what the tools returned. Each step is reported back so the UI can show the plan.
"""

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from app import mcp_server as tools
from app.services.llm import LLMClient, LLMError

log = logging.getLogger(__name__)
MAX_TOOL_CALLS = 8

TOOL_SPECS: list[dict[str, Any]] = [
    {"name": "run_code", "description": "Run the user's program in the sandbox and record every step. Call this first.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "diagnose", "description": "Explain why the last run failed (or what happened), from the recorded run.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "variable_history", "description": "How one variable's value changed during the last run.",
     "parameters": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "where_it_stopped", "description": "The line, function and variables where the last run stopped or crashed.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "propose_fix", "description": "Propose a code change that fixes the last run's failure.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "test_fix", "description": "Run the proposed fix in a fresh sandbox to check it really works.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "explain_code_part", "description": "Explain how part of the code works, e.g. 'how is the path built?'.",
     "parameters": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]}},
]

SYSTEM_PROMPT = """You are Alexa's debugging agent for a learner's Python program.
Work toward the user's goal by calling tools: usually run_code first, then diagnose if it failed,
then propose_fix and test_fix. Use variable_history, where_it_stopped or explain_code_part when they help.
Only state facts that came from tool results; never guess values, lines or output.
When you are done, reply WITHOUT calling a tool: 2 to 5 short spoken sentences, no markdown.
Say what was wrong (with the line number), what you changed, and whether the test passed.
If you have a tested fix, end with: Say "apply the fix" to put it in your editor."""


@dataclass
class AgentState:
    source: str
    execution_id: Optional[str] = None
    failed: bool = False
    patch: Optional[dict[str, Any]] = None
    line: Optional[int] = None
    steps: list[dict[str, Any]] = field(default_factory=list)


def _first_line(text: str) -> Optional[int]:
    m = re.search(r"\bline (\d+)\b", text)
    return int(m.group(1)) if m else None


async def _call_tool(name: str, args: dict[str, Any], st: AgentState) -> dict[str, Any]:
    """Run one tool; returns what the model sees. Also records the step for the UI."""
    async def ensure_run() -> str:
        if not st.execution_id:
            await _call_tool("run_code", {}, st)
        return st.execution_id or ""

    if name == "run_code":
        res = await tools.explain_code(st.source)
        run = res["run"]
        st.execution_id, st.failed = res["execution_id"], bool(run.get("error")) or run["status"] != "completed"
        if st.failed and run.get("error"):
            st.line = run["error"].get("line") or st.line
        out = {"speech": res["speech"], "status": run["status"], "error": run.get("error"), "stdout": (run.get("stdout") or "")[:600]}
    elif name == "diagnose":
        res = await tools.get_debugging_summary(await ensure_run())
        out = {"speech": res["speech"], "observed_facts": res.get("observed_facts", [])[:8]}
    elif name == "variable_history":
        res = await tools.get_variable_state(await ensure_run(), str(args.get("name", "")))
        out = {"speech": res["speech"], "values": [h["value"] for h in res.get("history", [])][:20]}
    elif name == "where_it_stopped":
        res = await tools.get_execution_state(await ensure_run())
        st.line = (res.get("event") or {}).get("line") or st.line
        out = {"speech": res["speech"]}
    elif name == "propose_fix":
        res = await tools.propose_fix(await ensure_run())
        if res.get("found"):
            st.patch = {"patch_id": res["patch_id"], "patched_source": res["patched_source"], "diff": res["diff"]}
        out = {"speech": res["speech"], "diff": (res.get("diff") or "")[:1500]}
    elif name == "test_fix":
        if not st.patch:
            out = {"speech": "There is no proposed fix to test yet."}
        else:
            # Tests written from the run: calls that worked must still work, the one that crashed must not.
            try:
                template = await tools._call("GET", f"/api/v1/executions/{st.execution_id}/test-template")
                tests = template.get("tests") or None
            except tools.CodeLensAPIError:
                tests = None
            res = await tools.validate_fix(st.patch["patch_id"], tests)
            st.patch["status"] = res["status"]
            out = {"speech": res["speech"], "status": res["status"]}
    elif name == "explain_code_part":
        res = await tools.ask_about_code(st.source, str(args.get("question", "")), st.execution_id)
        st.line = res.get("line") or st.line
        out = {"speech": res["speech"]}
    else:
        out = {"error": f"unknown tool {name}"}
    st.steps.append({"tool": name, "args": args, "summary": str(out.get("speech") or out.get("error") or "")[:300]})
    return out


async def _planned(st: AgentState) -> str:
    """The chain without an AI: run, and if it failed, diagnose -> fix -> test."""
    run = await _call_tool("run_code", {}, st)
    if not st.failed:
        output = run.get("stdout", "").strip()
        return f"{run['speech']}" + (f" It printed: {output[:200]}." if output else "") + " There's nothing to fix."
    diagnosis = await _call_tool("diagnose", {}, st)
    fix = await _call_tool("propose_fix", {}, st)
    if not st.patch:
        return f"{diagnosis['speech']} {fix['speech']}"
    test = await _call_tool("test_fix", {}, st)
    tail = ' Say "apply the fix" to put it in your editor.' if st.patch.get("status") != "failed" else ""
    return f"{run['speech'].split('.')[0]}. {fix['speech'].replace(' Say validate to test it.', '')} {test['speech']}{tail}"


async def _with_model(st: AgentState, goal: str, client: LLMClient) -> str:
    numbered = "\n".join(f"{i:>3} | {line}" for i, line in enumerate(st.source.splitlines(), 1))
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"GOAL: {goal}\n\nCODE (main.py):\n{numbered}"},
    ]
    specs = [{"type": "function", "function": spec} for spec in TOOL_SPECS]
    for _ in range(MAX_TOOL_CALLS):
        message = await client.chat(messages, specs)
        calls = message.get("tool_calls") or []
        if not calls:
            text = (message.get("content") or "").strip()
            if not text:
                raise LLMError("the model gave no answer")
            return text
        messages.append({"role": "assistant", "content": message.get("content") or "", "tool_calls": calls})
        for call in calls:
            fn = call.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except ValueError:
                args = {}
            result = await _call_tool(str(fn.get("name")), args if isinstance(args, dict) else {}, st)
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": json.dumps(result)[:4000]})
    raise LLMError(f"no answer after {MAX_TOOL_CALLS} tool calls")


async def autopilot(source: str, goal: str, client: Optional[LLMClient]) -> dict[str, Any]:
    st = AgentState(source=source)
    mode = "planner"
    if client is not None:
        try:
            speech = await _with_model(st, goal, client)
            mode = "ai"
        except (LLMError, tools.CodeLensAPIError) as exc:
            log.warning("autopilot: AI plan failed, using the fixed plan: %s", exc)
            st = AgentState(source=source)
            speech = await _planned(st)
    else:
        speech = await _planned(st)
    line_count = len(source.splitlines())
    line = st.line or _first_line(speech)
    return {
        "speech": speech,
        "steps": st.steps,
        "line": line if line and 1 <= line <= line_count else None,
        "execution_id": st.execution_id,
        "failed": st.failed,
        "patch": st.patch,
        "source": mode,
    }
