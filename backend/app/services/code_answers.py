"""Answer an open question about a program from the code itself ("how is the path calculated?").

The question's words are matched against the code (names split at underscores, words in strings);
the best lines are read out in program order with their plain-English notes. Nothing is
generated, so the answer can only describe what the code really contains.
"""

import re
from typing import Any

from app.services.explain_static import explain_program

_STOP = set("""
a an and are as at be by can code could did do does doing for from get gets got has have how i if in into is it
its let lets me my of on or please program show so tell than that the their them then there this to up was way
what when where which while who why will with work works would you your according calculate calculated
calculates calculating compute computed computes find found make made happen happens line lines explain
""".split())


def _stem(word: str) -> str:
    for suffix in ("ing", "ed", "es", "s"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def _parts(text: str) -> list[str]:
    parts = re.findall(r"[a-z][a-z0-9]*", re.sub(r"([a-z])([A-Z])", r"\1 \2", text).replace("_", " ").lower())
    return [p for p in parts if p not in _STOP and len(p) > 1]


def _words(text: str) -> set[str]:
    return {_stem(p) for p in _parts(text)}


def answer(source: str, question: str) -> dict[str, Any]:
    """{"speech", "lines": [{line, code, note}], "line": first relevant line or None, "found": bool}."""
    plan = explain_program(source, "classic")
    if not plan["ok"]:
        return {"speech": plan["intro"], "lines": [], "line": None, "found": False}
    wanted = _words(question)
    spoken = {_stem(p): p for p in _parts(question)}  # say "visited", not the stem "visit"
    code_lines = source.splitlines()
    scored: list[tuple[int, int]] = []
    notes = {int(k): v for k, v in plan["line_notes"].items()}
    for line, note in notes.items():
        code = code_lines[line - 1] if line <= len(code_lines) else ""
        # Match the code itself; the notes' stock phrases ("stores the result in…") would match anything.
        have = _words(code)
        score = len(wanted & have)
        if score:
            # Lines that assign or return the thing asked about matter most.
            if re.match(r"\s*(return\b|\w+\s*(\[.*\])?\s*[+\-*/]?=)", code) and wanted & _words(code.split("=")[0] + " " + code):
                score += 1
            scored.append((score, line))
    if not wanted or not scored:
        topic = " or ".join(sorted(spoken.values())) or "that"
        return {
            "speech": f"I couldn't find anything about {topic} in your code. Ask me about one of its variables, "
                      "a line, or why it crashed.",
            "lines": [], "line": None, "found": False,
        }
    best = max(score for score, _ in scored)
    chosen = sorted(line for score, line in scored if score >= max(1, best - 1))[:4]
    picked = [{"line": ln, "code": code_lines[ln - 1].strip(), "note": notes[ln]} for ln in chosen]
    matched = wanted & set().union(*(_words(p["code"]) for p in picked))
    topic = " and ".join(sorted(spoken[w] for w in matched)[:3]) or "that"
    steps = " ".join(f"Line {p['line']}: {p['note']}" for p in picked)
    speech = f"Here is how your code handles {topic}. {steps}"
    return {"speech": speech, "lines": picked, "line": chosen[0], "found": True}
