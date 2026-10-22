import os
from pathlib import Path

import pytest

from app.config import LOCAL_REA_SCRIPT, get_settings
from app.services.rea import ReaError, confine_arguments, confine_path, project_javascript_analysis

REA_INSTALLED = LOCAL_REA_SCRIPT.exists()
needs_rea = pytest.mark.skipif(not REA_INSTALLED, reason="rea-agents not installed (npm install in rea/)")


def _settings():
    return get_settings()


def test_confine_path_allows_workspace_and_rejects_escape():
    s = _settings()
    root = s.rea_workspace_root
    assert confine_path(s, "app") == str(root / "app")
    assert confine_path(s, str(root / "x" / "y")) == str(root / "x" / "y")
    for bad in ("../outside", str(Path(root).parent / "elsewhere"), "C:/Windows/System32" if os.name == "nt" else "/etc"):
        with pytest.raises(ReaError) as exc:
            confine_path(s, bad)
        assert exc.value.status_code == 403


def test_confine_arguments_only_touches_path_fields():
    s = _settings()
    schema = {"properties": {
        "input_path": {"type": "string"},
        "source_paths": {"type": "array"},
        "symbol": {"type": "string"},
    }}
    out = confine_arguments(s, schema, {"input_path": "bin/app", "source_paths": ["../x.js"], "symbol": "../main"})
    assert out["input_path"] == str(s.rea_workspace_root / "bin" / "app")
    assert out["source_paths"] == ["../x.js"]  # relative to the analysed app, not the host
    assert out["symbol"] == "../main"
    with pytest.raises(ReaError):
        confine_arguments(s, schema, {"input_path": "../../escape"})


def test_projection_extracts_ipc_and_entrypoints():
    def node(kind, label, props, source=None, line=None):
        loc = {"available": True, "value": {"source": source, "start": {"line": line}}} if source else {}
        return {"kind": kind, "observations": [{"label": label, "properties": props, "evidence": {"location": loc}}]}

    evidence = {
        "evidence_id": "ev1",
        "subject": {"name": "dir"},
        "confidence": "derived",
        "normalized_result": {
            "summary": {"ipc": {"operations": 2}},
            "graph": {"nodes": [
                node("package", "demo", {"name": "demo", "version": "1.2.3", "main": "src/main.js"}),
                node("electron-main", "src/main.js", {"resolved_path": "src/main.js", "mechanism": "package.json:main"}),
                node("ipc-handler", "get-info", {"channel": "get-info", "side": "main", "operation": "handle"}, "src/main.js", 2),
                node("ipc-channel", "get-info", {"channel": "get-info", "side": "renderer", "operation": "invoke"}, "src/preload.js", 3),
                node("context-bridge-api", "api", {"api_key": "api", "world": "main"}, "src/preload.js", 2),
                node("javascript-module", "src/main.js", {"semantic_role": "source-module", "path": "src/main.js", "module_format": "commonjs"}),
                node("javascript-module", "electron", {"semantic_role": "module-reference", "declared_specifier": "electron", "resolution_status": "external"}),
                node("native-addon", "build/Release/keytar.node", {}),
            ]},
            "limitations": ["static only"],
        },
    }
    p = project_javascript_analysis(evidence)
    assert p["application"] == {"name": "demo", "version": "1.2.3", "main": "src/main.js"}
    assert p["entrypoints"] == [{"type": "main", "path": "src/main.js", "mechanism": "package.json:main"}]
    assert {c["side"] for c in p["ipc_channels"]} == {"main", "renderer"}
    assert p["ipc_channels"][0]["location"] == "src/main.js:2"
    assert p["context_bridge_apis"][0]["api"] == "api"
    assert p["external_modules"] == ["electron"]
    assert p["native_addons"][0]["label"] == "build/Release/keytar.node"
    assert p["limitations"] == ["static only"]


# --------------------------------------------------------------------------- live REA (slow)

@pytest.fixture
def sample_app():
    root = _settings().rea_workspace_root / "sample-app"
    (root / "src").mkdir(parents=True, exist_ok=True)
    (root / "package.json").write_text('{"name":"sample-app","version":"1.0.0","main":"src/main.js"}')
    (root / "src" / "main.js").write_text(
        "const { app, ipcMain } = require('electron');\n"
        "ipcMain.handle('get-system-info', async () => ({ platform: process.platform }));\n"
    )
    (root / "src" / "preload.js").write_text(
        "const { contextBridge, ipcRenderer } = require('electron');\n"
        "contextBridge.exposeInMainWorld('api', { info: () => ipcRenderer.invoke('get-system-info') });\n"
    )
    return root


@needs_rea
def test_live_javascript_analysis(client, sample_app):
    resp = client.post("/api/v1/rea/javascript", json={"path": "sample-app"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["application"]["name"] == "sample-app"
    channels = {(c["channel"], c["side"]) for c in body["ipc_channels"]}
    assert ("get-system-info", "main") in channels and ("get-system-info", "renderer") in channels
    full = client.get(f"/api/v1/rea/results/{body['result_id']}").json()
    assert full["evidence_id"] == body["evidence_id"]


@needs_rea
def test_live_javascript_analysis_rejects_outside_path(client):
    resp = client.post("/api/v1/rea/javascript", json={"path": "../../"})
    assert resp.status_code == 403


@needs_rea
def test_live_mcp_tools_and_destructive_gate(client, sample_app):
    tools = client.get("/api/v1/rea/tools").json()
    assert tools["count"] > 50
    by_name = {t["name"]: t for t in tools["tools"]}
    assert by_name["gdb_console"]["destructive"] is True and by_name["gdb_console"]["allowed"] is False
    blocked = client.post("/api/v1/rea/tools/call", json={"name": "gdb_console", "arguments": {}})
    assert blocked.status_code == 403
    result = client.post("/api/v1/rea/tools/call", json={
        "name": "analyze_javascript_application",
        "arguments": {"input_path": "sample-app"},
    })
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["is_error"] is False
    assert body["content"] or body["structured"]
