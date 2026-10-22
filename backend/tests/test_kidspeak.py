"""Kid-mode narration: plain words, real values, gentle errors, concept tags."""


def _kid(run, source, **extra):
    _, events = run(source, **extra)
    return [(e["event"], e.get("concept"), e["kid_narration"]) for e in events]


def _find(steps, needle):
    hits = [n for _, _, n in steps if needle in n]
    assert hits, f"{needle!r} not in {[n for _, _, n in steps]}"
    return hits[0]


def test_boxes_math_and_print(run):
    steps = _kid(run, "apples = 3\napples += 2\nprint(apples)\n")
    assert steps[0][2] == "👋 Hi, I'm Robo! Let's read the code from the top, one line at a time."
    assert _find(steps, "Make a new box called apples") == "📦 Make a new box called apples: 3. Now apples holds 3."
    assert _find(steps, "Add 2 to the apples box") == "➕ Add 2 to the apples box. Now apples holds 5."
    assert _find(steps, "On the screen") == "📺 On the screen: “5”"
    assert steps[-1][2] == "🏁 All done! Robo finished the whole program. Great job!"
    concepts = {c for _, c, _ in steps if c}
    assert {"variable", "math", "print"} <= concepts


def test_lists_loops_questions_and_tricks(run):
    src = (
        "def double(n):\n"
        "    return n * 2\n"
        "\n"
        "pets = ['cat', 'dog']\n"
        "for pet in pets:\n"
        "    if pet == 'dog':\n"
        "        print(double(2))\n"
    )
    steps = _kid(run, src)
    assert _find(steps, "Teach Robo a new trick called double").endswith("only when we ask for it later!")
    assert _find(steps, "🚂") == "🚂 Make a train called pets with 2 cars: “cat” and “dog”."
    assert _find(steps, "take the next one") == "🔁 Loop: take the next one from the pets box. pet is “cat”."
    assert _find(steps, "No! So that part") == "❓ Question: is the pet box the same as the words “dog”? No! So that part is skipped."
    assert "Yes! So the part inside runs." in _find(steps, "Yes!")
    assert _find(steps, "Time for the double trick") == "🎩 Time for the double trick, using n = 2."
    assert _find(steps, "gives back the answer") == "🎁 The double trick is finished and gives back the answer 4."
    assert _find(steps, "no more in") == "🔁 There are no more in the pets box, so the loop is done."


def test_gentle_errors(run):
    steps = _kid(run, "trains = [1, 2, 3]\nprint(trains[3])\n")
    oops = _find(steps, "💥")
    assert "counting starts at 0" in oops and "cars 0, 1 and 2" in oops
    assert ("exception", "error") in [(e, c) for e, c, _ in steps]
    assert steps[-1][2] == "🛑 Robo had to stop because of a problem."


def test_input_question(run):
    steps = _kid(run, "name = input('What is your name? ')\nprint('Hi', name)\n", stdin="Mia\n")
    assert _find(steps, "asks you a question") == "❓ Robo asks you a question, and puts your answer “Mia” in the name box."
    assert _find(steps, "On the screen: “Hi Mia”")


def test_harder_code_in_plain_words(run):
    src = (
        "def fact(n):\n"
        "    if n <= 1:\n"
        "        return 1\n"
        "    return n * fact(n - 1)\n"
        "\n"
        "name = 'mia'\n"
        "shout = name.upper()\n"
        "big = [x * 10 for x in [1, 2, 3] if x > 1]\n"
        "message = f'Hi {shout}!'\n"
        "print(fact(3))\n"
    )
    steps = _kid(run, src)
    assert _find(steps, "shout").startswith("📦 Make a new box called shout: the name box in CAPITAL letters.")
    assert _find(steps, "a new list made") == (
        "📦 Make a new box called big: a new list made from each x in a list of 3 things, keeping only those "
        "where the x box is bigger than 1, turning each x into the x box times 10. Now big holds [20, 30]."
    )
    assert _find(steps, "message:").startswith("📦 Make a new box called message: the words “Hi {shout}!”, with shout filled in")
    assert _find(steps, "recursion") == "🪆 The fact trick asks itself for help (that's called recursion), using n = 2. It's now 2 tricks deep!"
    assert not any(n == f"📖 Reading line {i}." for i in range(20) for _, _, n in steps)


def test_blueprint_building(run):
    steps = _kid(run, "class Dog:\n    def __init__(self, name):\n        self.name = name\n\nrex = Dog('Rex')\n")
    assert _find(steps, "Building a new") == "🏗️ Building a new Dog from its blueprint, using name = “Rex”."
    assert _find(steps, "into the name part") == "📖 Put the name box into the name part of the self box."
