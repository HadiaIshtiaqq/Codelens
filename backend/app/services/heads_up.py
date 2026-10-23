"""Bugs you can see before running: warnings for the "What does this program do?" plan.

Common beginner mistakes found from the syntax tree alone:
- joining text and a number with `+` (TypeError at run time), including through a function
  parameter that a call site fills with a number;
- a `while` loop whose counter moves away from the point where the loop would stop;
- a name that is used but never created, usually a typo (NameError), with a suggestion;
- `for i in range(len(xs) + 1)` reading `xs[i]` one past the end (IndexError).
"""

import ast
import builtins
import difflib
from typing import Any, Literal, Optional

Level = Literal["kid", "game", "classic"]


def _number_constants(tree: ast.Module) -> dict[str, tuple[Any, int]]:
    """Module-level `name = <number>` assignments: name -> (value, line).

    Only names assigned exactly once anywhere, so `total = 5` then `total = str(total)` is not flagged.
    """
    assigned: dict[str, int] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AugAssign | ast.AnnAssign | ast.For):
            targets = [node.target]
        else:
            continue
        for target in targets:
            for name in ast.walk(target):
                if isinstance(name, ast.Name):
                    assigned[name.id] = assigned.get(name.id, 0) + 1
    found: dict[str, tuple[Any, int]] = {}
    for node in tree.body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Constant) and type(node.value.value) in (int, float)
                and assigned.get(node.targets[0].id) == 1):
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


def _defined_names(tree: ast.Module) -> set[str]:
    """Every name the program creates anywhere (scopes are ignored: this only looks for typos)."""
    names = set(dir(builtins)) | {"__name__", "__file__", "__doc__"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store | ast.Del):
            names.add(node.id)
        elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.Import | ast.ImportFrom):
            names.update((a.asname or a.name).split(".")[0] for a in node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.Global | ast.Nonlocal):
            names.update(node.names)
    return names


def _unknown_names(tree: ast.Module, level: Level) -> list[dict[str, Any]]:
    """`print(totl)` when the program only ever made `total`: a NameError waiting to happen."""
    if any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree)):
        return []  # `from x import *` can define anything
    defined = _defined_names(tree)
    warnings: list[dict[str, Any]] = []
    seen: set[str] = set()
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)) or node.id in defined or node.id in seen:
            continue
        seen.add(node.id)
        close = difflib.get_close_matches(node.id, [n for n in defined if not n.startswith("__")], n=1, cutoff=0.75)
        guess = close[0] if close else None
        if level == "kid":
            message = (f"⚠️ Watch out! Line {node.lineno} uses {node.id}, but there is no box with that name."
                       + (f" Did you mean {guess}?" if guess else " Make the box first, or check the spelling."))
        elif level == "game":
            message = (f"⚠️ Unknown name on line {node.lineno}: `{node.id}` is never created, so the robot will "
                       f"crash with a NameError." + (f" Did you mean `{guess}`?" if guess else ""))
        else:
            message = (f"Line {node.lineno}: `{node.id}` is not defined anywhere, so this raises NameError."
                       + (f" Did you mean `{guess}`?" if guess else ""))
        warnings.append({"line": node.lineno, "text": message})
    return warnings


def _one_past_the_end(tree: ast.Module, level: Level) -> list[dict[str, Any]]:
    """`for i in range(len(xs) + 1): xs[i]` reads one item past the end on the last turn."""
    warnings: list[dict[str, Any]] = []
    for loop in ast.walk(tree):
        if not (isinstance(loop, ast.For) and isinstance(loop.target, ast.Name) and isinstance(loop.iter, ast.Call)
                and getattr(loop.iter.func, "id", None) == "range" and loop.iter.args):
            continue
        bound = loop.iter.args[-1] if len(loop.iter.args) <= 2 else None
        if not (isinstance(bound, ast.BinOp) and isinstance(bound.op, ast.Add) and isinstance(bound.right, ast.Constant)
                and bound.right.value == 1 and isinstance(bound.left, ast.Call) and getattr(bound.left.func, "id", None) == "len"
                and bound.left.args and isinstance(bound.left.args[0], ast.Name)):
            continue
        seq, index = bound.left.args[0].id, loop.target.id
        used = any(isinstance(n, ast.Subscript) and isinstance(n.value, ast.Name) and n.value.id == seq
                   and isinstance(n.slice, ast.Name) and n.slice.id == index for n in ast.walk(loop))
        if not used:
            continue
        if level == "kid":
            message = (f"⚠️ Watch out! The loop on line {loop.lineno} counts one too far: on its last turn, "
                       f"{seq}[{index}] asks for a car that isn't on the {seq} train. Use range(len({seq})).")
        elif level == "game":
            message = (f"⚠️ Off-by-one on line {loop.lineno}: range(len({seq}) + 1) makes {index} reach len({seq}), "
                       f"one past the last item, so {seq}[{index}] crashes with an IndexError. Use range(len({seq})).")
        else:
            message = (f"Line {loop.lineno}: range(len({seq}) + 1) lets {index} reach len({seq}); {seq}[{index}] "
                       f"then raises IndexError. Use range(len({seq})).")
        warnings.append({"line": loop.lineno, "text": message})
    return warnings


def heads_up(tree: ast.Module, level: Level) -> list[dict[str, Any]]:
    """Warnings about likely bugs, in the reader's words, ordered by line."""
    found = (_text_plus_number(tree, level) + _endless_loops(tree, level) + _unknown_names(tree, level)
             + _one_past_the_end(tree, level))
    return sorted(found, key=lambda w: w["line"])
