"""Plain-English sentences for turtle drawing commands (standard and kid wording).

Only calls that are clearly turtle commands are matched: anything on the `turtle`
module itself, or a method whose name only turtles use (forward, penup, begin_fill…).
Ambiguous names such as write() or color() count only when called on the module.
"""

import ast
from typing import Optional

# name -> (standard template, kid template); {a} is the first argument, {b} the second.
_COMMANDS: dict[str, tuple[str, str]] = {
    "forward": ("Moves the turtle forward {a} steps", "🐢 Walk forward {a} steps."),
    "backward": ("Moves the turtle backward {a} steps", "🐢 Walk backwards {a} steps."),
    "left": ("Turns the turtle left by {a}°", "↪️ Turn left {a} degrees."),
    "right": ("Turns the turtle right by {a}°", "↩️ Turn right {a} degrees."),
    "goto": ("Moves the turtle straight to ({a}, {b})", "🎯 Walk straight to the spot ({a}, {b})."),
    "setheading": ("Points the turtle at {a}° (0 = east, 90 = north)", "🧭 Face the direction {a} degrees."),
    "home": ("Sends the turtle back to the centre, facing east", "🏠 Go back to the middle."),
    "circle": ("Draws a circle of radius {a}", "⭕ Walk around in a circle, {a} steps from the middle."),
    "dot": ("Draws a dot", "🔴 Put a dot here."),
    "stamp": ("Stamps a copy of the turtle's shape", "🖨️ Stamp a turtle picture here."),
    "penup": ("Lifts the pen: the turtle moves without drawing", "✋ Lift the pen: now the turtle walks without drawing."),
    "pendown": ("Puts the pen down: the turtle draws as it moves", "✏️ Put the pen down: now the turtle draws as it walks."),
    "pensize": ("Sets the pen width to {a}", "🖊️ Make the pen {a} thick."),
    "pencolor": ("Sets the pen colour to {a}", "🎨 Draw with {a} now."),
    "fillcolor": ("Sets the fill colour to {a}", "🪣 Get {a} paint ready for filling in."),
    "color": ("Sets the pen and fill colours", "🎨 Pick colours for the pen and the paint."),
    "begin_fill": ("Starts a shape to fill in", "🪣 Start a shape to colour in."),
    "end_fill": ("Fills in the shape drawn since begin_fill()", "🪣 Pour the paint in: the shape gets coloured!"),
    "hideturtle": ("Hides the turtle", "🙈 Hide the turtle."),
    "showturtle": ("Shows the turtle", "👀 Show the turtle."),
    "bgcolor": ("Sets the background colour to {a}", "🖼️ Paint the background {a}."),
    "write": ("Writes {a} on the drawing", "✍️ Write {a} on the picture."),
    "speed": ("Sets the turtle's speed (the replay speed is set by the controls)", "⏩ Choose how fast the turtle walks."),
    "shape": ("Changes the turtle's shape", "🐢 Pick how the turtle looks."),
    "clear": ("Clears this turtle's drawing", "🧽 Wipe the drawing clean."),
    "done": ("Finishes the drawing", "🏁 The drawing is finished!"),
}
_ALIASES = {
    "fd": "forward", "bk": "backward", "back": "backward", "lt": "left", "rt": "right",
    "setpos": "goto", "setposition": "goto", "seth": "setheading", "pu": "penup", "up": "penup",
    "pd": "pendown", "down": "pendown", "width": "pensize", "ht": "hideturtle", "st": "showturtle",
    "mainloop": "done", "exitonclick": "done",
}
# Names that only turtles use as methods, so `anything.<name>(...)` is a turtle command.
_DISTINCTIVE = {
    "forward", "fd", "backward", "bk", "left", "lt", "right", "rt", "goto", "setpos", "setposition",
    "setheading", "seth", "circle", "dot", "stamp", "penup", "pu", "pendown", "pd", "pensize",
    "pencolor", "fillcolor", "begin_fill", "end_fill", "hideturtle", "showturtle", "bgcolor", "exitonclick",
    "color", "speed", "shape",
}


def _arg(call: ast.Call, i: int) -> str:
    if i >= len(call.args):
        return "?"
    node = call.args[i]
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return ast.unparse(node)


def _command(call: ast.Call) -> Optional[str]:
    fn = call.func
    if isinstance(fn, ast.Attribute):
        name = fn.attr
        on_module = isinstance(fn.value, ast.Name) and fn.value.id == "turtle"
        if not on_module and name not in _DISTINCTIVE:
            return None
    elif isinstance(fn, ast.Name) and fn.id in _DISTINCTIVE:  # from turtle import *
        name = fn.id
    else:
        return None
    name = _ALIASES.get(name, name)
    return name if name in _COMMANDS else None


def is_new_turtle(value: ast.AST) -> bool:
    """`turtle.Turtle()` / `Turtle()` / `turtle.Pen()`."""
    if not isinstance(value, ast.Call):
        return False
    fn = value.func
    name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", None)
    return name in ("Turtle", "Pen", "RawTurtle")


def turtle_sentence(node: ast.stmt, kid: bool) -> Optional[str]:
    """A sentence for a turtle statement, or None if the statement isn't one."""
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        if is_new_turtle(node.value):
            name = node.targets[0].id
            return (f"🐢 Make a new turtle called {name}. It draws a line wherever it walks!" if kid
                    else f"Creates a turtle {name}: a pen that draws as it moves")
        if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and node.value.func.attr == "Screen":
            return "🖼️ Get the drawing paper ready." if kid else f"Gets the drawing screen as {node.targets[0].id}"
        return None
    if not (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)):
        return None
    command = _command(node.value)
    if command is None:
        return None
    template = _COMMANDS[command][1 if kid else 0]
    return template.format(a=_arg(node.value, 0), b=_arg(node.value, 1))
