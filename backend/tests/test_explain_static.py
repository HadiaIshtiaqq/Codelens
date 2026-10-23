"""Program plans and per-line notes, built without running the code."""

from app.services.explain_static import explain_program

PETS = (
    "def greet(name):\n"
    "    return 'Hi ' + name\n"
    "\n"
    "pets = ['cat', 'dog']\n"
    "for pet in pets:\n"
    "    if pet == 'dog':\n"
    "        print(greet(pet))\n"
    "    else:\n"
    "        print('not a dog')\n"
    "count = 0\n"
    "count += 1\n"
)


def test_kid_plan_and_line_notes(client):
    body = client.post("/api/v1/explain-code", json={"source_code": PETS}).json()
    assert body["ok"] is True
    assert body["intro"] == "This program has 4 main steps and teaches 1 trick (greet). Here is the plan, from top to bottom:"
    notes = body["line_notes"]
    assert notes["1"] == "Teach Robo a new trick called greet. It needs name. The lines inside only run when we use the trick."
    assert notes["2"] == "Give back the words “Hi ” plus the name box as the trick's answer."
    assert notes["4"] == "Make a train called pets with 2 cars."
    assert notes["5"].startswith("Repeat the lines below once for each thing in the pets box. Each time, the thing is called pet.")
    assert notes["6"] == "Ask a question: is the pet box the same as the words “dog”? If yes, do the lines below it."
    assert notes["7"] == "Show the answer from the greet trick on the screen."
    assert notes["8"] == "Otherwise (if the answer was no), do the lines below it."
    assert notes["9"] == "Show “not a dog” on the screen."
    assert notes["11"] == "Add 1 to the count box."
    outline = [(o["line"], o["depth"]) for o in body["outline"]]
    assert outline[:6] == [(1, 0), (2, 1), (4, 0), (5, 0), (6, 1), (7, 2)]
    assert (8, 1) in outline and (9, 2) in outline


def test_standard_level(client):
    body = client.post("/api/v1/explain-code", json={"source_code": PETS, "level": "standard"}).json()
    assert body["intro"].startswith("Module with 4 top-level statements and 1 function (greet())")
    assert body["line_notes"]["5"] == "Loop: pet takes each value from pets."


def test_unparseable_code_is_explained_kindly(client):
    body = client.post("/api/v1/explain-code", json={"source_code": "for x in range(3)\n    print(x)\n"}).json()
    assert body["ok"] is False and "Line 1" in body["intro"] and "':'" in body["intro"]


def test_blueprints(client):
    src = "class Node:\n    pass\n\nhead = Node()\nhead.next = Node()\n"
    notes = client.post("/api/v1/explain-code", json={"source_code": src}).json()["line_notes"]
    assert notes["4"] == "Build a new Node from its blueprint and put it in the head box."
    assert notes["5"] == "Put a new Node into the next part of the head box."


def test_input_and_tricks(client):
    src = "def double(n):\n    return n * 2\nage = int(input('Age? '))\nresult = double(age)\n"
    notes = client.post("/api/v1/explain-code", json={"source_code": src}).json()["line_notes"]
    assert notes["3"] == "Ask you a question and put your answer in the age box."
    assert notes["4"] == "Do the double trick and put its answer in the result box."


DESCRIBE = 'def describe(name, age):\n    return name + " is " + age + " years old"\n\n\nprint(describe("Ada", 36))\n'


def test_each_view_explains_the_program_in_its_own_voice():
    kid, game, classic = (explain_program(DESCRIBE, level) for level in ("kid", "game", "classic"))
    assert kid["intro"].startswith("This program has 1 main step and teaches 1 trick")
    assert game["intro"].startswith("🗺️ Quest map: 1 move and 1 skill")
    assert classic["intro"].startswith("Module with 1 top-level statement and 1 function (describe())")
    assert game["line_notes"][1].startswith("🎓 ") and classic["line_notes"][1].startswith("Defines function describe")
    assert explain_program(DESCRIBE, "standard")["intro"] == classic["intro"]  # old name still accepted


def test_text_plus_number_is_flagged_before_running():
    for level, phrase in (("kid", "glues the words"), ("game", "Trap on line 2"), ("classic", "str + int concatenation")):
        warnings = explain_program(DESCRIBE, level)["warnings"]
        assert len(warnings) == 1 and warnings[0]["line"] == 2 and phrase in warnings[0]["text"]
        assert "age" in warnings[0]["text"] and "36" in warnings[0]["text"]
    assert explain_program('print("a" + str(3))\nx = 2\nprint("b" + "c")\n', "classic")["warnings"] == []
    assert explain_program('n = 5\nprint("n is " + n)\n', "classic")["warnings"][0]["line"] == 2


def test_endless_loop_is_flagged_before_running():
    warnings = explain_program("count = 10\nwhile count > 0:\n    count += 1\n", "game")["warnings"]
    assert warnings and "Endless loop on line 2" in warnings[0]["text"]
    assert explain_program("count = 10\nwhile count > 0:\n    count -= 1\n", "game")["warnings"] == []
