"""Frames + heap snapshot used by the visual (game) view."""


def _events(run, source):
    _, events = run(source)
    return events


def _last_viz(events):
    return [e for e in events if "viz" in e][-1]["viz"]


def test_aliasing_shares_one_heap_object(run):
    viz = _last_viz(_events(run, "a = [1, 2]\nb = a\nc = [1, 2]\nx = 0\n"))
    frame = viz["stack"][0]
    refs = dict(frame["locals"])
    assert refs["a"] == refs["b"]  # same object -> same reference
    assert refs["a"] != refs["c"]  # equal but distinct object
    lst = viz["heap"][refs["a"]["r"]]
    assert lst["kind"] == "list"
    assert lst["items"] == [{"p": "1", "t": "int"}, {"p": "2", "t": "int"}]


def test_cycles_dicts_instances_and_primitives(run):
    src = (
        "class Node:\n"
        "    def __init__(self, v):\n"
        "        self.v = v\n"
        "        self.next = None\n"
        "n = Node(3)\n"
        "n.next = n\n"
        "d = {'k': n, 's': 'hi'}\n"
        "done = True\n"
    )
    viz = _last_viz(_events(run, src))
    locals_ = dict(viz["stack"][0]["locals"])
    node = viz["heap"][locals_["n"]["r"]]
    assert node["kind"] == "instance" and node["type"] == "Node"
    attrs = dict(node["attrs"])
    assert attrs["v"] == {"p": "3", "t": "int"}
    assert attrs["next"] == locals_["n"]  # self-reference, no infinite recursion
    entries = viz["heap"][locals_["d"]["r"]]["entries"]
    assert entries[0][1] == locals_["n"]
    assert entries[1][1] == {"p": "'hi'", "t": "str"}
    assert viz["heap"][locals_["Node"]["r"]]["kind"] == "class"


def test_recursion_frames_and_return_value(run):
    src = "def fact(n):\n    if n <= 1:\n        return 1\n    return n * fact(n - 1)\nfact(4)\n"
    events = _events(run, src)
    deepest = max((e for e in events if "viz" in e), key=lambda e: len(e["viz"]["stack"]))
    assert [f["function"] for f in deepest["viz"]["stack"]] == ["<module>", "fact", "fact", "fact", "fact"]
    ret = next(e for e in events if e["event"] == "return" and e["function"] == "fact")
    assert ret["viz"]["stack"][-1]["return_value"] == {"p": "1", "t": "int"}


def test_deep_recursion_frames_are_capped(run):
    events = _events(run, "def f(n):\n    return 0 if n == 0 else f(n - 1)\nf(40)\n")
    deepest = max((e for e in events if "viz" in e), key=lambda e: e["viz"]["hidden_frames"])
    assert len(deepest["viz"]["stack"]) == 12
    assert deepest["viz"]["hidden_frames"] > 0


def test_large_list_items_capped(run):
    viz = _last_viz(_events(run, "xs = list(range(500))\ny = 1\n"))
    lst = viz["heap"][dict(viz["stack"][0]["locals"])["xs"]["r"]]
    assert len(lst["items"]) == 30 and lst["more"] == 470


def test_trace_can_omit_viz(client):
    body = client.post("/api/v1/executions", json={"source_code": "x = [1]\n"}).json()
    with_viz = client.get(f"/api/v1/executions/{body['execution_id']}/trace").json()["events"]
    without = client.get(f"/api/v1/executions/{body['execution_id']}/trace", params={"include_viz": False}).json()["events"]
    assert any("viz" in e for e in with_viz)
    assert not any("viz" in e for e in without)
