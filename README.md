# CodeLens AI + REA

A Python debugging and reverse-engineering workspace:

- **Trace** Python in a sandbox with `sys.settrace`: every call, line, return, exception and print, with variable snapshots.
- **Play it like a game.** A 🤖 robot walks through your code. Each function call is a room, and lists, dicts and objects are boxes linked by arrows, so aliasing is visible. Crashes explode 💥, clean runs end in 🏁 confetti, and there's autoplay with speed control. **Predict mode** awards XP for guessing which line runs next, with streaks, levels and achievements. A Classic view (editor, variables table, call stack, timeline) is one click away.
- **A one-line explanation for every step**, shown right beside the active line, for example `total += xs[i]  ◀ Adds xs[i] to total → total = 175`. It's built from the code's syntax tree plus real values from the trace, never guessed. **📖 Explain every line** annotates the whole program.
- **Real programs:**
  - `input()` reads from a **Program input** box and echoes like a terminal.
  - **Multi-file projects:** add up to 10 modules (`utils.py`…) that `main.py` imports, and the robot follows into them.
  - **numpy** is available in the sandbox.
- **Long runs:** traces keep the first 300 and the most recent 700 steps, so the end of a long loop (and its crash) is always visible; skipped parts are marked.
- **Share** any program, including its extra files and input, as a compressed link (it lives in the URL fragment, never on the server).
- **Breakpoints:** click the gutter beside a line number. **⏩ Continue** (F8) jumps to the next time a breakpoint line runs and **⏪** (Shift+F8) jumps back. F9 toggles a breakpoint on the current line, and autoplay pauses at breakpoints.
- **Convert code from any language** (JavaScript, Java, C/C++, C#, Go, Rust and 20+ more) to Python or between other languages with the AI, then press **🎮 Run & visualize** to watch it run. If you paste non-Python code into the debugger, it offers to convert it. Python output is checked to make sure it parses.
- **Explain** failures with evidence-grounded AI. The facts are read from the trace, never invented by the model.
- **Patch** the failure as a unified diff, then **validate** it with **real pytest** (fixtures, parametrize, `pytest.raises`) in a fresh sandbox. Starter tests are **generated from your run**: calls that worked become regression tests, and the call that crashed must stop crashing.
- **Reverse engineer** JavaScript/Electron apps and native binaries with [REA](https://www.npmjs.com/package/rea-agents) (207 MCP tools). The tab is hidden by default; set `CODELENS_SHOW_REA=1` to show it. The REA API and MCP tools are always available.
- **Agent access**: everything above is exposed as an MCP server for Claude Code and other agents.

```
frontend/   React + TypeScript + Monaco + Tailwind workspace
backend/    FastAPI API, sandbox runners, evidence compiler, LLM adapter, REA bridge, MCP server
  worker/   trace worker (stdlib only) + Dockerfile for the sandbox image
rea/        pinned rea-agents toolchain (npm)
rea-workspace/  the only directory REA may read (contains a sample Electron app)
scripts/    setup / start helpers
```

## Quick start (Windows)

Prerequisites: Python 3.11+, Node.js 22.19+ / 24.11+, and Docker Desktop (optional but recommended).

```powershell
.\scripts\setup.ps1      # venv, npm installs, UI build, sandbox image if Docker is running
.\scripts\start.ps1      # http://127.0.0.1:8000  (UI + API, docs at /docs)
.\scripts\start.ps1 -Dev # also runs Vite with hot reload on http://localhost:5173
```

`start.ps1` uses the Docker sandbox when the `codelens-worker:latest` image exists. Otherwise it falls back to the **subprocess** sandbox, which has **no container isolation** (only a memory cap) and is meant for local development only.

## Hosting a public demo

Use any Linux VM with Docker (a small cloud VM with 2 GB of RAM is plenty). Free platforms like Render or Vercel can't start Docker containers, so they won't work.

```bash
git clone <your repo> && cd codelens-ai
cp backend/.env.example backend/.env    # set NEBIUS_API_KEY and CODELENS_ACCESS_CODE
docker compose up -d --build            # http://<server-ip>:8000

# Automatic HTTPS (point a DNS name at the server first):
CODELENS_DOMAIN=demo.example.com docker compose --profile https up -d

# MCP endpoint for Alexa+ / remote agents (https://<host>:8765/mcp, Bearer token):
CODELENS_MCP_TOKEN=<secret> CODELENS_MCP_PUBLIC_HOSTS=demo.example.com docker compose --profile mcp up -d
```

- **One image** contains the UI and the API. Every run still happens in its own network-less, read-only `codelens-worker` container, started through the host's Docker socket.
- **Access code:** set `CODELENS_ACCESS_CODE` so strangers can't spend your AI credits. Visitors are asked for the code once, so give it to the judges.
- **Retention:** stored runs expire after 72 h (`CODELENS_RETENTION_HOURS`), and the 🗑 **delete run** button removes one immediately.

## Configuration

Copy `backend/.env.example` to `backend/.env`. The main settings:

| Variable | Purpose |
| --- | --- |
| `CODELENS_SANDBOX` | `docker` (production) or `subprocess` (dev) |
| `NEBIUS_API_KEY` | Enables Nebius Token Factory. Leave `NEBIUS_MODEL` empty to auto-pick a Nemotron model from your account's `/models` list |
| `OLLAMA_MODEL` | Use a local Ollama model instead |
| `CODELENS_LLM_PROVIDER` | `auto` (default), `nebius`, `ollama`, or `offline` |
| `CODELENS_REQUIRE_PROVIDER=1` | Never fall back to offline rules: provider failures return HTTP 502, so every answer provably comes from Nebius |
| `REA_WORKSPACE_ROOT` | Directory REA may read (default `rea-workspace/`) |
| `REA_ALLOW_DESTRUCTIVE=1` | Unlock REA tools annotated destructive (debuggers, Frida, write-back) |

**Without any AI key the app still works fully.** A deterministic offline engine explains common errors. It also generates AST-based fixes for these cases:

- `ZeroDivisionError` and `KeyError`
- off-by-one `IndexError`
- misspelled `NameError`
- `str`/`int` `TypeError`
- `x = x.sort()` (and other in-place methods) leaving `None`
- a missing `global`

Each fix explains its trade-offs.

If a configured provider fails or returns invalid JSON, the app falls back to the offline engine and marks the result `degraded`.

## How it works

| Spec requirement | Implementation |
| --- | --- |
| FR-01 evidence-grounded debugging | `worker/tracer.py` records the trace. `services/evidence.py` builds the evidence package and derives `observed_facts` deterministically. Model output is checked for line numbers and variables that don't exist. |
| FR-02 REA integration | `services/rea.py` runs the CLI (`doctor`, `analyze-javascript-application`) and keeps a persistent MCP session to `rea --mcp` |
| FR-03 stepping | SSE trace stream; the UI has Step Prev/Next/Reset, a slider and a timeline; keyboard shortcuts F10, Shift+F10, Alt+←/→, Alt+Home/End, Alt+E, Ctrl+Enter, plus breakpoints (F8, Shift+F8, F9) |
| Session store | SQLite (`backend/data/codelens.db`, `CODELENS_DB_PATH`), so executions, explanations and patches survive restarts; old rows are pruned |
| Rate quotas | Per-IP token bucket on run and AI endpoints (`CODELENS_RATE_LIMIT_PER_MIN`, default 60; HTTP 429 with `Retry-After`) |
| FR-04 safe inspection | `safe_value()` never calls user `__repr__`/`__getattr__`; values are capped at 1 KB; variable types are recorded |
| FR-05 patches | The LLM returns the full corrected file; the server validates it, computes the unified diff and checks that the diff applies. The original code is never modified. |
| FR-06 validation | Patched program plus `test_*` functions run in fresh sandboxes. The status is `validated` only when every test passes. The original program is tested too, as a before/after baseline. |
| FR-07 output cap | 4 MiB combined stdout+stderr, then a truncation marker |
| FR-08 MCP | `python -m app.mcp_server` (stdio or `--http`) |
| Sandbox (§3.4) | `--network none --cap-drop ALL --read-only --tmpfs /tmp:16m --memory 256m --cpus 0.5 --pids-limit 64 --user 10001`; 5 s in-worker deadline plus a parent watchdog; no host secrets passed in |

## Using it from agents (MCP): Claude Code and Alexa+

The CodeLens MCP server exposes 18 tools over the REST API:

| Group | Tools |
| --- | --- |
| Conversational (voice-ready, each returns a short `speech` string) | `explain_code`, `get_execution_state`, `get_variable_state`, `get_debugging_summary`, `propose_fix`, `validate_fix` |
| Debugging & conversion | `convert_code`, `run_python`, `get_trace`, `get_step_state`, `get_source`, `explain_execution`, `propose_patch`, `validate_patch` |
| Reverse engineering | `rea_analyze_javascript_application`, `rea_list_tools`, `rea_tool_schema`, `rea_call_tool` |

- **Claude Code:** the repo's [`.mcp.json`](.mcp.json) registers the server automatically when you open the project. Keep the API running on port 8000.
- **Remote agents / Alexa+ (Streamable HTTP, endpoint `/mcp`):**
  ```powershell
  $env:CODELENS_MCP_TOKEN = "<long random secret>"
  $env:CODELENS_MCP_PUBLIC_HOSTS = "your-tunnel.example.com"
  cd backend; .\.venv\Scripts\python -m app.mcp_server --http --host 0.0.0.0 --port 8765
  ```
  Clients must send `Authorization: Bearer <token>`. The server refuses to listen publicly without a token, and DNS-rebinding protection stays on. Put it behind HTTPS (a tunnel or reverse proxy).
- **Registry manifest:** [`server.json`](server.json). Replace `YOUR_GITHUB_USERNAME` and `YOUR_PUBLIC_HOST` before publishing.

## Reverse engineering

1. Copy a target into `rea-workspace/`. This can be an extracted Electron app, an `.asar` file or a binary. `sample-app/` is included.
2. Open **Reverse Engineering**, select the target and click **Analyze**. You'll see IPC channels, entrypoints, context-bridge APIs, modules, native add-ons and the full evidence JSON.
3. Use the **Tool explorer** for any of REA's 207 MCP tools. Native decompilation tools need Ghidra (`GHIDRA_INSTALL_DIR`), Hopper or IDA; the engines panel shows what is installed and how to enable the rest.

## Tests

```powershell
cd backend;  .\.venv\Scripts\python -m pytest     # 121 tests (REA and Docker tests skip if REA isn't installed or the sandbox image isn't built)
cd frontend; npm test; npm run typecheck
cd frontend; npm run e2e                          # 17 browser checks against a running app (Chrome required)
```

CI (`.github/workflows/ci.yml`) runs all three on every push, including the Docker security tests on Linux.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/v1/executions` | Run and trace code |
| POST | `/api/v1/executions/stream` | Same, streamed as SSE (`init`, `step`*, `complete`) |
| GET | `/api/v1/executions/{id}` · `/trace` · `/steps/{n}` · `/source` · `/test-template` | Summary, paged events, state at one step, source, generated starter tests |
| DELETE | `/api/v1/executions/{id}` | Delete a run and everything derived from it |
| POST | `/api/v1/explanations` | Evidence-grounded explanation |
| POST | `/api/v1/patches` · GET `/api/v1/patches/{id}` | Generate (or submit) a patch |
| POST | `/api/v1/patches/validate` | Run tests against the patch in a sandbox |
| POST | `/api/v1/convert` | Translate code between languages (Python output is syntax-checked) |
| POST | `/api/v1/ai/selftest` | One real call to the configured provider (proves Nebius is live; shows latency) |
| GET | `/api/v1/rea/status` · `/workspace` · `/tools` · `/tools/{name}` | REA readiness, workspace, tool catalogue |
| POST | `/api/v1/rea/javascript` · `/api/v1/rea/tools/call` | JS/Electron analysis, any REA tool |

## Hackathon checklist

| Requirement | Where |
| --- | --- |
| Nebius Token Factory + NVIDIA model | `NEBIUS_API_KEY`, `NEBIUS_MODEL`; set `CODELENS_REQUIRE_PROVIDER=1` and check `POST /api/v1/ai/selftest` before recording |
| Agentic chain (sandbox → trace evidence → diagnosis → diff → test validation) | Debugger tab, or the MCP tools in order |
| MCP entry point (Alexa+) | `backend/app/mcp_server.py`, `.mcp.json`, `server.json` |
| Open-source license | [`LICENSE`](LICENSE) (MIT; all dependencies are MIT/BSD) |
| Friction logs (bonus) | [`FRICTION_LOG.md`](FRICTION_LOG.md), with Nebius and AWS sections to fill in from real use |

Still on you: hosting the demo (see above), the 3-minute videos, and sharing the repository with the reviewers.

## Known limits

- **One server process.** Storage is a SQLite file and rate limits live in memory, which is right for a demo or classroom server. Several replicas would need Postgres and Redis.
- **Python only for simulation.** Other languages are simulated by converting them to Python with the AI, so you watch the converted program.
- **Sandbox libraries:** the standard library, numpy and pytest. Other packages would have to be added to `backend/worker/Dockerfile` (the network is off at run time).
- **Per-run limits:** 5 s and up to 20,000 traced steps per run (`CODELENS_TRACE_BUDGET`). Longer programs keep running after tracing pauses, and their output and final crash are still recorded.
- **Progress is per browser.** XP and achievements are stored in the browser, because there are no user accounts.
- **Docker sandbox verified:** it passes the spec §5.3 security matrix (`tests/test_docker_sandbox.py`) on Docker Desktop for Windows and on Linux.
