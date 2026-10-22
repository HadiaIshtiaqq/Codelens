"""AI code conversion and Nemotron model auto-selection."""

import json

import httpx
import pytest

from app.services.llm import Provider, choose_model

JS = "function add(a, b) {\n  return a + b;\n}\nconsole.log(add(2, 3));\n"


@pytest.fixture
def nebius(client):
    from app.main import app

    saved = app.state.llm_provider
    app.state.llm_provider = Provider("nebius", None, "https://llm.test/v1", "key")
    yield app
    app.state.llm_provider = saved
    app.state.llm_transport = None


def _transport(app, replies, seen=None):
    """Serve /models, then the queued chat replies in order."""
    queue = list(replies)

    def handler(request: httpx.Request):
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": "meta/llama-3"}, {"id": "nvidia/Nemotron-3.5-Super-VL"},
                                                      {"id": "nvidia/nemotron-3-super-120b-a12b"},
                                                      {"id": "nvidia/Nemotron-3-Ultra-550b-a55b"}]})
        if seen is not None:
            seen.append(json.loads(request.content))
        content = queue.pop(0)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})

    app.state.llm_transport = httpx.MockTransport(handler)


def test_choose_model_prefers_nemotron_super_text_model():
    ids = ["meta/llama-3", "nvidia/Nemotron-3.5-Super-VL", "nvidia/nemotron-3-super-120b-a12b", "nvidia/Nemotron-3-Ultra-550b-a55b"]
    assert choose_model(ids) == "nvidia/nemotron-3-super-120b-a12b"
    assert choose_model(["a/b"]) == "a/b"
    assert choose_model([]) is None


def test_convert_requires_ai(client):
    resp = client.post("/api/v1/convert", json={"source_code": JS})
    assert resp.status_code == 503 and "NEBIUS_API_KEY" in resp.json()["detail"]


def test_convert_js_to_python_and_run(client, nebius):
    seen = []
    _transport(nebius, [{"detected_language": "JavaScript",
                         "converted_code": "```python\ndef add(a, b):\n    return a + b\n\nprint(add(2, 3))\n```",
                         "notes": ["console.log -> print"]}], seen)
    body = client.post("/api/v1/convert", json={"source_code": JS}).json()
    assert body["detected_language"] == "JavaScript"
    assert body["converted_code"] == "def add(a, b):\n    return a + b\n\nprint(add(2, 3))\n"  # fence stripped
    assert body["syntax_checked"] is True
    assert body["model"] == "nvidia/nemotron-3-super-120b-a12b"  # auto-selected
    assert seen[0]["model"] == "nvidia/nemotron-3-super-120b-a12b"
    assert "standalone script" in seen[0]["messages"][1]["content"]
    run = client.post("/api/v1/executions", json={"source_code": body["converted_code"]}).json()
    assert run["stdout"] == "5\n"
    assert client.get("/health").json()["llm_model"] == "nvidia/nemotron-3-super-120b-a12b"


def test_convert_retries_invalid_python_once(client, nebius):
    seen = []
    _transport(nebius, [
        {"detected_language": "JavaScript", "converted_code": "def add(a, b) {\n", "notes": []},
        {"detected_language": "JavaScript", "converted_code": "def add(a, b):\n    return a + b\n", "notes": []},
    ], seen)
    body = client.post("/api/v1/convert", json={"source_code": JS}).json()
    assert body["converted_code"].startswith("def add(a, b):")
    assert "previous answer was rejected" in seen[1]["messages"][1]["content"]


def test_convert_to_other_language_not_syntax_checked(client, nebius):
    _transport(nebius, [{"detected_language": "Python", "converted_code": "fn main() {}\n", "notes": []}])
    body = client.post("/api/v1/convert", json={"source_code": "print(1)\n", "target_language": "Rust"}).json()
    assert body["target_language"] == "Rust" and body["syntax_checked"] is False


def test_health_reports_features(client):
    features = client.get("/health").json()["features"]
    assert features == {"rea_ui": False, "convert": False, "access_code_required": False}
