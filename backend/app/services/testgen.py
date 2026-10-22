"""Generate starter tests from a recorded run.

Every call to a top-level function of main.py becomes a test:
  * calls that returned  ->  `assert f(args) == <value it returned>` (regression test)
  * calls that crashed   ->  `f(args)` must not raise (this is what a fix should achieve)
Only arguments and results that are plain Python literals are used, so the
generated tests are always valid code. Nothing is executed here.
"""

import ast
import math
from typing import Any, Optional

from app.services.store import ExecutionRecord

MAX_TESTS = 10
MAX_PER_FUNCTION = 3


def _literal(text: Optional[str]) -> tuple[bool, Any]:
    if text is None or text.endswith("...") or "<" in text and ">" in text:
        return False, None
    try:
        return True, ast.literal_eval(text)
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return False, None


def _top_level_functions(source: str) -> list[str]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    return [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith("_")]


def _outcome(events: list[dict[str, Any]], call_index: int) -> tuple[str, Optional[str], Optional[str]]:
    """('returned', value_text, None) or ('raised', None, exception_type) or ('unknown', None, None)."""
    call = events[call_index]
    depth = call["stack_depth"]
    for j in range(call_index + 1, len(events)):
        ev = events[j]
        if ev["stack_depth"] < depth and ev["event"] != "stdout":
            return "unknown", None, None
        if ev["stack_depth"] == depth and ev["function"] == call["function"] and ev["event"] == "return":
            nxt = next((e for e in events[j + 1:] if e["event"] != "stdout"), None)
            if nxt is not None and nxt["event"] == "exception" and nxt["stack_depth"] == depth - 1:
                return "raised", None, nxt["exception"]["type"]
            if nxt is not None and nxt["event"] == "exit" and nxt.get("exit_code") not in (0, None) and depth == 2:
                exc = next((e for e in events[call_index:j + 1][::-1] if e["event"] == "exception"), None)
                if exc:
                    return "raised", None, exc["exception"]["type"]
            return "returned", ev.get("return_value"), None
    return "unknown", None, None


def _assertion(call_src: str, value: Any) -> str:
    if isinstance(value, float) and math.isfinite(value):
        return f"    assert abs({call_src} - {value!r}) < 1e-9\n"
    if value is None:
        return f"    assert {call_src} is None\n"
    return f"    assert {call_src} == {value!r}\n"


def test_template(record: ExecutionRecord) -> str:
    functions = _top_level_functions(record.source)
    events = record.result.events
    seen: set[tuple[str, str]] = set()
    per_function: dict[str, int] = {}
    blocks: list[str] = []
    used: set[str] = set()
    crash_count: dict[str, int] = {}

    for i, ev in enumerate(events):
        if ev["event"] != "call" or ev.get("file", "main.py") != "main.py" or ev["function"] not in functions:
            continue
        fn = ev["function"]
        args = []
        for name in ev.get("arg_names", []):
            ok, value = _literal(ev["locals"].get(name))
            if not ok:
                break
            args.append(repr(value))
        else:
            call_src = f"{fn}({', '.join(args)})"
            if (fn, call_src) in seen or per_function.get(fn, 0) >= MAX_PER_FUNCTION:
                continue
            kind, value_text, exc_type = _outcome(events, i)
            if kind == "raised":
                crash_count[fn] = crash_count.get(fn, 0) + 1
                suffix = "" if crash_count[fn] == 1 else f"_{crash_count[fn]}"
                blocks.append(
                    f"\ndef test_{fn}_does_not_crash{suffix}():\n"
                    f"    # In the recorded run this call raised {exc_type}. A fix should make it work.\n"
                    f"    # TODO: also assert the result you expect, e.g. assert {call_src} == ...\n"
                    f"    {call_src}\n"
                )
            elif kind == "returned":
                ok, value = _literal(value_text)
                if not ok:
                    continue
                blocks.append(
                    f"\ndef test_{fn}_{per_function.get(fn, 0) + 1}():\n"
                    f"    # Recorded: {call_src} returned {value_text}\n" + _assertion(call_src, value)
                )
            else:
                continue
            seen.add((fn, call_src))
            used.add(fn)
            per_function[fn] = per_function.get(fn, 0) + 1
            if len(blocks) >= MAX_TESTS:
                break

    header = (
        "# Tests run in a fresh sandbox against the PATCHED program (imported as `main`).\n"
        "# Generated from your last run: calls that worked are kept as regression tests,\n"
        "# and calls that crashed must stop crashing. Edit freely; pytest features work too.\n"
    )
    if not blocks:
        if functions:
            first = functions[0]
            return (header + f"from main import {', '.join(functions)}\n\n\n"
                    f"def test_{first}():\n    # TODO: call {first}(...) and assert the result you expect\n"
                    f"    assert callable({first})\n")
        return header + "import main  # noqa: F401  (importing runs the program)\n\n\ndef test_program_runs():\n    assert True\n"
    imports = ", ".join(f for f in functions if f in used)
    return header + f"from main import {imports}\n\n" + "".join(blocks)
