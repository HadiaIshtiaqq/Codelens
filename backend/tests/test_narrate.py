"""One-line narration attached to every trace step."""

from app.services.narrate import line_notes


def _narrations(run, source):
    _, events = run(source)
    return [(e["event"], e["line"], e["narration"]) for e in events]


def _find(narr, needle):
    hits = [n for _, _, n in narr if needle in n]
    assert hits, f"{needle!r} not in {[n for _, _, n in narr]}"
    return hits[0]


def test_every_event_is_narrated(run):
    narr = _narrations(run, "x = 1\nprint(x)\n")
    assert all(n for _, _, n in narr)
    assert narr[0][2] == "▶ The program starts running from the top"
    assert _find(narr, "Sets x to 1") == "Sets x to 1 → x = 1"
    assert _find(narr, "Prints '1'")
    assert narr[-1][2] == "🏁 The program finished successfully"


def test_loops_conditions_augassign_and_returns(run):
    src = (
        "def total_of(xs):\n"
        "    total = 0\n"
        "    for x in xs:\n"
        "        if x > 1:\n"
        "            total += x\n"
        "    return total\n"
        "\n"
        "result = total_of([1, 5])\n"
    )
    narr = _narrations(run, src)
    assert _find(narr, "Enters total_of()") == "Enters total_of() with xs = [1, 5]"
    assert _find(narr, "takes the next value") == "Loop: x takes the next value from xs → x = 1"
    assert _find(narr, "→ False") == "Checks if x > 1 → False"
    assert _find(narr, "→ True") == "Checks if x > 1 → True"
    assert _find(narr, "Adds x to total") == "Adds x to total → total = 5"
    assert _find(narr, "is finished") == "Loop over xs is finished: no values left"
    assert _find(narr, "Returns total") == "Returns total = 5"
    assert _find(narr, "hands back") == "total_of() is done and hands back 5"
    assert _find(narr, "stores the result in result").endswith("→ result = 5")


def test_crash_and_while(run):
    narr = _narrations(run, "n = 2\nwhile n > 0:\n    n -= 1\nprint(10 / n)\n")
    assert _find(narr, "repeats while") == "Loop: repeats while n > 0 → True"
    assert _find(narr, "False, so the loop ends")
    assert _find(narr, "💥 Crash! ZeroDivisionError: division by zero")


def test_line_notes_static():
    notes = line_notes("import math\n\ndef area(r):\n    return math.pi * r ** 2\n\nitems = []\nitems.append(area(2))\n")
    assert notes[1] == "Imports math"
    assert notes[3] == "Defines function area(r); its body runs only when it is called"
    assert notes[4] == "Returns math.pi * r ** 2"
    assert notes[7] == "Appends area(2) to items"
    assert line_notes("def broken(:\n") == {}


def test_line_notes_in_response(client):
    body = client.post("/api/v1/executions", json={"source_code": "a = 1\nb = a + 1\n"}).json()
    assert body["line_notes"] == {"1": "Sets a to 1", "2": "Sets b to a + 1"}


def test_class_body_narration(run):
    narr = _narrations(run, "class Point:\n    def __init__(self, x):\n        self.x = x\n\np = Point(3)\n")
    assert _find(narr, "building class") == "Starts building class Point: collects its methods"
    assert _find(narr, "ready to use") == "Class Point is ready to use"
    assert _find(narr, "Enters __init__()") == "Enters __init__() with self = <Point object>, x = 3"


def test_rich_expressions():
    notes = line_notes(
        "xs = [1, 2, 3]\n"
        "evens = [x * 2 for x in xs if x > 1]\n"
        "square = lambda n: n * n\n"
        "label = 'big' if len(xs) > 2 else 'small'\n"
        "if __name__ == '__main__':\n"
        "    pass\n"
    )
    assert notes[2] == "Sets evens: builds a list from each x in xs where x > 1"
    assert notes[3] == "Sets square: creates a small unnamed function of (n) that returns n * n"
    assert notes[4] == "Sets label: picks 'big' if len(xs) > 2, otherwise 'small'"
    assert notes[5] == "Checks whether this file is being run directly (not imported)"
