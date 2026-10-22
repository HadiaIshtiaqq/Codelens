"""Unified diff generation, parsing, validation and application (spec §5.4 step 1-2).

Patches only ever target the single workspace file `main.py`; any header naming
another path (absolute, traversal, or a different file) is rejected.
"""

import difflib
import re
from dataclasses import dataclass, field

TARGET_FILE = "main.py"
_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class DiffError(ValueError):
    pass


@dataclass
class Hunk:
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    lines: list[str] = field(default_factory=list)  # each prefixed with ' ', '-' or '+'


def make_diff(original: str, patched: str) -> str:
    return "".join(
        difflib.unified_diff(
            _ensure_newline(original).splitlines(True),
            _ensure_newline(patched).splitlines(True),
            fromfile=f"a/{TARGET_FILE}",
            tofile=f"b/{TARGET_FILE}",
        )
    )


def _ensure_newline(text: str) -> str:
    return text if text.endswith("\n") or not text else text + "\n"


def _check_path(header: str, prefix: str) -> None:
    path = header[len(prefix):].strip().split("\t")[0]
    if path == "/dev/null":
        raise DiffError("patches may not create or delete files")
    for strip in ("a/", "b/"):
        if path.startswith(strip):
            path = path[len(strip):]
            break
    if path != TARGET_FILE:
        raise DiffError(f"patch targets {path!r}; only {TARGET_FILE!r} may be modified")


def parse_unified_diff(diff: str) -> list[Hunk]:
    lines = diff.replace("\r\n", "\n").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    hunks: list[Hunk] = []
    saw_old = saw_new = False
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("--- "):
            _check_path(line, "--- ")
            saw_old = True
        elif line.startswith("+++ "):
            _check_path(line, "+++ ")
            saw_new = True
        elif line.startswith("@@"):
            if not (saw_old and saw_new):
                raise DiffError("hunk before file headers")
            m = _HUNK_RE.match(line)
            if not m:
                raise DiffError(f"malformed hunk header: {line!r}")
            hunk = Hunk(
                old_start=int(m.group(1)),
                old_len=int(m.group(2)) if m.group(2) is not None else 1,
                new_start=int(m.group(3)),
                new_len=int(m.group(4)) if m.group(4) is not None else 1,
            )
            old_seen = new_seen = 0
            i += 1
            while i < len(lines) and (old_seen < hunk.old_len or new_seen < hunk.new_len):
                body = lines[i]
                if body.startswith("\\"):  # "\ No newline at end of file"
                    i += 1
                    continue
                tag = body[:1] or " "  # tolerate blank context lines with stripped space
                if tag not in " -+":
                    raise DiffError(f"unexpected line in hunk: {body!r}")
                hunk.lines.append(tag + body[1:])
                if tag in " -":
                    old_seen += 1
                if tag in " +":
                    new_seen += 1
                i += 1
            if old_seen != hunk.old_len or new_seen != hunk.new_len:
                raise DiffError("hunk line counts do not match its header")
            hunks.append(hunk)
            continue
        elif line.startswith(("diff ", "index ")) or not line.strip():
            pass
        else:
            raise DiffError(f"unexpected line outside hunk: {line!r}")
        i += 1
    if not hunks:
        raise DiffError("diff contains no hunks")
    return hunks


def apply_unified_diff(original: str, diff: str) -> str:
    """Apply `diff` to `original`, requiring every context/removed line to match exactly."""
    hunks = parse_unified_diff(diff)
    src = _ensure_newline(original).splitlines()
    out: list[str] = []
    cursor = 0  # index into src of the next unconsumed line
    for hunk in hunks:
        start = hunk.old_start - 1 if hunk.old_len else hunk.old_start
        if start < cursor or start > len(src):
            raise DiffError(f"hunk at line {hunk.old_start} is out of order or out of range")
        out.extend(src[cursor:start])
        pos = start
        for entry in hunk.lines:
            tag, text = entry[0], entry[1:]
            if tag in " -":
                if pos >= len(src) or src[pos] != text:
                    found = src[pos] if pos < len(src) else "<end of file>"
                    raise DiffError(f"context mismatch at line {pos + 1}: expected {text!r}, found {found!r}")
                pos += 1
                if tag == " ":
                    out.append(text)
            else:
                out.append(text)
        cursor = pos
    out.extend(src[cursor:])
    return "\n".join(out) + "\n"
