import time


def test_zero_division_identifies_failing_line(run):
    body, events = run("def divide(a, b):\n    return a / b\nprint(divide(10, 0))\n")
    assert body["status"] == "completed"
    assert body["exit_code"] == 1
    assert body["error"] == {"type": "ZeroDivisionError", "message": "division by zero", "line": 2, "file": "main.py"}
    assert 'File "main.py", line 2, in divide' in body["stderr"]

    exc = next(e for e in events if e["event"] == "exception")
    assert exc["line"] == 2
    assert exc["function"] == "divide"
    assert exc["locals"] == {"a": "10", "b": "0"}
    assert exc["stack_depth"] == 2
    assert events[-1]["event"] == "exit"
    assert [e["step"] for e in events] == list(range(len(events)))


def test_event_types_and_stdout(run):
    src = "def add(a, b):\n    return a + b\nx = add(2, 3)\nprint('sum', x)\n"
    body, events = run(src)
    assert body["status"] == "completed" and body["exit_code"] == 0
    assert body["stdout"] == "sum 5\n"
    kinds = [e["event"] for e in events]
    assert kinds[0] == "call" and events[0]["function"] == "<module>" and events[0]["line"] == 1
    ret = next(e for e in events if e["event"] == "return" and e["function"] == "add")
    assert ret["return_value"] == "5"
    call = next(e for e in events if e["event"] == "call" and e["function"] == "add")
    assert call["arg_names"] == ["a", "b"]
    out = [e for e in events if e["event"] == "stdout"]
    assert len(out) == 1 and out[0]["stdout_chunk"] == "sum 5\n" and out[0]["line"] == 4


def test_recursion_stack_depth(run):
    src = "def fact(n):\n    return 1 if n <= 1 else n * fact(n - 1)\nfact(100)\n"
    body, events = run(src)
    assert body["exit_code"] == 0
    assert max(e["stack_depth"] for e in events) == 101


def test_tight_loop_truncates_trace_but_completes(run):
    body, events = run("for i in range(1000000):\n    pass\nprint('done')\n")
    assert body["status"] == "completed"
    assert body["stdout"] == "done\n"
    assert body["trace_truncated"] is True
    assert len(events) == 1000  # cap: first 300 events + the most recent 700 (incl. exit)
    assert events[-1]["event"] == "exit"
    # The end of the run is kept, so the final print is visible even after a million iterations.
    assert any(e["event"] == "stdout" and e["stdout_chunk"] == "done\n" for e in events[-5:])
    gap = [e for e in events if "skipped_before" in e]
    assert len(gap) == 1 and gap[0]["step"] == 300 and gap[0]["skipped_before"] > 0
    assert body["omitted_steps"] == gap[0]["skipped_before"]
    assert body["recording_stopped"] is True  # 1M iterations exceed the 20k trace budget


def test_infinite_loop_times_out_with_partial_trace(run):
    t0 = time.monotonic()
    body, events = run("while True:\n    pass\n", limits={"timeout_seconds": 1.0})
    assert time.monotonic() - t0 < 4
    assert body["status"] == "timed_out"
    assert body["exit_code"] == 124
    assert events, "partial trace should be returned"


def test_output_capped_at_4_mib(run):
    body, _ = run("import sys\nfor _ in range(6000):\n    sys.stdout.write('x' * 1024)\n")
    assert body["status"] == "completed"
    assert body["output_truncated"] is True
    assert len(body["stdout"].encode()) == 4 * 1024 * 1024
    assert "[STDOUT TRUNCATED AT 4 MiB]" in body["stderr"]


def test_syntax_error(run):
    body, events = run("def broken(:\n    pass\n")
    assert body["exit_code"] == 1
    assert body["error"]["type"] == "SyntaxError"
    assert body["error"]["line"] == 1
    assert events == []


def test_sys_exit_code(run):
    body, _ = run("import sys\nsys.exit(3)\n")
    assert body["status"] == "completed" and body["exit_code"] == 3 and body["error"] is None


def test_input_does_not_block(run):
    body, _ = run("input()\n")
    assert body["error"]["type"] == "EOFError"


def test_fd_write_cannot_spoof_result(run):
    body, _ = run("import os\nos.write(1, b'{\"status\": \"completed\"}\\n')\nprint('ok')\n")
    assert body["stdout"] == "ok\n"


def test_host_secrets_not_visible(run, monkeypatch):
    monkeypatch.setenv("NEBIUS_API_KEY", "secret-should-not-leak")
    body, _ = run("import os\nprint(os.environ.get('NEBIUS_API_KEY'))\n")
    assert body["stdout"] == "None\n"


def test_large_list_snapshot_bounded(run):
    _, events = run("x = list(range(10000))\ny = 1\n")
    snap = next(e for e in events if "x" in e["locals"])["locals"]["x"]
    assert "+9980 more" in snap and len(snap) < 10 * 1024


def test_request_validation(client):
    too_big = "x = 1\n" * 20000
    assert client.post("/api/v1/executions", json={"source_code": too_big}).status_code == 422
    assert client.post("/api/v1/executions", json={"source_code": "1", "language": "ruby"}).status_code == 422
    assert client.post(
        "/api/v1/executions", json={"source_code": "1", "limits": {"timeout_seconds": 30}}
    ).status_code == 422
    assert client.get("/api/v1/executions/exec_missing/trace").status_code == 404


def test_trace_pagination(client):
    body = client.post("/api/v1/executions", json={"source_code": "for i in range(30):\n    pass\n"}).json()
    page = client.get(f"/api/v1/executions/{body['execution_id']}/trace", params={"limit": 10}).json()
    assert len(page["events"]) == 10 and page["next_start"] == 10
    assert page["total_steps"] == body["total_steps"]


def test_sse_stream(client):
    with client.stream("POST", "/api/v1/executions/stream", json={"source_code": "x = 1\n"}) as resp:
        text = "".join(resp.iter_text())
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert text.startswith("event: init\n")
    assert "event: step\n" in text
    assert text.rstrip().split("\n\n")[-1].startswith("event: complete\n")


def test_long_run_still_shows_the_final_crash(run):
    src = "data = list(range(10))\nfor n in range(300000):\n    total = n\nprint('loop done')\nprint(data[total])\n"
    body, events = run(src)
    assert body["recording_stopped"] is True
    assert body["error"]["type"] == "IndexError" and body["error"]["line"] == 5
    crash = [e for e in events if e["event"] == "exception"][-1]
    assert crash["line"] == 5 and crash["locals"]["total"] == "299999"
    assert any(e.get("untraced_before") for e in events)
    assert any(e["event"] == "stdout" and e["stdout_chunk"] == "loop done\n" for e in events)


def test_input_reads_program_input(run):
    body, events = run("name = input('Name? ')\nage = int(input())\nprint(name, age + 1)\n", stdin="Ada\n36\n")
    assert body["error"] is None
    assert body["stdout"] == "Name? Ada\n36\nAda 37\n"  # prompts and typed values echoed like a terminal
    assert any(e.get("narration", "").startswith("Sets name: asks the user for a line of input") for e in events)


def test_input_without_enough_lines_explains_itself(run):
    body, _ = run("a = input()\nb = input()\n", stdin="only one\n")
    assert body["error"]["type"] == "EOFError"
    assert "Program input box has no more lines" in body["error"]["message"]


def test_multi_file_project(run):
    files = {"geometry.py": "import math\n\ndef area(r):\n    return math.pi * r ** 2\n"}
    body, events = run("from geometry import area\nprint(round(area(2), 2))\n", files=files)
    assert body["stdout"] == "12.57\n"
    inside = [e for e in events if e["file"] == "geometry.py" and e["event"] == "line"]
    assert inside and inside[0]["function"] in ("<module>", "area")
    call = next(e for e in events if e["event"] == "call" and e["function"] == "area")
    assert call["narration"] == "Enters area() in geometry.py with r = 2"
    assert body["file_line_notes"]["geometry.py"]["3"].startswith("Defines function area(r)")


def test_multi_file_error_points_at_the_right_file(run):
    files = {"helpers.py": "def half(x):\n    return x / 0\n"}
    body, _ = run("import helpers\nhelpers.half(4)\n", files=files)
    assert body["error"] == {"type": "ZeroDivisionError", "message": "division by zero", "line": 2, "file": "helpers.py"}
    assert 'File "helpers.py", line 2, in half' in body["stderr"]


def test_invalid_file_names_rejected(client):
    for name in ("main.py", "../x.py", "a b.py", "x.txt"):
        resp = client.post("/api/v1/executions", json={"source_code": "x = 1\n", "files": {name: "y = 2\n"}})
        assert resp.status_code == 422, name


def test_delete_execution(client):
    exec_id = client.post("/api/v1/executions", json={"source_code": "print(1/0)\n"}).json()["execution_id"]
    patch = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    assert client.delete(f"/api/v1/executions/{exec_id}").json() == {"execution_id": exec_id, "deleted": True}
    assert client.get(f"/api/v1/executions/{exec_id}").status_code == 404
    assert client.get(f"/api/v1/patches/{patch['patch_id']}").status_code == 404
    assert client.delete(f"/api/v1/executions/{exec_id}").status_code == 404
