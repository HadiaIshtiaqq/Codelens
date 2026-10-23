import json

import httpx
import pytest

from app.services.llm import Provider

DIVIDE = "def divide(a, b):\n    return a / b\nprint(divide(10, 0))\n"
DIVIDE_TESTS = (
    "from main import divide\n\n"
    "def test_normal():\n    assert divide(10, 2) == 5\n\n"
    "def test_zero_returns_none():\n    assert divide(1, 0) is None\n"
)


def _execute(client, source):
    resp = client.post("/api/v1/executions", json={"source_code": source})
    assert resp.status_code == 200
    return resp.json()["execution_id"]


# --------------------------------------------------------------------------- explanations

def test_explanation_facts_come_from_trace(client):
    exec_id = _execute(client, DIVIDE)
    body = client.post("/api/v1/explanations", json={"execution_id": exec_id}).json()
    assert body["provider"] == "offline"
    assert body["summary"].startswith("ZeroDivisionError at line 2 in function 'divide'")
    assert "ZeroDivisionError raised at line 2: division by zero" in body["observed_facts"]
    assert "Variable 'a' was 10" in body["observed_facts"]
    assert "Variable 'b' was 0" in body["observed_facts"]
    assert "'b' was 0" in body["likely_cause"]
    assert body["cited_lines"] == [2]


def test_explanation_for_specific_step_and_success(client):
    exec_id = _execute(client, "x = 1\ny = x + 1\n")
    body = client.post("/api/v1/explanations", json={"execution_id": exec_id, "step": 2}).json()
    assert body["step"] == 2
    assert "completion" in body["summary"]
    assert body["likely_cause"] is None


def test_explanation_timeout(client):
    resp = client.post("/api/v1/executions", json={"source_code": "while True:\n    pass\n", "limits": {"timeout_seconds": 0.5}})
    body = client.post("/api/v1/explanations", json={"execution_id": resp.json()["execution_id"]}).json()
    assert "time limit" in body["summary"]


def test_explanation_unknown_execution(client):
    assert client.post("/api/v1/explanations", json={"execution_id": "nope"}).status_code == 404


# --------------------------------------------------------------------------- offline patches

@pytest.mark.parametrize(
    "source, expect_in_patch",
    [
        (DIVIDE, "    if b == 0:\n        return None\n"),
        ("d = {'a': 1}\nprint(d['b'])\n", "d.get('b')"),
        ("xs = [1, 2, 3]\nfor i in range(len(xs) + 1):\n    print(xs[i])\n", "range(len(xs))"),
        ("total = 5\nprint(totl)\n", "print(total)"),
        ("count = 3\nprint('Count: ' + count)\n", "str(count)"),
        ("def add(a, b):\n    return a + b\nadd(5, '10')\n", "int(b)"),
        ("nums = [3, 1, 2]\nnums = nums.sort()\nprint(nums[0])\n", "nums.sort()\nprint"),
        ("count = 0\n\ndef bump():\n    count += 1\n\nbump()\nprint(count)\n", "    global count\n    count += 1"),
    ],
)
def test_offline_patch_fixes_program(client, source, expect_in_patch):
    exec_id = _execute(client, source)
    patch = client.post("/api/v1/patches", json={"execution_id": exec_id})
    assert patch.status_code == 200, patch.text
    body = patch.json()
    assert body["status"] == "proposed" and body["requires_validation"] is True
    assert expect_in_patch in body["patched_source"]
    assert body["diff"].startswith("--- a/main.py\n+++ b/main.py\n")
    # The patched program must now run without the original error.
    rerun = client.post("/api/v1/executions", json={"source_code": body["patched_source"]}).json()
    assert rerun["error"] is None, rerun


def test_no_offline_rule_returns_422(client):
    exec_id = _execute(client, "raise RuntimeError('custom')\n")
    resp = client.post("/api/v1/patches", json={"execution_id": exec_id})
    assert resp.status_code == 422
    assert "NEBIUS_API_KEY" in resp.json()["detail"]


def test_user_supplied_diff(client):
    exec_id = _execute(client, DIVIDE)
    diff = "--- a/main.py\n+++ b/main.py\n@@ -1,2 +1,4 @@\n def divide(a, b):\n+    if b == 0:\n+        return None\n     return a / b\n"
    body = client.post("/api/v1/patches", json={"execution_id": exec_id, "diff": diff}).json()
    assert body["provider"] == "user"
    evil = "--- a/../secrets.py\n+++ b/main.py\n@@ -1,1 +1,1 @@\n-x\n+y\n"
    assert client.post("/api/v1/patches", json={"execution_id": exec_id, "diff": evil}).status_code == 422


# --------------------------------------------------------------------------- validation

def _patch(client, source):
    exec_id = _execute(client, source)
    return client.post("/api/v1/patches", json={"execution_id": exec_id}).json()["patch_id"]


def test_validate_passes_with_tests(client):
    patch_id = _patch(client, DIVIDE)
    body = client.post("/api/v1/patches/validate", json={"patch_id": patch_id, "tests": DIVIDE_TESTS}).json()
    assert body["status"] == "validated"
    assert body["tests_passed"] == 2 and body["tests_failed"] == 0
    assert body["smoke"]["exit_code"] == 0
    # Same tests against the unpatched program: importing it crashes at module level.
    assert body["baseline"]["collection_error"] is True
    assert client.get(f"/api/v1/patches/{patch_id}").json()["status"] == "validated"


def test_validate_fails_on_failing_test(client):
    patch_id = _patch(client, DIVIDE)
    tests = "from main import divide\n\ndef test_raises_instead():\n    assert divide(1, 0) == 0, 'expected 0'\n"
    body = client.post("/api/v1/patches/validate", json={"patch_id": patch_id, "tests": tests}).json()
    assert body["status"] == "failed"
    assert body["tests_failed"] == 1
    assert body["tests"][0]["message"] == "expected 0"
    assert body["tests"][0]["line"] == 4


def test_validate_without_tests_is_untested(client):
    patch_id = _patch(client, DIVIDE)
    body = client.post("/api/v1/patches/validate", json={"patch_id": patch_id}).json()
    assert body["status"] == "untested"
    assert body["smoke"]["exit_code"] == 0


def test_validate_with_no_test_functions_fails(client):
    patch_id = _patch(client, DIVIDE)
    body = client.post("/api/v1/patches/validate", json={"patch_id": patch_id, "tests": "x = 1\n"}).json()
    assert body["status"] == "failed"
    assert "No test_* functions" in body["output"]


def test_validate_infinite_loop_test_times_out(client):
    patch_id = _patch(client, DIVIDE)
    tests = "def test_hang():\n    while True:\n        pass\n"
    body = client.post(
        "/api/v1/patches/validate", json={"patch_id": patch_id, "tests": tests, "timeout_seconds": 1}
    ).json()
    assert body["status"] == "failed"


# --------------------------------------------------------------------------- LLM provider path

def _mock_llm(app, handler):
    app.state.llm_provider = Provider("nebius", "test-model", "https://llm.test/v1", "key")
    app.state.llm_transport = httpx.MockTransport(handler)


@pytest.fixture
def llm_app(client):
    from app.main import app

    saved = app.state.llm_provider
    yield app
    app.state.llm_provider = saved
    app.state.llm_transport = None


def _reply(content: dict | str):
    text = content if isinstance(content, str) else json.dumps(content)
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


def test_llm_explanation_used_and_grounding_checked(client, llm_app):
    seen = {}

    def handler(request: httpx.Request):
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return _reply("<think>reasoning</think>```json\n" + json.dumps({
            "summary": "b is zero at line 2",
            "likely_cause": "'zzz' was 0 on line 99",
            "suggested_next_step": "guard b",
            "cited_lines": [2, 99],
        }) + "\n```")

    _mock_llm(llm_app, handler)
    exec_id = _execute(client, DIVIDE)
    body = client.post("/api/v1/explanations", json={"execution_id": exec_id, "question": "why?"}).json()
    assert body["provider"] == "nebius" and body["model"] == "test-model"
    assert body["summary"] == "b is zero at line 2"
    assert seen["auth"] == "Bearer key"
    assert seen["body"]["response_format"] == {"type": "json_object"}
    assert "numbered_source" in seen["body"]["messages"][1]["content"]
    # Facts stay deterministic even when a model is used.
    assert "Variable 'b' was 0" in body["observed_facts"]
    warnings = " ".join(body["grounding_warnings"])
    assert "99" in warnings and "'zzz'" in warnings


def test_grounding_checks_claimed_values():
    from app.services.llm import ExplanationOut, grounding_warnings

    out = ExplanationOut(summary="'b' was 5 and 'a' was 10.", likely_cause="'a' was 10.0", cited_lines=[2])
    warnings = grounding_warnings(out, 3, {"a": {"10"}, "b": {"0"}})
    assert warnings == ["says 'b' was 5, but the trace only recorded 0"]


def test_llm_failure_degrades_to_offline(client, llm_app):
    _mock_llm(llm_app, lambda request: httpx.Response(503, text="overloaded"))
    exec_id = _execute(client, DIVIDE)
    body = client.post("/api/v1/explanations", json={"execution_id": exec_id}).json()
    assert body["provider"] == "offline" and body["degraded"] is True
    assert "HTTP 503" in body["provider_error"]
    patch = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    assert patch["provider"] == "offline" and patch["degraded"] is True


def test_llm_patch_used_when_valid(client, llm_app):
    fixed = DIVIDE.replace("    return a / b\n", "    return a / b if b else 0\n")
    _mock_llm(llm_app, lambda request: _reply({"patched_source": fixed, "rationale": "guard"}))
    exec_id = _execute(client, DIVIDE)
    body = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    assert body["provider"] == "nebius"
    assert "+    return a / b if b else 0" in body["diff"]


def test_llm_invalid_patch_falls_back(client, llm_app):
    _mock_llm(llm_app, lambda request: _reply({"patched_source": "def broken(:\n", "rationale": "x"}))
    exec_id = _execute(client, DIVIDE)
    body = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    assert body["provider"] == "offline" and "not valid Python" in body["provider_error"]


def test_selftest_offline(client):
    body = client.post("/api/v1/ai/selftest").json()
    assert body["provider"] == "offline" and body["ok"] is False


def test_selftest_live_provider(client, llm_app):
    _mock_llm(llm_app, lambda request: _reply({"ok": True}))
    body = client.post("/api/v1/ai/selftest").json()
    assert body == {**body, "provider": "nebius", "model": "test-model", "ok": True}


def test_strict_provider_refuses_fallback(client, llm_app, monkeypatch):
    import dataclasses

    from app.config import get_settings
    from app.routers import analysis

    strict = dataclasses.replace(get_settings(), require_llm_provider=True)
    monkeypatch.setattr(analysis, "get_settings", lambda: strict)
    _mock_llm(llm_app, lambda request: httpx.Response(500, text="down"))
    exec_id = _execute(client, DIVIDE)
    resp = client.post("/api/v1/explanations", json={"execution_id": exec_id})
    assert resp.status_code == 502 and "AI provider failed" in resp.json()["detail"]


import pytest as _pytest

from app.services.offline import fix_syntax


@_pytest.mark.parametrize(
    "broken, fixed_piece, why",
    [
        ("for i in range(3)\n    print(i)\n", "for i in range(3):\n", "needs a ':'"),
        ("x = 5\nif x = 5:\n    print('five')\n", "if x == 5:", "'=='"),
        ('print("hello)\n', 'print("hello")\n', "never closes them"),
        ("print('hi'\n", "print('hi')\n", "never closed"),
        ("x = 1\n    y = 2\n", "\ny = 2\n", "pushed in too far"),
        ("if True:\nprint('yes')\n", "    print('yes')", "pushed in by 4 spaces"),
    ],
)
def test_fix_syntax_typing_slips(broken, fixed_piece, why):
    result = fix_syntax(broken)
    assert result is not None, broken
    fixed, explanation = result
    assert fixed_piece in fixed and why in explanation
    import ast as _ast
    _ast.parse(fixed)


def test_syntax_fix_through_patch_api(client):
    exec_id = _execute(client, "for i in range(3)\n    print(i)\n")
    patch = client.post("/api/v1/patches", json={"execution_id": exec_id}).json()
    assert patch["patched_source"].startswith("for i in range(3):\n")
    assert "needs a ':'" in patch["rationale"]


# --------------------------------------------------------------------------- /ask (Alexa's open questions)

def test_ask_uses_the_ai_with_the_code_and_checks_its_line(client, llm_app):
    seen = {}

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        seen["prompt"] = body["messages"][1]["content"]
        return _reply({"speech": "Your code never builds a path. Add path = [start] on line 2.", "line": 99})

    _mock_llm(llm_app, handler)
    src = 'print("Hello!")\nname = "Mia"\n'
    body = client.post("/api/v1/ask", json={"source_code": src, "question": "how do I print the path?"}).json()
    assert body["source"] == "ai" and body["speech"].startswith("Your code never builds a path")
    assert body["line"] is None  # line 99 doesn't exist: not passed on
    assert '1 | print("Hello!")' in seen["prompt"] and "has not been run" in seen["prompt"]


def test_ask_falls_back_to_the_code_when_the_ai_fails(client, llm_app):
    _mock_llm(llm_app, lambda request: httpx.Response(503, text="busy"))
    body = client.post("/api/v1/ask", json={"source_code": "total = 1\nprint(total)\n", "question": "what is total for"}).json()
    assert body["source"] == "rules" and "total" in body["speech"] and "provider_error" in body


def test_ask_without_ai_says_what_the_code_lacks(client):
    body = client.post("/api/v1/ask", json={"source_code": 'print("Hi")\n', "question": "how to print the path"}).json()
    assert body["source"] == "rules" and body["speech"].startswith("Your code doesn't have anything called path")


def test_gemini_is_picked_automatically_and_uses_a_flash_model():
    import dataclasses

    from app.config import get_settings
    from app.services.llm import choose_model, select_provider

    settings = dataclasses.replace(get_settings(), llm_provider="auto", nebius_api_key="", gemini_api_key="g-key")
    provider = select_provider(settings)
    assert provider.name == "gemini" and provider.base_url.endswith("/v1beta/openai") and provider.api_key == "g-key"
    ids = ["models/gemini-2.0-flash", "models/gemini-2.5-flash", "models/gemini-2.5-flash-lite", "models/gemini-2.5-pro",
           "models/text-embedding-004", "models/gemini-2.5-flash-preview-tts"]
    assert choose_model(ids, "gemini") == "gemini-2.5-flash"


# --------------------------------------------------------------------------- Alexa's autopilot (agent)

BROKEN_TOTAL = "def total(xs):\n    s = 0\n    for i in range(len(xs) + 1):\n        s += xs[i]\n    return s\n\nprint(total([1, 2, 3]))\n"


def test_autopilot_without_ai_runs_diagnoses_fixes_and_tests(client):
    body = client.post("/api/v1/agent", json={"source_code": BROKEN_TOTAL, "goal": "debug my code"}).json()
    assert body["source"] == "planner"
    assert [s["tool"] for s in body["steps"]] == ["run_code", "diagnose", "propose_fix", "test_fix"]
    assert body["line"] == 4 and body["patch"]["status"] == "validated"  # tests generated from the run
    assert "range(len(xs))" in body["patch"]["patched_source"] and 'apply the fix' in body["speech"]


def test_autopilot_with_ai_lets_the_model_choose_the_tools(client, llm_app):
    turns = iter([
        {"tool_calls": [{"id": "1", "type": "function", "function": {"name": "run_code", "arguments": "{}"}}]},
        {"tool_calls": [{"id": "2", "type": "function", "function": {"name": "variable_history", "arguments": '{"name": "s"}'}}]},
        {"content": "It crashed on line 4 because i reached 3. s went 0, 1, 3, 6 first."},
    ])
    seen = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        if "tools" not in body:  # run_code's own explanation request also uses the AI
            return _reply({"summary": "An IndexError on line 4.", "likely_cause": "i reaches len(xs).", "cited_lines": [4]})
        seen.append(body)
        return httpx.Response(200, json={"choices": [{"message": next(turns)}]})

    _mock_llm(llm_app, handler)
    body = client.post("/api/v1/agent", json={"source_code": BROKEN_TOTAL, "goal": "why does it crash"}).json()
    assert body["source"] == "ai" and [s["tool"] for s in body["steps"]] == ["run_code", "variable_history"]
    assert body["speech"].startswith("It crashed on line 4") and body["line"] == 4
    assert {t["function"]["name"] for t in seen[0]["tools"]} >= {"run_code", "diagnose", "propose_fix", "test_fix"}
    tool_result = json.loads(seen[2]["messages"][-1]["content"])  # the model saw the real variable history
    assert tool_result["values"][:4] == ["0", "1", "3", "6"]


def test_autopilot_falls_back_to_the_plan_when_the_ai_fails(client, llm_app):
    _mock_llm(llm_app, lambda request: httpx.Response(500, text="down"))
    body = client.post("/api/v1/agent", json={"source_code": BROKEN_TOTAL}).json()
    assert body["source"] == "planner" and body["patch"]["status"] == "validated"
