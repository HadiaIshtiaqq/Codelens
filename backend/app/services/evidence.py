"""Evidence compiler (spec §3.3 step 2).

Turns a recorded execution into a bounded, model-ready evidence package, and
derives the `observed_facts` list deterministically from the trace. Facts are
never produced by a model, which is how FR-01 ("prohibit AI models from
inventing variable states or error details") is enforced.
"""

from typing import Any, Optional

from app.services.store import ExecutionRecord

WINDOW_BEFORE = 3  # trace steps preceding the focus step (spec §3.3)
MAX_FACT_LOCALS = 8
OUTPUT_TAIL_CHARS = 2000


def failure_step(events: list[dict[str, Any]], error: Optional[dict[str, Any]]) -> Optional[int]:
    """Index of the exception event where the error originated (innermost frame)."""
    if not error:
        return None
    candidates = [e for e in events if e["event"] == "exception" and e["exception"]["type"] == error["type"]]
    if not candidates:
        return None
    # The first exception event of the final propagation chain is the deepest frame.
    first = candidates[0]
    for ev in candidates:
        if ev["line"] == error["line"] and ev.get("file", "main.py") == error.get("file", "main.py"):
            first = ev
            break
    return first["step"]


def call_stack_at(events: list[dict[str, Any]], step: int) -> list[dict[str, Any]]:
    """Call stack at `step`: read from the step's visual snapshot when present (exact, even
    after skipped steps in long runs), otherwise reconstructed by replaying call/return events."""
    for ev in reversed(events[: step + 1]):
        viz = ev.get("viz")
        if viz:
            return [{"function": f["function"], "line": f["line"], "file": f.get("file", "main.py")}
                    for f in viz["stack"]]
        if ev["event"] not in ("stdout", "exit"):
            break
    stack: list[dict[str, Any]] = []
    for ev in events[: step + 1]:
        kind = ev["event"]
        if kind == "call":
            stack.append({"function": ev["function"], "line": ev["line"], "file": ev.get("file", "main.py")})
        elif kind == "return" and ev["step"] < step:
            # A frame is still on the stack at its own return step.
            if stack:
                stack.pop()
            continue
        if stack and kind in ("line", "exception", "call", "stdout", "return"):
            stack[-1]["line"] = ev["line"]
    return stack


def _numbered(source: str) -> str:
    lines = source.splitlines()
    width = len(str(len(lines)))
    return "\n".join(f"{i:>{width}} | {line}" for i, line in enumerate(lines, 1))


def _compact(ev: dict[str, Any]) -> dict[str, Any]:
    keep = {k: ev[k] for k in ("step", "event", "line", "function", "locals", "stack_depth") if k in ev}
    for optional in ("return_value", "exception", "stdout_chunk", "exit_code"):
        if optional in ev:
            keep[optional] = ev[optional]
    return keep


def build_evidence(record: ExecutionRecord, step: Optional[int] = None) -> dict[str, Any]:
    result = record.result
    events = result.events
    fail = failure_step(events, result.error)
    if step is None or not (0 <= step < len(events)):
        step = fail if fail is not None else (len(events) - 1 if events else None)

    window: list[dict[str, Any]] = []
    focus: Optional[dict[str, Any]] = None
    stack: list[dict[str, Any]] = []
    if step is not None:
        focus = events[step]
        window = [_compact(e) for e in events[max(0, step - WINDOW_BEFORE) : step + 1]]
        stack = call_stack_at(events, step)

    source_lines = record.source.splitlines()
    return {
        "program": {
            "file": "main.py",
            "line_count": len(source_lines),
            "numbered_source": _numbered(record.source),
            "other_files": {name: _numbered(text) for name, text in record.files.items()},
            "program_input": record.stdin[-2000:],
        },
        "outcome": {
            "status": result.status,
            "exit_code": result.exit_code,
            "error": result.error,
            "trace_truncated": result.trace_truncated,
            "total_steps": len(events),
        },
        "focus_step": step,
        "failure_step": fail,
        "focus_event": _compact(focus) if focus else None,
        "trace_window": window,
        "call_stack": stack,
        "stdout_tail": result.stdout[-OUTPUT_TAIL_CHARS:],
        "stderr_tail": result.stderr[-OUTPUT_TAIL_CHARS:],
    }


def observed_facts(evidence: dict[str, Any]) -> list[str]:
    """Plain-language facts that are read directly off the recorded trace."""
    facts: list[str] = []
    outcome = evidence["outcome"]
    error = outcome["error"]

    if outcome["status"] == "timed_out":
        facts.append("The program was stopped because it exceeded the wall-clock time limit")
    elif outcome["status"] == "failed":
        facts.append(f"The sandbox failed to run the program: {error['message'] if error else 'unknown error'}")
    elif error:
        facts.append(f"{error['type']} raised at line {error['line']}: {error['message']}")
    else:
        facts.append(f"The program finished with exit code {outcome['exit_code']}")

    focus = evidence["focus_event"]
    if focus:
        facts.append(
            # Human-facing step numbers are 1-based, matching the workspace UI.
            f"At step {focus['step'] + 1} the program was at line {focus['line']} in function '{focus['function']}'"
        )
        locals_ = list(focus.get("locals", {}).items())
        for name, value in locals_[:MAX_FACT_LOCALS]:
            if value.startswith(("<function", "<class", "<module")):
                continue
            facts.append(f"Variable '{name}' was {value}")
        if "return_value" in focus:
            facts.append(f"'{focus['function']}' returned {focus['return_value']}")

    stack = evidence["call_stack"]
    if len(stack) > 1:
        chain = " → ".join(f"{f['function']} (line {f['line']})" for f in stack)
        facts.append(f"Call stack: {chain}")

    if outcome["trace_truncated"]:
        facts.append(f"The trace was truncated after {outcome['total_steps'] - 1} steps; later steps were not recorded")
    if evidence["stdout_tail"]:
        n = evidence["stdout_tail"].count("\n")
        facts.append(f"The program printed {n} line(s) of output before stopping" if error else f"The program printed {n} line(s) of output")
    return facts
