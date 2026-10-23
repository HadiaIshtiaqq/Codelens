"""`import turtle` in the sandbox: drawing ops recorded on the steps that made them."""

import ast

from app.services.turtlespeak import turtle_sentence


def _ops(events):
    return [(e["line"], op) for e in events for op in e.get("draw") or []]


def test_square_is_recorded_as_moves_on_the_lines_that_made_them(run):
    src = (
        "import turtle\n"
        "t = turtle.Turtle()\n"
        "t.pencolor('red')\n"
        "for i in range(4):\n"
        "    t.forward(100)\n"
        "    t.left(90)\n"
    )
    body, events = run(src)
    assert body["status"] == "completed", body
    ops = _ops(events)
    moves = [op for line, op in ops if line == 5]
    assert len(moves) == 4 and all(op["k"] == "mv" and op["d"] and op["c"] == "red" for op in moves)
    corners = {(round(op["x"]), round(op["y"])) for op in moves}
    assert corners == {(100, 0), (100, 100), (0, 100), (0, 0)}  # y up, left() turns anticlockwise
    turns = [op for line, op in ops if line == 6]
    assert [op["h"] for op in turns] == [90, 180, 270, 0]


def test_module_functions_fill_colours_and_repr(run):
    src = (
        "from turtle import *\n"
        "colormode(255)\n"
        "color((255, 0, 0), 'yellow')\n"
        "begin_fill()\n"
        "circle(30)\n"
        "end_fill()\n"
        "penup()\n"
        "goto(0, -80)\n"
        "write('hi')\n"
        "t = Turtle()\n"
        "print(t)\n"
        "done()\n"
    )
    body, events = run(src)
    assert body["status"] == "completed", body
    kinds = {op["k"] for _, op in _ops(events)}
    assert {"mv", "fill", "text"} <= kinds
    fill = next(op for _, op in _ops(events) if op["k"] == "fill")
    assert fill["c"] == "yellow" and len(fill["pts"]) > 10
    pen_up_move = next(op for line, op in _ops(events) if line == 8)
    assert pen_up_move["d"] is False
    assert body["stdout"] == "<turtle at (0, 0) facing 0°>\n"


def test_bad_colour_is_a_normal_python_error(run):
    body, _ = run("import turtle\nturtle.pencolor((300, 0, 0))\n")
    assert body["error"]["type"] == "ValueError"
    assert body["error"]["line"] == 2


def test_turtle_steps_get_drawing_sentences(run):
    _, events = run("import turtle\nt = turtle.Turtle()\nt.forward(50)\nt.penup()\n")
    by_line = {e["line"]: e for e in events if e["event"] == "line"}
    assert by_line[3]["narration"] == "Moves the turtle forward 50 steps"
    assert by_line[3]["kid_narration"] == "🐢 Walk forward 50 steps."
    assert by_line[2]["kid_narration"].startswith("🐢 Make a new turtle called t")
    assert by_line[4]["kid_narration"].startswith("✋ Lift the pen")


def test_only_clear_turtle_commands_are_matched():
    def sentence(code):
        return turtle_sentence(ast.parse(code).body[0], kid=False)

    assert sentence("t.fd(10)") == "Moves the turtle forward 10 steps"
    assert sentence("turtle.write('x')") == "Writes x on the drawing"
    assert sentence("f.write('x')") is None  # a file, not a turtle
    assert sentence("items.append(3)") is None
