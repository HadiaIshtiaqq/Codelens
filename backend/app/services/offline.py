"""Deterministic offline engine: rule-based explanations and AST-driven fixes.

Used when no LLM provider is configured, and as the graceful-degradation path
when a provider call fails or returns an invalid response (spec §1.4).
"""

import ast
import builtins
import difflib
import io
import re
import tokenize
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Explanations
# ---------------------------------------------------------------------------

_EXPLAIN: dict[str, tuple[str, str]] = {
    # type: (likely cause, suggested next step)
    "ZeroDivisionError": (
        "A number was divided by zero. The divisor in the expression on the failing line evaluated to 0.",
        "Check the divisor before dividing (for example `if b == 0:`) and decide what the function should do in that case.",
    ),
    "IndexError": (
        "A list or other sequence was indexed with a position that does not exist. Valid indexes run from 0 to len(sequence) - 1.",
        "Compare the index variable with the length of the sequence at the failing step; loops using `range(len(x) + 1)` or `x[len(x)]` are common causes.",
    ),
    "KeyError": (
        "A dictionary was looked up with a key that it does not contain.",
        "Check the keys present in the dictionary at the failing step, or use `dict.get(key, default)` when the key may be missing.",
    ),
    "TypeError": (
        "An operation was applied to a value of the wrong type (for example adding a string to a number, or calling something that is not a function).",
        "Look at the types of the variables on the failing line in the inspector and convert one of them explicitly (`int(...)`, `str(...)`).",
    ),
    "NameError": (
        "The code used a name that was never defined at that point (often a typo, or a variable used before it is assigned).",
        "Check the spelling of the name on the failing line against the variables and functions that do exist.",
    ),
    "UnboundLocalError": (
        "A local variable was read before any value was assigned to it in that function.",
        "Assign the variable before it is used, or pass it in as a parameter.",
    ),
    "AttributeError": (
        "The code accessed an attribute or method that the object does not have. If the object is `None`, an earlier step probably returned nothing.",
        "Inspect the object's value and type at the failing step and trace back where it was assigned.",
    ),
    "ValueError": (
        "A function received an argument of the right type but an inappropriate value (for example `int('abc')`).",
        "Inspect the value passed on the failing line and validate it before the call.",
    ),
    "RecursionError": (
        "A function kept calling itself without reaching a base case, exceeding Python's recursion limit.",
        "Make sure the recursive function has a base case that is reached for every input, and that each call moves closer to it.",
    ),
    "SyntaxError": (
        "Python could not parse the program, so nothing ran. The marked line contains invalid syntax.",
        "Check the marked line for missing colons, brackets, quotes or misplaced keywords.",
    ),
    "IndentationError": (
        "The indentation of the marked line does not match the surrounding block.",
        "Indent the block consistently (4 spaces per level) and do not mix tabs and spaces.",
    ),
    "EOFError": (
        "The program called input(), but the sandbox provides no interactive input.",
        "Replace input() with a fixed value or a function parameter while debugging.",
    ),
    "ModuleNotFoundError": (
        "The program imported a module that is not installed in the sandbox.",
        "Use only the Python standard library, or remove the import.",
    ),
    "AssertionError": (
        "An assert statement evaluated to False.",
        "Inspect the values used in the assertion at the failing step.",
    ),
    "TimeoutError": (
        "The program ran longer than the time limit, which usually means a loop never ends.",
        "Find the loop that repeats in the final trace steps and check that its condition eventually becomes false.",
    ),
}


def explain(evidence: dict[str, Any], question: Optional[str]) -> dict[str, Any]:
    outcome = evidence["outcome"]
    error = outcome["error"]
    focus = evidence["focus_event"]

    if outcome["status"] == "timed_out":
        cause, step = _EXPLAIN["TimeoutError"]
        lines = sorted({e["line"] for e in evidence["trace_window"]})
        summary = "The program did not finish within the time limit."
        if lines:
            summary += f" The last recorded steps were cycling through line(s) {', '.join(map(str, lines))}."
        return {"summary": summary, "likely_cause": cause, "suggested_next_step": step}

    if error:
        cause, step = _EXPLAIN.get(
            error["type"],
            (
                f"The program raised {error['type']}: {error['message']}.",
                "Inspect the variables at the failing step to see which value differs from what you expected.",
            ),
        )
        where = f" in function '{focus['function']}'" if focus and focus["function"] != "<module>" else ""
        summary = f"{error['type']} at line {error['line']}{where}: {error['message']}."
        cause = _specialise(error, focus, cause)
        return {"summary": summary, "likely_cause": cause, "suggested_next_step": step}

    summary = f"The program ran to completion with exit code {outcome['exit_code']}."
    if focus:
        summary += f" At step {focus['step'] + 1} it was executing line {focus['line']} in '{focus['function']}'."
    return {
        "summary": summary,
        "likely_cause": None,
        "suggested_next_step": "Step through the trace and compare each variable with the value you expected."
        if question
        else None,
    }


def _specialise(error: dict[str, Any], focus: Optional[dict[str, Any]], cause: str) -> str:
    """Add evidence-backed detail to the generic cause when the trace supports it."""
    if not focus:
        return cause
    locals_ = focus.get("locals", {})
    if error["type"] == "ZeroDivisionError":
        zeros = [n for n, v in locals_.items() if v in ("0", "0.0")]
        if zeros:
            return cause + f" At the failing step, {', '.join(repr(z) for z in zeros)} was 0."
    if error["type"] == "NameError":
        m = re.search(r"name '(\w+)' is not defined", error["message"])
        if m:
            close = difflib.get_close_matches(m.group(1), list(locals_) + dir(builtins), n=1)
            if close:
                return cause + f" A similar name that does exist is '{close[0]}'."
    return cause


# ---------------------------------------------------------------------------
# Fixes
# ---------------------------------------------------------------------------

def propose_fix(source: str, evidence: dict[str, Any]) -> Optional[tuple[str, str]]:
    """Return (patched_source, rationale) for recognised failure patterns, else None."""
    error = evidence["outcome"]["error"]
    if not error or evidence["outcome"]["status"] != "completed":
        return None
    if error.get("file", "main.py") != "main.py":
        return None  # patches target main.py only
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    line = error["line"]
    focus = evidence["focus_event"] or {}
    fixer = {
        "ZeroDivisionError": _fix_zero_division,
        "KeyError": _fix_key_error,
        "IndexError": _fix_index_error,
        "NameError": _fix_name_error,
        # `x = x.sort()` surfaces as TypeError ('NoneType' object is not subscriptable) or AttributeError.
        "TypeError": lambda *a: _fix_none_from_in_place_method(*a) or _fix_type_error(*a),
        "AttributeError": _fix_none_from_in_place_method,
        "UnboundLocalError": _fix_unbound_local,
    }.get(error["type"])
    if not fixer:
        return None
    return fixer(source, tree, line, error, focus)


def _line_offsets(source: str) -> list[int]:
    offsets, total = [0], 0
    for text in source.splitlines(True):
        total += len(text)
        offsets.append(total)
    return offsets


def _char_col(source_line: str, byte_col: int) -> int:
    return len(source_line.encode("utf-8")[:byte_col].decode("utf-8", "ignore"))


def _replace_node(source: str, node: ast.AST, new_text: str) -> str:
    lines = source.splitlines(True)
    offsets = _line_offsets(source)
    start = offsets[node.lineno - 1] + _char_col(lines[node.lineno - 1], node.col_offset)
    end = offsets[node.end_lineno - 1] + _char_col(lines[node.end_lineno - 1], node.end_col_offset)
    return source[:start] + new_text + source[end:]


def _nodes_on_line(tree: ast.AST, line: int, kind: type) -> list[Any]:
    return [n for n in ast.walk(tree) if isinstance(n, kind) and getattr(n, "lineno", None) == line]


def _enclosing(tree: ast.AST, line: int) -> tuple[Optional[ast.FunctionDef], Optional[ast.stmt]]:
    """Innermost function and innermost (non-definition) statement containing `line`."""
    containing = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.stmt) and n.lineno <= line <= n.end_lineno
    ]
    innermost = lambda nodes: max(nodes, key=lambda n: (n.lineno, -n.end_lineno), default=None)  # noqa: E731
    func = innermost([n for n in containing if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))])
    stmt = innermost([
        n for n in containing if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    ])
    return func, stmt


def _fix_zero_division(source, tree, line, error, focus):
    divs = [n for n in _nodes_on_line(tree, line, ast.BinOp) if isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod))]
    if not divs:
        return None
    node = divs[0]
    divisor = ast.get_source_segment(source, node.right)
    func, stmt = _enclosing(tree, line)
    if func is not None and stmt is not None:
        lines = source.splitlines(True)
        indent = re.match(r"\s*", lines[stmt.lineno - 1]).group(0)
        guard = f"{indent}if {divisor} == 0:\n{indent}    return None\n"
        patched = "".join(lines[: stmt.lineno - 1]) + guard + "".join(lines[stmt.lineno - 1 :])
        return patched, (
            f"`{divisor}` was 0 at line {line}, so the division raised ZeroDivisionError. "
            f"The patch returns None from '{func.name}' when `{divisor}` is 0 instead of dividing. "
            "Check that None is what your program should produce in that case; raising a clear error "
            "or using a default value may suit it better."
        )
    expr = ast.get_source_segment(source, node)
    patched = _replace_node(source, node, f"({expr} if {divisor} != 0 else None)")
    return patched, f"`{divisor}` was 0 at line {line}; the patch evaluates to None instead of dividing by zero."


def _fix_key_error(source, tree, line, error, focus):
    subs = [n for n in _nodes_on_line(tree, line, ast.Subscript) if isinstance(n.ctx, ast.Load)]
    if not subs:
        return None
    node = subs[0]
    container = ast.get_source_segment(source, node.value)
    key = ast.get_source_segment(source, node.slice)
    patched = _replace_node(source, node, f"{container}.get({key})")
    return patched, (
        f"The key {error['message']} was not present in `{container}` at line {line}. "
        f"The patch uses `{container}.get({key})`, which returns None for missing keys."
    )


def _fix_index_error(source, tree, line, error, focus):
    func, _ = _enclosing(tree, line)
    scope = func or tree
    # Pattern 1: range(len(x) + 1) -> range(len(x))
    for node in ast.walk(scope):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "range"
            and node.args
            and isinstance(node.args[-1], ast.BinOp)
            and isinstance(node.args[-1].op, ast.Add)
            and isinstance(node.args[-1].right, ast.Constant)
            and node.args[-1].right.value == 1
            and isinstance(node.args[-1].left, ast.Call)
            and getattr(node.args[-1].left.func, "id", None) == "len"
        ):
            upper = node.args[-1]
            fixed = ast.get_source_segment(source, upper.left)
            patched = _replace_node(source, upper, fixed)
            return patched, (
                f"The loop bound `{ast.get_source_segment(source, upper)}` at line {upper.lineno} goes one past the "
                f"last valid index. The patch iterates up to `{fixed}` instead."
            )
    # Pattern 2: x[len(x)] -> x[len(x) - 1]
    for node in _nodes_on_line(tree, line, ast.Subscript):
        sl = node.slice
        if isinstance(sl, ast.Call) and getattr(sl.func, "id", None) == "len":
            text = ast.get_source_segment(source, sl)
            patched = _replace_node(source, sl, f"{text} - 1")
            return patched, f"`{text}` is one past the last valid index; the last element is at `{text} - 1`."
    return None


def _fix_name_error(source, tree, line, error, focus):
    m = re.search(r"name '(\w+)' is not defined", error["message"])
    if not m:
        return None
    missing = m.group(1)
    defined = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    defined |= {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
    defined |= {a.arg for n in ast.walk(tree) if isinstance(n, ast.arguments) for a in n.args}
    defined |= {name for name in dir(builtins) if not name.startswith("_")}
    close = difflib.get_close_matches(missing, sorted(defined - {missing}), n=1, cutoff=0.75)
    if not close:
        return None
    replacement = close[0]
    tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    lines = source.splitlines(True)
    changed = False
    for tok in reversed(tokens):
        if tok.type == tokenize.NAME and tok.string == missing and tok.start[0] == line:
            row, col = tok.start
            text = lines[row - 1]
            lines[row - 1] = text[:col] + replacement + text[col + len(missing):]
            changed = True
    if not changed:
        return None
    return "".join(lines), f"'{missing}' is not defined; the closest existing name is '{replacement}', which looks like the intended one."


def _fix_type_error(source, tree, line, error, focus):
    msg = error["message"]
    concat = "can only concatenate str" in msg
    unsupported = re.search(r"unsupported operand type\(s\) for \+: '(\w+)' and '(\w+)'", msg)
    if not (concat or unsupported):
        return None
    adds = [n for n in _nodes_on_line(tree, line, ast.BinOp) if isinstance(n.op, ast.Add)]
    if not adds:
        return None
    node = adds[0]
    types_ = focus.get("local_types", {})

    def type_of(operand):
        if isinstance(operand, ast.Constant):
            return type(operand.value).__name__
        if isinstance(operand, ast.Name):
            return types_.get(operand.id)
        return None

    left_t, right_t = type_of(node.left), type_of(node.right)
    if unsupported:
        left_t, right_t = left_t or unsupported.group(1), right_t or unsupported.group(2)
    if concat or left_t == "str":
        # String concatenation intended: convert the non-string side with str().
        target = node.right if left_t == "str" else node.left
        text = ast.get_source_segment(source, target)
        return _replace_node(source, target, f"str({text})"), (
            f"Line {line} adds a string and a non-string. The patch converts `{text}` with str() so the values are concatenated."
        )
    if right_t == "str" and left_t in ("int", "float"):
        text = ast.get_source_segment(source, node.right)
        return _replace_node(source, node.right, f"{left_t}({text})"), (
            f"`{text}` holds a string, but line {line} adds it to a {left_t}. The patch converts it with {left_t}() so the values are added numerically."
        )
    return None


_IN_PLACE = {"sort", "append", "extend", "insert", "reverse", "remove", "clear", "update", "add"}


def _fix_none_from_in_place_method(source, tree, line, error, focus):
    """`x = x.sort()` stores None, because list.sort() changes the list in place and returns None."""
    if not error["message"].startswith("'NoneType' object"):
        return None
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and node.value.func.attr in _IN_PLACE
            and isinstance(node.value.func.value, ast.Name)
            and node.value.func.value.id == node.targets[0].id
            and node.lineno <= line
        ):
            call = ast.get_source_segment(source, node.value)
            patched = _replace_node(source, node, call)
            name, method = node.targets[0].id, node.value.func.attr
            return patched, (
                f"Line {node.lineno} does `{name} = {call}`, but .{method}() changes `{name}` in place and returns None, "
                f"so `{name}` became None and line {line} failed. The patch calls `{call}` without re-assigning."
            )
    return None


def _fix_unbound_local(source, tree, line, error, focus):
    """A function assigns to a module-level variable without `global`, making it local (and unbound)."""
    m = re.search(r"local variable '(\w+)'|cannot access local variable '(\w+)'", error["message"])
    if not m:
        return None
    name = m.group(1) or m.group(2)
    module_names = {t.id for n in tree.body if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name)}
    func, _ = _enclosing(tree, line)
    if func is None or name not in module_names:
        return None
    lines = source.splitlines(True)
    body_first = func.body[0]
    indent = re.match(r"\s*", lines[body_first.lineno - 1]).group(0)
    insert_at = body_first.lineno - 1
    is_docstring = (
        isinstance(body_first, ast.Expr)
        and isinstance(body_first.value, ast.Constant)
        and isinstance(body_first.value.value, str)
    )
    if is_docstring:
        insert_at = body_first.end_lineno  # keep the docstring first
    patched = "".join(lines[:insert_at]) + f"{indent}global {name}\n" + "".join(lines[insert_at:])
    return patched, (
        f"'{func.name}' assigns to `{name}`, so Python treats `{name}` as a new local variable inside the function, "
        f"and line {line} read it before it had a value. The patch adds `global {name}` so the function updates the "
        "module-level variable. (Passing the value in and returning the new one is often a cleaner design.)"
    )
