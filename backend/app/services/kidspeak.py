"""Kid-friendly narration: every trace step explained for an 8-year-old with no coding background.

Same evidence rules as narrate.py (syntax tree + real recorded values, nothing
invented), but in everyday words and metaphors:
  variable -> a labeled box        list -> a train of numbered cars
  function -> a trick that Robo (the robot helper) learns and then does
  if       -> a yes/no question     loop -> doing something again and again
Each step also gets a `concept` tag so the UI can introduce a new idea the first
time it appears.
"""

import ast
import re
from typing import Any, Optional

from app.services.narrate import _Narrator, _body_span, _target_names
from app.services.turtlespeak import turtle_sentence

# The helper's name. Used sparingly: most sentences describe the code, not the helper.
NAME = "Robo"

MAX_WORDS_VALUE = 40

_OPS = {
    ast.Add: "plus", ast.Sub: "minus", ast.Mult: "times", ast.Div: "divided by",
    ast.FloorDiv: "divided by (keeping only the whole number)", ast.Mod: "and the remainder after dividing by",
    ast.Pow: "to the power of",
}
_AUG = {
    ast.Add: ("Add {v} to the {n} box", "Now {n} holds {a}."),
    ast.Sub: ("Take {v} away from the {n} box", "Now {n} holds {a}."),
    ast.Mult: ("Multiply the {n} box by {v}", "Now {n} holds {a}."),
    ast.Div: ("Divide the {n} box by {v}", "Now {n} holds {a}."),
}
_CMP = {
    ast.Gt: "bigger than", ast.Lt: "smaller than", ast.GtE: "at least", ast.LtE: "at most",
    ast.Eq: "the same as", ast.NotEq: "different from", ast.In: "inside", ast.NotIn: "not inside",
    ast.Is: "exactly", ast.IsNot: "not exactly",
}

# Gentle explanations of common errors: what happened, and what to try.
_OOPS = {
    "ZeroDivisionError": "Oops! You can't divide by zero. That's impossible, like sharing cookies among 0 friends! "
                         "Try dividing by a number that isn't 0.",
    "IndexError": "Oops! That car number isn't in the train. Remember: counting starts at 0, "
                  "so a train with 3 cars has cars 0, 1 and 2.",
    "KeyError": "Oops! That label isn't in the dictionary. Check the spelling, or add it first.",
    "NameError": "Oops! There's no box with that name. Maybe it's a typo, or the box wasn't made yet.",
    "TypeError": "Oops! Those things don't mix, like adding a word to a number.",
    "ValueError": "Oops! That value can't be used here, like turning the word 'cat' into a number.",
    "AttributeError": "Oops! That box doesn't have the thing we asked for.",
    "RecursionError": "Oops! The trick kept asking for itself again and again and never stopped.",
    "EOFError": "Oops! A question was asked, but there were no more answers. Type your answers in the answers box.",
    "UnboundLocalError": "Oops! Inside the trick, a box was read before anything was put in it.",
    "SyntaxError": "Oops! This line can't be read. Something is missing, like a ':' or a bracket.",
    "IndentationError": "Oops! The spaces at the start of a line don't line up. Lines inside an if, loop or trick move right together.",
    "TimeoutError": "Still going after 5 seconds, so we stopped. A loop might never end!",
}


def _box(name: str) -> str:
    return f"the {name} box"


def _friendly_list(text: str) -> str:
    """"['cat', 'dog', 'fish']" -> “cat”, “dog” and “fish” (falls back to the raw text)."""
    try:
        items = ast.literal_eval(text)
    except (ValueError, SyntaxError, MemoryError, RecursionError):
        return text
    if not isinstance(items, list | tuple) or not items or len(items) > 8:
        return text
    parts = [f"“{i}”" if isinstance(i, str) else str(i) for i in items]
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def _show(text: Optional[str]) -> str:
    """A recorded value, readable: 'hello' -> “hello”, True -> yes."""
    if text is None:
        return "?"
    if text in ("True", "False"):
        return {"True": "True (yes)", "False": "False (no)"}[text]
    if text == "None":
        return "nothing (None)"
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        text = f"“{text[1:-1]}”"
    return text if len(text) <= MAX_WORDS_VALUE else text[: MAX_WORDS_VALUE - 1] + "…"


def words(node: ast.AST) -> str:
    """An expression in plain words."""
    try:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, str):
                return f"the words “{node.value[:30]}”"
            if isinstance(node.value, bool):
                return "yes (True)" if node.value else "no (False)"
            if node.value is None:
                return "nothing"
            return f"{node.value}"
        if isinstance(node, ast.Name):
            return _box(node.id)
        if isinstance(node, ast.BinOp):
            return f"{words(node.left)} {_OPS.get(type(node.op), 'combined with')} {words(node.right)}"
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            return f"{words(node.left)} is {_CMP.get(type(node.ops[0]), 'compared with')} {words(node.comparators[0])}"
        if isinstance(node, ast.BoolOp):
            joiner = " and " if isinstance(node.op, ast.And) else " or "
            return joiner.join(words(v) for v in node.values)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return f"not ({words(node.operand)})"
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return f"minus {words(node.operand)}"
        if isinstance(node, ast.List | ast.Tuple):
            return f"a list of {len(node.elts)} things"
        if isinstance(node, ast.Dict):
            return f"a dictionary with {len(node.keys)} labels"
        if isinstance(node, ast.Subscript):
            index = node.slice
            if isinstance(index, ast.Constant) and isinstance(index.value, int):
                return f"item {index.value} of {words(node.value)}"
            return f"what {words(node.value)} has for {words(index)}"
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name):
                if fn.id == "len" and node.args:
                    return f"how many things are in {words(node.args[0])}"
                if fn.id == "range" and node.args:
                    if len(node.args) == 1:
                        return f"the numbers from 0 up to (not including) {words(node.args[0])}"
                    return f"the numbers from {words(node.args[0])} up to (not including) {words(node.args[1])}"
                if fn.id == "input":
                    return "your answer to a question"
                if fn.id in ("int", "float") and node.args:
                    return f"{words(node.args[0])} turned into a number"
                if fn.id == "str" and node.args:
                    return f"{words(node.args[0])} turned into words"
                if fn.id in ("sum", "max", "min") and node.args:
                    label = {"sum": "all of", "max": "the biggest of", "min": "the smallest of"}[fn.id]
                    return f"{label} {words(node.args[0])} {'added up' if fn.id == 'sum' else ''}".strip()
                return f"the answer from the {fn.id} trick"
            if isinstance(fn, ast.Attribute):
                return _method_words(fn.attr, fn.value, node.args)
        if isinstance(node, ast.JoinedStr):
            text, boxes = "", []
            for part in node.values:
                if isinstance(part, ast.Constant):
                    text += str(part.value)
                elif isinstance(part, ast.FormattedValue):
                    inner = ast.unparse(part.value)
                    text += "{" + inner + "}"
                    boxes.append(inner)
            filled = f", with {' and '.join(boxes)} filled in from the boxes" if boxes else ""
            return f"the words “{text[:40]}”{filled}"
        if isinstance(node, ast.ListComp | ast.GeneratorExp | ast.SetComp):
            gen = node.generators[0]
            item = ast.unparse(gen.target)
            keep = f", keeping only those where {words(gen.ifs[0])}" if gen.ifs else ""
            made = "" if ast.unparse(node.elt) == item else f", turning each {item} into {words(node.elt)}"
            return f"a new list made from each {item} in {words(gen.iter)}{keep}{made}"
        if isinstance(node, ast.DictComp):
            return f"a new label book made from each thing in {words(node.generators[0].iter)}"
        if isinstance(node, ast.IfExp):
            return f"{words(node.body)} if {words(node.test)}, otherwise {words(node.orelse)}"
        if isinstance(node, ast.Attribute):
            return f"the {node.attr} part of {words(node.value)}"
    except RecursionError:
        pass
    text = ast.unparse(node)
    return f"“{text}”" if len(text) <= 30 else "a calculation"


_METHODS = {
    "upper": "{obj} in CAPITAL letters",
    "lower": "{obj} in small letters",
    "strip": "{obj} without spaces at the ends",
    "split": "{obj} cut into separate words",
    "title": "{obj} with each word starting with a capital",
    "count": "how many times {arg} is in {obj}",
    "index": "where {arg} is in {obj}",
    "replace": "{obj} with {arg} swapped for something else",
    "join": "the things in {arg} joined together",
    "get": "what {obj} has for the label {arg}",
    "pop": "the last car taken off {obj}",
    "keys": "all the labels in {obj}",
    "values": "all the values in {obj}",
    "items": "each label and value in {obj}",
}


def _method_words(method: str, obj: ast.AST, args: list[ast.AST]) -> str:
    template = _METHODS.get(method)
    arg = words(args[0]) if args else ""
    if template:
        return template.format(obj=words(obj), arg=arg)
    return f"the {method} trick of {words(obj)}"


def as_question(test: ast.AST) -> str:
    """A condition phrased as a yes/no question."""
    if isinstance(test, ast.Compare) and len(test.ops) == 1:
        how = _CMP.get(type(test.ops[0]), "compared with")
        return f"is {words(test.left)} {how} {words(test.comparators[0])}?"
    if isinstance(test, ast.Name):
        return f"is {_box(test.id)} true?"
    return f"is it true that {words(test)}?"


def concept_of(node: Optional[ast.stmt]) -> Optional[str]:
    """Which idea this statement teaches (for the 'new idea' cards)."""
    if node is None:
        return None
    if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
        return "function"
    if isinstance(node, ast.ClassDef):
        return "class"
    if isinstance(node, ast.For):
        return "for-loop"
    if isinstance(node, ast.While):
        return "while-loop"
    if isinstance(node, ast.If):
        return "if"
    if isinstance(node, ast.Return):
        return "return"
    if isinstance(node, ast.Import | ast.ImportFrom):
        return "import"
    if isinstance(node, ast.AugAssign):
        return "math"
    if isinstance(node, ast.Assign):
        value = node.value
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "input":
            return "input"
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == "int" and value.args \
                and isinstance(value.args[0], ast.Call) and getattr(value.args[0].func, "id", None) == "input":
            return "input"
        if isinstance(value, ast.List | ast.ListComp):
            return "list"
        if isinstance(value, ast.Dict):
            return "dictionary"
        if isinstance(value, ast.BinOp):
            return "math"
        return "variable"
    if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
        fn = node.value.func
        if isinstance(fn, ast.Name) and fn.id == "print":
            return "print"
        if isinstance(fn, ast.Attribute) and fn.attr == "append":
            return "list"
        return "call"
    return None


class KidNarrator(_Narrator):
    def kid(self, k: int) -> tuple[str, Optional[str]]:
        ev = self.events[k]
        kind = ev["event"]
        in_main = ev.get("file", "main.py") == "main.py"
        if kind == "call":
            if ev["function"] == "<module>":
                if in_main:
                    return f"👋 Hi, I'm {NAME}! Let's read the code from the top, one line at a time.", None
                return f"📦 Open the {ev['file']} toolbox and read it.", "import"
            if self.class_lines.get((ev.get("file", "main.py"), ev["line"])) == ev["function"]:
                self.building.append(ev["function"])
                return f"🏗️ Read the blueprint for {ev['function']}.", "class"
            args = [f"{n} = {_show(ev['locals'].get(n))}" for n in ev.get("arg_names", []) if n in ev["locals"]
                    and n != "self"]
            using = f", using {', '.join(args)}" if args else ""
            if ev["function"] == "__init__":
                kind = (ev.get("local_types") or {}).get("self", "thing")
                return f"🏗️ Building a new {kind} from its blueprint{using}.", "class"
            stack = [f["function"] for f in (ev.get("viz") or {}).get("stack", [])]
            if stack.count(ev["function"]) > 1:
                return (f"🪆 The {ev['function']} trick asks itself for help (that's called recursion)"
                        f"{using}. It's now {stack.count(ev['function'])} tricks deep!"), "function-call"
            return f"🎩 Time for the {ev['function']} trick{using}.", "function-call"
        if kind == "return":
            if ev["function"] == "<module>":
                return ("✅ That was the last line of the code." if in_main
                        else f"📦 Done reading {ev['file']}."), None
            if self.building and self.building[-1] == ev["function"]:
                self.building.pop()
                return f"🏗️ The {ev['function']} blueprint is ready.", "class"
            value = ev.get("return_value")
            if value in (None, "None"):
                return f"🎩 The {ev['function']} trick is finished. Back to where we were.", "return"
            return f"🎁 The {ev['function']} trick is finished and gives back the answer {_show(value)}.", "return"
        if kind == "exception":
            exc = ev["exception"]
            if not self.crashed_once:
                self.crashed_once = True
                return "💥 " + _OOPS.get(exc["type"], f"Oops! Something went wrong: {exc['message']}."), "error"
            return f"💥 The problem is still there, so the {ev['function']} part stops too.", "error"
        if kind == "stdout":
            said = ev["stdout_chunk"].rstrip("\n")
            return (f"📺 On the screen: “{said}”" if said else "📺 An empty line on the screen."), "print"
        if kind == "exit":
            if ev.get("exit_code") == 0:
                return f"🏁 All done! {NAME} finished the whole program. Great job!", None
            return f"🛑 {NAME} had to stop because of a problem.", None
        return self._kid_line(k)

    def _kid_line(self, k: int) -> tuple[str, Optional[str]]:
        ev = self.events[k]
        node = self.stmts_by_file.get(ev.get("file", "main.py"), {}).get(ev["line"])
        concept = concept_of(node)
        if node is None:
            return f"📖 Reading line {ev['line']}.", None
        if (drawing := turtle_sentence(node, kid=True)):
            return drawing, "turtle"
        after = self._after(k)
        after_locals = after["locals"] if after else {}
        before = ev.get("locals", {})

        def holds(name: str) -> str:
            return f" Now {name} holds {_show(after_locals[name])}." if name in after_locals else ""

        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name, value = node.targets[0].id, node.value
            new = name not in before
            if concept == "input":
                answer = _show(after_locals.get(name))
                return (f"❓ {NAME} asks you a question, and puts your answer {answer} in the {name} box.", "input")
            if isinstance(value, ast.List):
                shown = after_locals.get(name)
                return (f"🚂 {'Make' if new else 'Replace'} a train called {name} with {len(value.elts)} cars"
                        + (f": {_friendly_list(shown)}." if shown else "."), "list")
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id not in ("len", "int", "float", "str", "sum", "max", "min", "range", "input"):
                return (f"🎩 Ask the {value.func.id} trick for an answer and put it in the {name} box.{holds(name)}",
                        "function-call")
            if isinstance(value, ast.Name):
                return (f"📦 Make {name} point to the same thing as {value.id}.{holds(name)}", "variable")
            verb = "Make a new box called" if new else "Put a new value into the box"
            return (f"📦 {verb} {name}: {words(value)}.{holds(name)}", concept)
        if isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
            first, second = _AUG.get(type(node.op), ("Change the {n} box using {v}", "Now {n} holds {a}."))
            text = first.format(n=name, v=words(node.value)) + ". "
            if name in after_locals:
                text += second.format(n=name, a=_show(after_locals[name]))
            return f"➕ {text}".strip(), "math"
        if isinstance(node, ast.If | ast.While):
            question = f"❓ Question: {as_question(node.test)}"
            if after and after["event"] in ("line", "return"):
                start, end = _body_span(node.body)
                yes = after["event"] == "line" and start <= after["line"] <= end
                if isinstance(node, ast.While):
                    return (question + (" Yes! So the loop goes again." if yes
                                        else " No! So the loop stops."), "while-loop")
                return question + (" Yes! So the part inside runs." if yes
                                   else " No! So that part is skipped."), "if"
            return question, concept
        if isinstance(node, ast.For):
            names = _target_names(node.target)
            if after and after["event"] in ("line", "return"):
                start, end = _body_span(node.body)
                if after["event"] == "line" and start <= after["line"] <= end:
                    shown = ", ".join(f"{n} is {_show(after_locals.get(n))}" for n in names if n in after_locals)
                    return f"🔁 Loop: take the next one from {words(node.iter)}. {shown}.".replace(". .", "."), "for-loop"
                return f"🔁 There are no more in {words(node.iter)}, so the loop is done.", "for-loop"
            return f"🔁 Loop: go through {words(node.iter)}, one at a time.", "for-loop"
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            return (f"🎓 Teach {NAME} a new trick called {node.name}. It won't run yet, "
                    "only when we ask for it later!", "function")
        if isinstance(node, ast.ClassDef):
            return f"🏗️ Make a blueprint called {node.name}, for building things later.", "class"
        if isinstance(node, ast.Return):
            if node.value is None:
                return "🎁 The trick is done.", "return"
            ret = self.events[k + 1] if k + 1 < len(self.events) else None
            value = f" The answer is {_show(ret.get('return_value'))}." if ret and ret["event"] == "return" else ""
            return f"🎁 Give back {words(node.value)} as the answer.{value}", "return"
        if isinstance(node, ast.Import | ast.ImportFrom):
            names = ", ".join(a.name for a in node.names)
            return f"🧰 Get extra tools: {names}.", "import"
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            fn = node.value.func
            if isinstance(fn, ast.Name) and fn.id == "print":
                return "📺 Something is about to show on the screen.", "print"
            if isinstance(fn, ast.Attribute) and fn.attr == "append" and node.value.args:
                obj = words(fn.value).replace("the ", "", 1).replace(" box", "")
                return f"🚃 Add a new car to the end of the {obj} train: {words(node.value.args[0])}.", "list"
            name = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", "a")
            return f"🎩 Do the {name} trick.", "call"
        if isinstance(node, ast.Pass):
            return "😴 Do nothing here (pass means 'skip').", None
        if isinstance(node, ast.Break):
            return "🚪 Jump out of the loop right now.", "for-loop"
        from app.services.explain_static import kid_line  # local import: explain_static imports this module

        functions = {n for n, in ((getattr(x, "name", None),) for x in self.stmts_by_file.get(ev.get("file", "main.py"), {}).values()) if n}
        return f"📖 {kid_line(node, functions)}", concept


def annotate_kids(sources: dict[str, str], events: list[dict[str, Any]]) -> None:
    """Add `kid_narration` and `concept` to every event, in place."""
    narrator = KidNarrator(sources, events)
    for k, ev in enumerate(events):
        try:
            text, concept = narrator.kid(k)
        except Exception:  # noqa: BLE001 - narration must never break a run
            text, concept = f"📖 Reading line {ev.get('line', '?')}.", None
        ev["kid_narration"] = re.sub(r"\s+", " ", text).strip()
        if concept:
            ev["concept"] = concept
