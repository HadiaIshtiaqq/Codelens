"""Bugs you can see before running: warnings for the "What does this program do?" plan.

Two common beginner mistakes are found from the syntax tree alone:
- joining text and a number with `+` (TypeError at run time), including through a function
  parameter that a call site fills with a number;
- a `while` loop whose counter moves away from the point where the loop would stop.
"""

import ast
from typing import Any, Literal, Optional

Level = Literal["kid", "game", "classic"]


def _number_constants(tree: ast.Module) -> dict[str, tuple[Any, int]]:
    """Module-level `name = <number>` assignments: name -> (value, line)."""
    found: dict[str, tuple[Any, int]] = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Constant) and type(node.value.value) in (int, float)):
            found[node.targets[0].id] = (node.value.value, node.lineno)
    return found


def _add_chain(node: ast.BinOp) -> list[ast.expr]:
    """`a + b + c` -> [a, b, c]."""
    parts: list[ast.expr] = []
    for side in (node.left, node.right):
        if isinstance(side, ast.BinOp) and isinstance(side.op, ast.Add):
            parts.extend(_add_chain(side))
        else:
            parts.append(side)
    return parts


def _is_text(node: ast.expr) -> bool:
    return (isinstance(node, ast.Constant) and isinstance(node.value, str)) or isinstance(node, ast.JoinedStr)


def _number_args(tree: ast.Module, fn: ast.FunctionDef, param: str,
                 numbers: dict[str, tuple[Any, int]]) -> Optional[tuple[Any, int]]:
    """A call `fn(...)` that passes a number as `param`: (the number, line of the call)."""
    names = [a.arg for a in fn.args.args]
    if param not in names:
        return None
    index = names.index(param)
    for call in ast.walk(tree):
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == fn.name):
            continue
        arg = call.args[index] if index < len(call.args) else next((k.value for k in call.keywords if k.arg == param), None)
        if isinstance(arg, ast.Constant) and type(arg.value) in (int, float):
            return arg.value, call.lineno
        if isinstance(arg, ast.Name) and arg.id in numbers:
            return numbers[arg.id][0], call.lineno
    return None


def _text_plus_number(tree: ast.Module, level: Level) -> list[dict[str, Any]]:
    numbers = _number_constants(tree)
    functions = {f.name: f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef)}
    owner: dict[int, ast.FunctionDef] = {}
    for fn in functions.values():
        for inner in ast.walk(fn):
            owner[id(inner)] = fn

    warnings: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add)):
            continue
        parts = _add_chain(node)
        text = next((p for p in parts if _is_text(p)), None)
        if text is None:
            continue
        for part in parts:
            culprit: Optional[tuple[str, Any, Optional[int]]] = None  # (name, the number, line where it became one)
            if isinstance(part, ast.Constant) and type(part.value) in (int, float):
                culprit = (repr(part.value), part.value, None)
            elif isinstance(part, ast.Name):
                fn = owner.get(id(node))
                if fn is not None and part.id in [a.arg for a in fn.args.args]:
                    hit = _number_args(tree, fn, part.id, numbers)
                    if hit:
                        culprit = (part.id, hit[0], hit[1])
                elif fn is None and part.id in numbers:
                    culprit = (part.id, numbers[part.id][0], numbers[part.id][1])
            if culprit is None or (node.lineno, culprit[0]) in seen:
                continue
            seen.add((node.lineno, culprit[0]))
            name, number, where = culprit
            value, kind = repr(number), type(number).__name__
            joined = ast.unparse(text) if not isinstance(text, ast.JoinedStr) else "an f-string"
            from_line = f" (from line {where})" if where else ""
            if level == "kid":
                message = (f"⚠️ Watch out! Line {node.lineno} glues the words {joined} to {name}, but {name} is the "
                           f"number {value}{f' (from line {where})' if where else ''}. Python can't glue words and "
                           f"numbers together, so it will stop with an error. Fix: write str({name}) to turn the "
                           f"number into words.")
            elif level == "game":
                message = (f"⚠️ Trap on line {node.lineno}: `{ast.unparse(node)}` mixes text with a number: "
                           f"{name} = {value}{from_line}. The robot will crash here with a TypeError. "
                           f"Disarm it with str({name}) or an f-string.")
            else:
                message = (f"Line {node.lineno}: str + {kind} concatenation in `{ast.unparse(node)}`. "
                           f"{name} is {value}{from_line}, so this raises TypeError: can only concatenate str "
                           f"(not \"{kind}\") to str. Use str({name}) or an f-string.")
            warnings.append({"line": node.lineno, "text": message})
    return warnings


def _endless_loops(tree: ast.Module, level: Level) -> list[dict[str, Any]]:
    away = {ast.Gt: ast.Add, ast.GtE: ast.Add, ast.Lt: ast.Sub, ast.LtE: ast.Sub}
    warnings: list[dict[str, Any]] = []
    for loop in ast.walk(tree):
        test = getattr(loop, "test", None)
        if not (isinstance(loop, ast.While) and isinstance(test, ast.Compare) and len(test.ops) == 1
                and isinstance(test.left, ast.Name) and type(test.ops[0]) in away):
            continue
        name, wrong = test.left.id, away[type(test.ops[0])]
        step = next((n for n in ast.walk(loop) if isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name)
                     and n.target.id == name and isinstance(n.op, wrong)), None)
        if step is None:
            continue
        cond, change = ast.unparse(test), ast.unparse(step)
        direction = "bigger" if wrong is ast.Add else "smaller"
        if level == "kid":
            message = (f"⚠️ Watch out! The loop on line {loop.lineno} keeps going while {cond}, but line {step.lineno} "
                       f"makes {name} {direction} every time, so it will never stop.")
        elif level == "game":
            message = (f"⚠️ Endless loop on line {loop.lineno}: `{change}` (line {step.lineno}) moves {name} away "
                       f"from ending `while {cond}`. The robot will run until time is up.")
        else:
            message = (f"Line {loop.lineno}: `while {cond}` never terminates: `{change}` on line {step.lineno} "
                       f"moves {name} away from the exit condition.")
        warnings.append({"line": loop.lineno, "text": message})
    return warnings


def heads_up(tree: ast.Module, level: Level) -> list[dict[str, Any]]:
    """Warnings about likely bugs, in the reader's words, ordered by line."""
    found = _text_plus_number(tree, level) + _endless_loops(tree, level)
    return sorted(found, key=lambda w: w["line"])
