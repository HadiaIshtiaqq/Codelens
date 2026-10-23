# CodeLens AI + REA

**Watch your Python run, ask Alexa why it crashed, and get a fix that is tested before you trust it.**
Built for the *Build, Ship, Shape: Amazon Developer Hackathon* (Alexa+ track).

| | |
|---|---|
| 🌐 **Live demo** | **https://codelens-ctxh.onrender.com**. Judges: use the link with the access code from the Devpost submission. Free hosting sleeps when idle, so the first load can take up to a minute. |
| 🔌 **Alexa+ / MCP endpoint** | `https://codelens-ctxh.onrender.com/mcp` (Streamable HTTP, MCP 2025-11-25+, header `Authorization: Bearer <access code>`) |
| 🎬 **Demo video** | See the Devpost submission |
| 📄 **License** | [MIT](LICENSE) |

**Try it in 30 seconds:** open the live demo → **🔵 Alexa+** → type **"debug my code"**.

- Alexa runs the program, diagnoses the crash, writes a fix and tests it.
- **Lexi** flies to the buggy line and points at it.
- **🤖 Robo Lab**, **🎮 Game** and **📋 Classic** are three ways to watch the same run, step by step.

A Python debugging and reverse-engineering workspace:

- **Trace** Python in a sandbox with `sys.settrace`: every call, line, return, exception and print, with variable snapshots.
- **🔵 Alexa+ simulator:** say "Alexa, run my code", "why did it crash?", "what is total?", "fix it" or "test the fix".
  - Each question becomes a real MCP tool call over Streamable HTTP to the CodeLens MCP server (protocol 2025-11-25 or later).
  - The answer comes back as speech plus a visual card.
  - A live panel shows every MCP request and response.
  - **Autopilot:** say "debug my code" and Alexa plans and chains the tools herself (run → diagnose → fix → test the fix with tests generated from the run), showing each step as "🧭 Alexa's plan". With an AI key the AI chooses the steps; without one a fixed plan runs the same chain.
  - **Lexi**, Alexa's character, speaks the answers (her mouth moves with the voice) and flies to the code page to point at the line an answer is about. Ask "show me the error" or "where did it stop?", or press 👉 Show me.
- **🐢 Turtle drawing:** `import turtle` works in the sandbox, and the picture is drawn step by step with the code, in Robo Lab and on Game mode's Drawing board. It was designed after studying Scratch's pen and motion engine with REA ([`docs/REA_SCRATCH_STUDY.md`](docs/REA_SCRATCH_STUDY.md)).
- **🤖 Robo Lab (the default view)**, built for an 8-year-old with no coding experience:
  - Every step is one plain sentence about what just happened: "📦 Make a new box called apples: 3", "🔁 Loop: take the next one from the pets box. pet is “dog”", "❓ Question: is the temperature box bigger than 25? Yes!".
  - Values are shown as labeled cardboard boxes, and lists as trains with numbered cars.
  - A **💡 New idea** card appears the first time each concept shows up (box, list, loop, if, trick…).
  - Errors get gentle **"Oops!"** messages that say how to fix them.
  - **Press ▶ Start and Robo walks through the program by itself**, at a pace you pick: 🐢 slow, 🚶 normal, 🐇 fast, or ✋ "I press Next". Next, Back or ⏸ Pause take over at any time, and Robo lingers on new idea cards.
  - A **🚩 → 🏁 progress track** can be dragged to any step. **Space** plays or pauses, and **← →** step. When the program ends, **🔁 Watch again** replays it.
  - Sentences can be read aloud (with a voice picker). There are big buttons, and 10 starter programs from "Hello, robot!" to "Find the bug!".
  - **🧩 Blocks:** build programs by snapping blocks together (Blockly) instead of typing. The blocks become real Python, which Robo runs and explains.
  - **🏆 Challenges:** 8 missions, from "Say hello" to "Teach a trick". Each is checked automatically when you press Start, with kind hints and ⭐ stars.
  - **🔧 Help me fix it** repairs typing slips (a missing `:`, quote or bracket, wrong indentation, `=` instead of `==`) and common runtime bugs, then explains what changed.
  - **Idea cards are remembered** once a child taps "Got it!". A **progress code** carries stars, learned ideas and XP to another computer.
- **Play it like a game.** The code and the simulation sit side by side. A 🤖 robot walks through your code, and the **🃏 Cards** board writes every variable out: dicts as label → value rows, lists as numbered items, with changed values highlighted and shared objects called out. The **🔗 Arrows** board shows each function call as a room and lists, dicts and objects as boxes linked by arrows, shrinking to fit the panel. Crashes explode 💥, clean runs end in 🏁 confetti, and there's autoplay with speed control. **Predict mode** awards XP for guessing which line runs next, with streaks, levels and achievements. A Classic view (editor, variables table, call stack, timeline) is one click away.
- **A one-line explanation for every step**, shown right beside the active line, for example `total += xs[i]  ◀ Adds xs[i] to total → total = 175`. It's built from the code's syntax tree plus real values from the trace, never guessed. **📖 Explain every line** annotates the whole program.
- **Real programs:**
  - `input()` reads from a **Program input** box and echoes like a terminal.
  - **Multi-file projects:** add up to 10 modules (`utils.py`…) that `main.py` imports, and the robot follows into them.
  - **numpy** is available in the sandbox.
- **Long runs:** traces keep the first 300 and the most recent 700 steps, so the end of a long loop (and its crash) is always visible; skipped parts are marked.
- **Share** any program, including its extra files and input, as a compressed link (it lives in the URL fragment, never on the server).
- **Breakpoints:** click the gutter beside a line number. **⏩ Continue** (F8) jumps to the next time a breakpoint line runs and **⏪** (Shift+F8) jumps back. F9 toggles a breakpoint on the current line, and autoplay pauses at breakpoints.
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
# macOS / Linux: ./scripts/setup.sh  then  ./scripts/start.sh
.\scripts\start.ps1      # http://127.0.0.1:8000  (UI + API, docs at /docs)
.\scripts\start.ps1 -Dev # also runs Vite with hot reload on http://localhost:5173
```

`start.ps1` uses the Docker sandbox when the `codelens-worker:latest` image exists. Otherwise it falls back to the **subprocess** sandbox, which has **no container isolation** (only a memory cap) and is meant for local development only.

## Deploying for the hackathon

Every public option is locked with an **access code**, because visitors run code on your machine.

- **Judges:** send them a link that ends in `#access=<code>`. The code is saved and removed from the address bar.
- **Alexa+ and other MCP clients:** they send the code as `Authorization: Bearer <code>` to `https://<host>/mcp`.

### Option A: a free permanent link on Render (opens on any computer)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/HadiaIshtiaqq/Codelens)

1. Click the button. Sign in with GitHub, which is free and needs no card.
2. Render reads [`render.yaml`](render.yaml) and asks for two values:
   - `CODELENS_ACCESS_CODE`: for example `judges:pick-a-long-code`.
   - `GEMINI_API_KEY`: optional; a free key from aistudio.google.com/apikey.
3. Click **Apply**. The first build takes about 5–10 minutes. Your app is then at `https://<name>.onrender.com`, and judges open `https://<name>.onrender.com/#access=pick-a-long-code`.

Free Render apps sleep after 15 minutes without visitors, and the next visit takes about a minute to wake them. Every push to `main` redeploys automatically. Alexa+ / MCP clients use `https://<name>.onrender.com/mcp` with `Authorization: Bearer pick-a-long-code`.

Render can't start Docker containers, so programs run in the **subprocess sandbox** ([`deploy/hosted/Dockerfile`](deploy/hosted/Dockerfile)): a separate, memory-limited Python process with an empty environment. The server also makes itself non-dumpable, so user programs can't read its secrets through `/proc`. The access code keeps strangers out. For full container isolation, use option C.

(`scripts/deploy-hf.ps1` deploys the same image to Hugging Face Spaces, but Docker Spaces now need a PRO account there.)

### Option B: a public link from your own computer (one command)

Docker Desktop must be running and the sandbox image built (`scripts/setup.ps1` does both).

```powershell
.\scripts\go-public.ps1            # Windows
./scripts/go-public.sh              # macOS / Linux (needs cloudflared)
```

The script:
1. Opens a free HTTPS tunnel with no account needed. It tries a Cloudflare quick tunnel first, then falls back to localhost.run over SSH, which is built into Windows.
2. Creates an access code.
3. Starts the app and prints three things: the link for judges, the plain address with its code, and the Alexa+ endpoint.

It refuses to run without the Docker sandbox. The address changes every time it starts and lasts while your computer is on, so for a long judging period use option B.

### Option C: a server (any Linux VM with Docker, 2 GB of RAM)

Free platforms like Render or Vercel can't start Docker containers, so they won't work.

```bash
git clone https://github.com/HadiaIshtiaqq/Codelens && cd Codelens
export CODELENS_ACCESS_CODE="judges:$(openssl rand -hex 6)"   # required: compose won't start without it
docker compose up -d --build                                   # http://<server-ip>:8000

# Automatic HTTPS: point a DNS name at the server first. /mcp then answers on that name too.
CODELENS_DOMAIN=demo.example.com docker compose --profile https up -d --build
```

- **One image** contains the UI, the API and `/mcp`. Every run still happens in its own network-less, read-only `codelens-worker` container, started through the host's Docker socket.
- **Access codes:** give each group its own code, for example `CODELENS_ACCESS_CODE=judges:abc123,team:xyz789`, so you can revoke one by removing it.
- **Rate limits** count each visitor separately, even behind the HTTPS proxy or a tunnel.
- **Non-root:** the app container runs as an unprivileged user. On Linux, pass the host's docker group: `DOCKER_GID=$(getent group docker | cut -d: -f3) docker compose up -d`.
- **Upgrading from a version before the non-root change:** the old data volume belongs to root. Run `docker compose down -v` once (this deletes stored runs).
- **Retention:** stored runs expire after 72 h (`CODELENS_RETENTION_HOURS`), and the 🗑 **delete run** button removes one immediately.

### Connecting Alexa+

Register the MCP server as **Streamable HTTP** at `https://<your-host>/mcp` (the live demo: `https://codelens-ctxh.onrender.com/mcp`), with the header `Authorization: Bearer <access code>`. The server negotiates MCP protocol 2025-11-25 or later and offers 19 tools; the six "voice" tools return a short `speech` answer. [`server.json`](server.json) describes the live endpoint for MCP registries.

## Configuration

Copy `backend/.env.example` to `backend/.env`. The main settings:

| Variable | Purpose |
| --- | --- |
| `CODELENS_SANDBOX` | `docker` (production) or `subprocess` (dev) |
| `GEMINI_API_KEY` | Enables Google Gemini (free tier: get a key at aistudio.google.com/apikey). Alexa's open questions, explanations and fixes then come from the AI, grounded in the code and the trace. Leave `GEMINI_MODEL` empty to pick the newest Flash model |
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

The CodeLens MCP server exposes 19 tools over the REST API:

| Group | Tools |
| --- | --- |
| Agent (plans and chains the other tools by itself) | `debug_autopilot`: run → diagnose → propose a fix → test it with tests generated from the run; with an AI key the model chooses the steps through function calling |
| Conversational (voice-ready, each returns a short `speech` string) | `ask_about_code`, `explain_code`, `get_execution_state`, `get_variable_state`, `get_debugging_summary`, `propose_fix`, `validate_fix` |
| Debugging | `run_python`, `get_trace`, `get_step_state`, `get_source`, `explain_execution`, `propose_patch`, `validate_patch` |
| Reverse engineering | `rea_analyze_javascript_application`, `rea_list_tools`, `rea_tool_schema`, `rea_call_tool` |

- **Same server, `/mcp`:** the main app serves the MCP server at `http://<host>:8000/mcp` (Streamable HTTP), guarded like the REST API. The in-app Alexa+ simulator uses it. For a public deployment, set `CODELENS_ACCESS_CODE`, put the app behind HTTPS and list your domain in `CODELENS_MCP_PUBLIC_HOSTS`.
- **Claude Code:** the repo's [`.mcp.json`](.mcp.json) registers the server automatically when you open the project, on Windows, macOS or Linux (it runs `scripts/mcp.mjs`, which finds the backend's Python). Keep the API running on port 8000.
- **Remote agents / Alexa+ (Streamable HTTP, endpoint `/mcp`):**
  ```powershell
  $env:CODELENS_MCP_TOKEN = "<long random secret>"
  $env:CODELENS_MCP_PUBLIC_HOSTS = "your-tunnel.example.com"
  cd backend; .\.venv\Scripts\python -m app.mcp_server --http --host 0.0.0.0 --port 8765
  ```
  Clients must send `Authorization: Bearer <token>`. The server refuses to listen publicly without a token, and DNS-rebinding protection stays on. Put it behind HTTPS (a tunnel or reverse proxy).
- **Registry manifest:** [`server.json`](server.json), pointing at the live endpoint `https://codelens-ctxh.onrender.com/mcp`.

## Reverse engineering

1. Copy a target into `rea-workspace/`. This can be an extracted Electron app, an `.asar` file or a binary. `sample-app/` is included.
2. Open **Reverse Engineering**, select the target and click **Analyze**. You'll see IPC channels, entrypoints, context-bridge APIs, modules, native add-ons and the full evidence JSON.
3. Use the **Tool explorer** for any of REA's 207 MCP tools. Native decompilation tools need Ghidra (`GHIDRA_INSTALL_DIR`), Hopper or IDA; the engines panel shows what is installed and how to enable the rest.

## Tests

```powershell
cd backend;  .\.venv\Scripts\python -m pytest     # 141 tests (REA and Docker tests skip if REA isn't installed or the sandbox image isn't built)
cd frontend; npm test; npm run typecheck
cd frontend; npm run e2e                          # 30 browser checks against a running app (Chrome required)
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
| POST | `/api/v1/ai/selftest` | One real call to the configured provider (proves Nebius is live; shows latency) |
| GET | `/api/v1/rea/status` · `/workspace` · `/tools` · `/tools/{name}` | REA readiness, workspace, tool catalogue |
| POST | `/api/v1/rea/javascript` · `/api/v1/rea/tools/call` | JS/Electron analysis, any REA tool |

## Hackathon checklist

**Build, Ship, Shape: Amazon Developer Hackathon** (Alexa+ track). Draft Devpost answers are in [`SUBMISSION.md`](SUBMISSION.md).

| Requirement | Where |
| --- | --- |
| Self-hosted MCP server, spec 2025-11-25+, Streamable HTTP | `backend/app/mcp_server.py`, served at `/mcp` by `backend/app/main.py`; tests: `backend/tests/test_mcp_http.py` |
| The repo calls the track's technology in code | MCP server entry points above; browser MCP client `frontend/src/lib/mcpClient.ts` |
| Simulated Alexa+ experience (source included) | `frontend/src/components/AlexaView.tsx` (🔵 Alexa+ tab) |
| Open-source license | [`LICENSE`](LICENSE) (MIT) |
| Product feedback, friction log (bonus) | [`SUBMISSION.md`](SUBMISSION.md), [`FRICTION_LOG.md`](FRICTION_LOG.md) |
| Working demo | Live at https://codelens-ctxh.onrender.com (free Render plan, [`render.yaml`](render.yaml)); the MCP server answers at `/mcp` |
| Agentic behaviour | Alexa's autopilot ([`backend/app/services/agent.py`](backend/app/services/agent.py), MCP tool `debug_autopilot`) plans and chains run → diagnose → fix → test |

**Nebius × NVIDIA:**

| Requirement | Where |
| --- | --- |
| Nebius Token Factory + NVIDIA model | `NEBIUS_API_KEY`, `NEBIUS_MODEL`; set `CODELENS_REQUIRE_PROVIDER=1` and check `POST /api/v1/ai/selftest` before recording |
| Agentic chain (sandbox → trace evidence → diagnosis → diff → test validation) | Debugger tab, or the MCP tools in order |
| MCP entry point (Alexa+) | `backend/app/mcp_server.py`, `.mcp.json`, `server.json` |
| Open-source license | [`LICENSE`](LICENSE) (MIT; all dependencies are MIT/BSD) |
| Friction logs (bonus) | [`FRICTION_LOG.md`](FRICTION_LOG.md), with Nebius and AWS sections to fill in from real use |

Still on you: the demo video (under 3 minutes), and submitting on Devpost with the judges' link.

## Known limits

- **One server process.** Storage is a SQLite file and rate limits live in memory, which is right for a demo or classroom server. Several replicas would need Postgres and Redis.
- **Python only.** CodeLens runs and explains Python; code in other languages is recognised and the user is told to write it in Python.
- **Sandbox libraries:** the standard library, numpy and pytest. Other packages would have to be added to `backend/worker/Dockerfile` (the network is off at run time).
- **Per-run limits:** 5 s and up to 20,000 traced steps per run (`CODELENS_TRACE_BUDGET`). Longer programs keep running after tracing pauses, and their output and final crash are still recorded.
- **No user accounts.** Progress lives in the browser and moves between devices with a progress code. Hosted demos are protected by shared, revocable access codes, not personal logins.
- **English only.** The kid explanations, idea cards and challenges are written in English.
- **Explanations are rule-based** (syntax tree + recorded values, so never invented). Unusual code gets more generic sentences; the optional AI explains failures in more depth.
- **Docker sandbox verified:** it passes the spec §5.3 security matrix (`tests/test_docker_sandbox.py`) on Docker Desktop for Windows and on Linux.
