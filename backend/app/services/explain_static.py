"""Explain a program without running it: a plan of the whole program and a note for every line.

Built only from the syntax tree, so it is instant, works offline, and never runs
the code. Two reading levels:
  "kid"      everyday words for a young beginner (boxes, trains, tricks)
  "standard" short, precise wording for older learners
"""

import ast
from typing import Any, Optional

from app.services.kidspeak import NAME, as_question, words
from app.services.narrate import _static, _statements_by_line

Level = str  # "kid" | "standard"


def _print_words(call: ast.Call) -> str:
    parts = []
    for arg in call.args:
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            parts.append(f"“{arg.value}”")
        else:
            parts.append(words(arg))
    return " and ".join(parts) if parts else "an empty line"


def _user_function(call: ast.AST, functions: set[str]) -> Optional[str]:
    if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in functions:
        return call.func.id
    return None


def kid_line(node: ast.stmt, functions: set[str], classes: frozenset[str] = frozenset()) -> str:
    """What one statement does, in a young beginner's words (no runtime values)."""
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute):
        target = node.targets[0]
        thing = words(node.value)
        if isinstance(node.value, ast.Call) and getattr(node.value.func, "id", None) in classes:
            thing = f"a new {node.value.func.id}"
        return f"Put {thing} into the {target.attr} part of {words(target.value)}."
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        name, value = node.targets[0].id, node.value
        if isinstance(value, ast.List):
            return f"Make a train called {name} with {len(value.elts)} cars."
        if isinstance(value, ast.Dict):
            return f"Make a label book called {name}."
        if isinstance(value, ast.Call) and getattr(value.func, "id", None) in ("input", "int") and (
            getattr(value.func, "id", None) == "input"
            or (value.args and isinstance(value.args[0], ast.Call) and getattr(value.args[0].func, "id", None) == "input")
        ):
            return f"Ask you a question and put your answer in the {name} box."
        if isinstance(value, ast.Call) and getattr(value.func, "id", None) in classes:
            return f"Build a new {value.func.id} from its blueprint and put it in the {name} box."
        if (fn := _user_function(value, functions)):
            return f"Do the {fn} trick and put its answer in the {name} box."
        return f"Put {words(value)} into the {name} box."
    if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
        verbs = {ast.Add: "Add {v} to", ast.Sub: "Take {v} away from", ast.Mult: "Multiply", ast.Div: "Divide"}
        name, v = node.target.id, words(node.value)
        if isinstance(node.op, ast.Mult | ast.Div):
            how = "by" if isinstance(node.op, ast.Div) else "by"
            return f"{verbs[type(node.op)]} the {name} box {how} {v}."
        return f"{verbs.get(type(node.op), 'Change').format(v=v)} the {name} box."
    if isinstance(node, ast.If):
        return f"Ask a question: {as_question(node.test)} If yes, do the lines below it."
    if isinstance(node, ast.For):
        target = ast.unparse(node.target)
        return f"Repeat the lines below once for each thing in {words(node.iter)}. Each time, the thing is called {target}."
    if isinstance(node, ast.While):
        return f"Keep repeating the lines below while the answer to this is yes: {as_question(node.test)}"
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
        args = [a.arg for a in node.args.args if a.arg != "self"]
        needs = f"It needs {', '.join(args)}." if args else "It needs nothing extra."
        return f"Teach {NAME} a new trick called {node.name}. {needs} The lines inside only run when we use the trick."
    if isinstance(node, ast.ClassDef):
        return f"Make a blueprint called {node.name} for building things later."
    if isinstance(node, ast.Return):
        return f"Give back {words(node.value)} as the trick's answer." if node.value else "Finish the trick."
    if isinstance(node, ast.Import | ast.ImportFrom):
        return f"Get extra tools: {', '.join(a.name for a in node.names)}."
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
        call = node.value
        if isinstance(call.func, ast.Name) and call.func.id == "print":
            return f"Show {_print_words(call)} on the screen."
        if isinstance(call.func, ast.Attribute) and call.func.attr == "append" and call.args:
            train = ast.unparse(call.func.value)
            return f"Add {words(call.args[0])} to the end of the {train} train."
        if (fn := _user_function(call, functions)):
            return f"Do the {fn} trick."
        return f"Do {ast.unparse(call.func)}."
    if isinstance(node, ast.Pass):
        return "Do nothing here."
    if isinstance(node, ast.Break):
        return "Stop the loop right now."
    if isinstance(node, ast.Continue):
        return "Skip to the next time around the loop."
    return _static(node)


def _line_text(node: ast.stmt, level: Level, functions: set[str], classes: frozenset[str]) -> str:
    return kid_line(node, functions, classes) if level == "kid" else _static(node) + "."


def _else_lines(source: str, tree: ast.AST) -> dict[int, str]:
    """`else:` has no statement of its own; find its line so it can be explained too."""
    lines = source.splitlines()
    found: dict[int, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.If | ast.For | ast.While) and node.orelse:
            is_elif = isinstance(node, ast.If) and len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If) \
                and lines[node.orelse[0].lineno - 1].lstrip().startswith("elif")
            if is_elif:
                continue
            body_end = max(s.end_lineno or s.lineno for s in node.body)
            for ln in range(body_end + 1, node.orelse[0].lineno + 1):
                if lines[ln - 1].lstrip().startswith("else"):
                    found[ln] = "kind:else"
                    break
    return found


def explain_program(source: str, level: Level = "kid") -> dict[str, Any]:
    """{"ok", "outline": [{line, depth, text}], "line_notes": {line: text}, "intro": str}."""
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        msg = (f"Line {exc.lineno} can't be read yet. Something is missing, like a ':' or a bracket."
               if level == "kid" else f"Line {exc.lineno} has a syntax error: {exc.msg}.")
        return {"ok": False, "intro": msg, "outline": [], "line_notes": {}}

    functions = {n.name for n in tree.body if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)}
    classes = frozenset(n.name for n in ast.walk(tree) if isinstance(n, ast.ClassDef))
    notes: dict[int, str] = {}
    for line, node in _statements_by_line(tree).items():
        notes[line] = _line_text(node, level, functions, classes)
    for line in _else_lines(source, tree):
        notes[line] = ("Otherwise (if the answer was no), do the lines below it." if level == "kid"
                       else "Otherwise: runs when the condition above is false.")

    outline: list[dict[str, Any]] = []

    def walk(stmts: list[ast.stmt], depth: int) -> None:
        for node in stmts:
            outline.append({"line": node.lineno, "depth": depth, "text": notes.get(node.lineno, _static(node))})
            if depth < 2 and isinstance(node, ast.If | ast.For | ast.While | ast.FunctionDef | ast.AsyncFunctionDef):
                walk(node.body, depth + 1)
                if isinstance(node, ast.If | ast.For | ast.While) and node.orelse:
                    if len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
                        walk(node.orelse, depth)
                    else:
                        else_line = next((ln for ln in notes if notes[ln].startswith("Otherwise")
                                          and node.body[-1].end_lineno < ln <= node.orelse[0].lineno), None)
                        if else_line:
                            outline.append({"line": else_line, "depth": depth, "text": notes[else_line]})
                        walk(node.orelse, depth + 1)

    walk(tree.body, 0)

    tricks = [n.name for n in tree.body if isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef)]
    main_steps = sum(1 for n in tree.body if not isinstance(n, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef))
    if level == "kid":
        intro = f"This program has {main_steps} main step{'s' if main_steps != 1 else ''}"
        if tricks:
            intro += f" and teaches {len(tricks)} trick{'s' if len(tricks) != 1 else ''} ({', '.join(tricks)})"
        intro += ". Here is the plan, from top to bottom:"
    else:
        intro = f"{main_steps} top-level statement{'s' if main_steps != 1 else ''}"
        if tricks:
            intro += f", {len(tricks)} function{'s' if len(tricks) != 1 else ''} ({', '.join(tricks)})"
        intro += ". Outline:"
    return {"ok": True, "intro": intro, "outline": outline[:80], "line_notes": dict(sorted(notes.items()))}
