from tracer import MAX_VALUE_CHARS, safe_value


def test_primitives():
    assert safe_value(5) == "5"
    assert safe_value(True) == "True"
    assert safe_value(None) == "None"
    assert safe_value("10") == "'10'"


def test_long_string_truncated():
    out = safe_value("x" * 500)
    assert out.endswith("... (+400 chars)")


def test_large_list_truncated_and_small():
    out = safe_value(list(range(10000)))
    assert out.startswith("[0, 1, 2,")
    assert "+9980 more" in out
    assert len(out) < 10 * 1024


def test_circular_list_and_dict():
    a = [1]
    a.append(a)
    assert "<CircularReference>" in safe_value(a, max_depth=5)
    d = {}
    d["self"] = d
    assert "<CircularReference>" in safe_value(d, max_depth=5)


def test_repeated_sibling_is_not_circular():
    shared = [1, 2]
    assert "<CircularReference>" not in safe_value([shared, shared])


def test_generator_function_module():
    def gen():
        yield 1

    import math

    assert safe_value(gen()).startswith("<generator")
    assert safe_value(gen) .startswith("<function")
    assert safe_value(math) == "<module math>"


def test_custom_object_never_calls_user_hooks():
    class Hostile:
        def __init__(self):
            self.x = 1

        def __repr__(self):
            raise RuntimeError("boom")

        def __getattr__(self, name):
            raise RuntimeError("boom")

    assert safe_value(Hostile()) == "<Hostile {'x': 1}>"


def test_huge_int():
    assert safe_value(10**5000).startswith("<int with")


def test_hard_length_cap():
    nested = {f"k{i}": "v" * 100 for i in range(20)}
    assert len(safe_value(nested)) <= MAX_VALUE_CHARS
