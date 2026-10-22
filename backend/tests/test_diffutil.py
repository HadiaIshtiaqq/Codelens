import pytest

from app.services.diffutil import DiffError, apply_unified_diff, make_diff, parse_unified_diff

ORIGINAL = "def divide(a, b):\n    return a / b\nprint(divide(10, 0))\n"
PATCHED = "def divide(a, b):\n    if b == 0:\n        return None\n    return a / b\nprint(divide(10, 0))\n"


def test_roundtrip():
    diff = make_diff(ORIGINAL, PATCHED)
    assert diff.startswith("--- a/main.py\n+++ b/main.py\n@@ ")
    assert apply_unified_diff(ORIGINAL, diff) == PATCHED


def test_spec_example_diff_applies():
    diff = "--- a/main.py\n+++ b/main.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0:\n+        return None\n     return a / b\n"
    assert apply_unified_diff(ORIGINAL, diff) == PATCHED


def test_hunk_header_counts_checked():
    bad = "--- a/main.py\n+++ b/main.py\n@@ -1,5 +1,4 @@\n def divide(a, b):\n+    pass\n"
    with pytest.raises(DiffError):
        parse_unified_diff(bad)


def test_context_mismatch_rejected():
    diff = "--- a/main.py\n+++ b/main.py\n@@ -1,1 +1,1 @@\n-def multiply(a, b):\n+def mul(a, b):\n"
    with pytest.raises(DiffError, match="context mismatch"):
        apply_unified_diff(ORIGINAL, diff)


@pytest.mark.parametrize("path", ["/etc/passwd", "a/../../etc/passwd", "a/other.py", "/dev/null"])
def test_paths_outside_workspace_rejected(path):
    diff = f"--- {path}\n+++ b/main.py\n@@ -1,1 +1,1 @@\n-x\n+y\n"
    with pytest.raises(DiffError):
        parse_unified_diff(diff)


def test_multiple_hunks_and_pure_insertion():
    original = "".join(f"line{i}\n" for i in range(1, 21))
    patched = original.replace("line3\n", "line3\nnew-a\n").replace("line18\n", "LINE18\n")
    diff = make_diff(original, patched)
    assert diff.count("@@ -") == 2
    assert apply_unified_diff(original, diff) == patched
    insert_only = "--- a/main.py\n+++ b/main.py\n@@ -2,0 +3,1 @@\n+inserted\n"
    assert apply_unified_diff("a\nb\nc\n", insert_only) == "a\nb\ninserted\nc\n"


def test_empty_diff_rejected():
    with pytest.raises(DiffError):
        parse_unified_diff("")
