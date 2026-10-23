# Friction Log

Problems hit while building CodeLens AI + REA, with what we did about them. Entries are dated and describe what actually happened; the sections marked **TODO** are still waiting on real usage.

## REA (`rea-agents` 6.7.0)

| # | Friction | Impact | Workaround / fix |
| --- | --- | --- | --- |
| R1 | Our spec used `rea analyze-javascript-application <path> --json`, but the CLI has no `--json` flag. JSON output is `--format json`. | First integration attempt failed | Read `rea <command> --help`; use `--format json` everywhere (`backend/app/services/rea.py`). |
| R2 | On Windows, the first `npx -y rea-agents@latest` call was cut off partway through the install (~170 packages, native add-on prebuild). The next run failed with `ENOENT … _npx\<hash>\package.json`. | `npx` was unusable until the cache entry was deleted | Pinned `rea-agents@6.7.0` as a local dependency in `rea/package.json` and launch `node rea/node_modules/rea-agents/scripts/rea.mjs`. This is reproducible and avoids a network fetch per call. |
| R3 | How to start the MCP server wasn't obvious from the top-level help: it's the global `--mcp` flag (`rea --mcp`). `rea mcp` only registers it with clients. | Time spent reading help output | Documented in `services/rea.py`. |
| R4 | REA prints progress as JSON lines (`{"rea_progress": …}`) on stderr, mixed with real errors. | Error messages were buried in progress noise | Filter lines containing `rea_progress` before showing errors. |
| R5 | Analysis output is a large evidence document (~150 KB for a 3-file app) with deeply nested `normalized_result.graph.nodes[].observations[].evidence…`. | Too large to send straight to a UI or an agent | Wrote a projection (IPC channels, entrypoints, context-bridge APIs, modules, native add-ons); the full evidence stays at `/api/v1/rea/results/{id}`. |
| R6 | `rea doctor` on Windows reported 2/17 checks ready. Hopper, Ghidra, IDA, JADX and others each need a separate install or env var. | Native decompilation unavailable out of the box | The UI shows each check's remediation text. JS/Electron analysis works with Node alone. |
| R7 | 207 MCP tools, including debuggers, Frida and write-back tools. | Exposing all of them to a web UI or a voice agent is risky | **Positive:** REA sets MCP `destructiveHint` annotations accurately, so we block destructive tools by default (`REA_ALLOW_DESTRUCTIVE=1` to enable) and confine path arguments to `rea-workspace/`. |
| R8 | MCP server startup is ~2 s. | A fresh session per call made tool calls slow | One persistent stdio session on a background event loop. |

### R9 (2026-10-23): analysing a large real-world package

- **Task:** study Scratch's drawing engine (`scratch-vm` 5.0.300, 25 MB unpacked) with REA, to design the turtle stage.
- **Steps:** `npm pack scratch-vm`, extract into `rea-workspace/`, then call the MCP tool `rea_analyze_javascript_application` on `scratch-vm-pkg/package`, then on `…/package/src`.
- **Expected:** an analysis, or an error saying the input was too large.
- **Actual:** both calls returned only `Error executing tool rea_analyze_javascript_application`, with no reason. The CLI on a single extension folder (`src/extensions/scratch3_pen`) worked in seconds.
- **Severity:** medium (blocked until we guessed it was about size).
- **Workaround:** analyse the two relevant folders separately with the CLI (evidence ids in `docs/REA_SCRATCH_STUDY.md`).
- **Suggestion:** include the failing phase and any size or time limit in the MCP error text, and offer an include-glob parameter for big packages.

## MCP Python SDK (`mcp` 2.3.0)

| # | Friction | Workaround |
| --- | --- | --- |
| M1 | `from mcp.server.fastmcp import FastMCP` raises in 2.x; it was renamed to `MCPServer` (`mcp.server.mcpserver`). The error message links the migration guide, which helped. | Use `MCPServer`. |
| M2 | Streamable HTTP rejects non-localhost `Host` headers (HTTP 421, DNS-rebinding protection), which would block a public tunnel URL for Alexa+. | Pass `TransportSecuritySettings(allowed_hosts=…)` from `CODELENS_MCP_PUBLIC_HOSTS`, keeping protection on. |

### M3 (2026-10-23): mounting Streamable HTTP inside the existing FastAPI app

- **Task:** serve the MCP server at `/mcp` on the main web server, so Alexa+ and the in-app simulator share one host and port.
- **Steps:** `app.mount("/mcp", mcp.streamable_http_app(...))` and `async with mcp.session_manager.run()` in the FastAPI lifespan. Then run the test suite, which starts the app several times.
- **Expected:** each app start runs the session manager again.
- **Actual:** `RuntimeError: StreamableHTTPSessionManager .run() can only be called once per instance` on the second start. Separately, a test that opened its own app lifespan closed the shared test database on exit, failing 24 other tests.
- **Severity:** medium (production starts once; tests and dev reloads start many times).
- **Workaround:** a tiny ASGI wrapper rebuilds `streamable_http_app()` (and so a fresh session manager) at every startup (`_McpEndpoint` in `backend/app/main.py`); tests use the shared client fixture.
- **Suggestion:** make the session manager restartable, or document a "mount into an existing app" helper that owns this.

## Nebius Token Factory — **TODO: fill in during the real integration**

The adapter is implemented and tested against a mocked OpenAI-compatible endpoint only.

- **Model IDs are a moving target (2026-10-21):** public sources disagreed on the Nemotron model ID (`nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3.5-Super-VL`, …) and on the host (`api.tokenfactory.nebius.com` vs a region-specific `api.tokenfactory.us-central1.nebius.com`). Fix: when `NEBIUS_MODEL` is empty, CodeLens reads the live `/models` catalogue and picks a Nemotron text model itself.

Things to record when the real key is used:

- Was the default base URL (`https://api.tokenfactory.nebius.com/v1`) correct?
- Exact model ID for the Nemotron model used (default guess: `nvidia/Llama-3_3-Nemotron-Super-49B-v1_5`).
- Was `response_format: {"type": "json_object"}` honoured? Did the model wrap JSON in `<think>` blocks or code fences? (The parser tolerates both.)
- Latency from `POST /api/v1/ai/selftest`, rate limits, error formats.

## Alexa+ — **TODO: fill in when connecting the real Alexa+ preview**

Done so far: the MCP server is served at `https://<host>/mcp` (Streamable HTTP, protocol 2025-11-25 or later), and the in-app Alexa+ simulator drives it over the same protocol. Record here the task, steps, expected against actual, severity, workaround and suggestion for: registering the endpoint with Alexa+, authentication, how utterances reach the tools, and latency.

## Hosting and AI providers (2026-10-23)

### H1: Hugging Face Docker Spaces now need PRO

- **Task:** host CodeLens free and permanently for judges.
- **Steps:** created a Docker Space through the Hub API (`POST /api/repos/create`, `sdk: docker`) with a write token.
- **Expected:** a free CPU Space, as the documentation suggests.
- **Actual:** HTTP 402-style refusal: "hosting Gradio and Docker Spaces on free cpu-basic requires a PRO subscription".
- **Severity:** high (blocked the planned host).
- **Workaround:** deployed the same image on Render's free plan with a `render.yaml` blueprint.
- **Suggestion:** state the PRO requirement on the Spaces docs and SDK pages before account creation.

### H2: Cloudflare quick tunnels timed out from this network

- **Task:** share the app from the laptop with a free HTTPS link.
- **Steps:** `cloudflared tunnel --url http://127.0.0.1:8000` (2026.x).
- **Expected:** a `*.trycloudflare.com` address within seconds.
- **Actual:** `failed to request quick Tunnel … context deadline exceeded`, every time. The same POST with `curl` succeeded in about 5 s.
- **Severity:** medium.
- **Workaround:** fall back to localhost.run over the SSH built into Windows (`scripts/go-public.ps1`).
- **Suggestion:** make cloudflared's quick-tunnel request timeout configurable.

### G1: Gemini free tier, 20 requests a day on the default Flash model

- **Task:** answer Alexa's questions with Gemini through its OpenAI-compatible endpoint.
- **Steps:** auto-picked the newest stable Flash model from `/models`, then switched to `gemini-3-flash-preview`.
- **Actual:**
  - the newest stable Flash took 80–90 s or returned 503 "high demand";
  - the preview model was fast (2–5 s), but its free quota is "limit: 20" requests a day, and tests used it up;
  - lite models answered in 10–25 s.
- **Severity:** high for live demos.
- **Workaround:**
  - retries with back-off on 429/503;
  - a 30 s timeout, after which the rule-based answer is used;
  - fewer AI calls per autopilot run;
  - tests run with the AI switched off.
- **Suggestion:** show per-model free quotas next to `/models`, and return the quota in a response header.

## AWS — not used

No AWS services are used yet.

## Other tooling

| # | Friction | Workaround |
| --- | --- | --- |
| O1 | The Python Tutor source repository (`pgbovine/OnlinePythonTutor`) has been removed from GitHub, so it couldn't be studied with REA. | Re-implemented its frames-and-objects visualization from its publicly known behaviour; no third-party code copied. |
| O2 | Docker Desktop's daemon wasn't running (`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`). | `subprocess` dev sandbox, clearly flagged in the UI; the Docker runner explains this error in plain words. |
| O3 | `@monaco-editor/react` `DiffEditor` threw "TextModel got disposed before DiffEditorWidget model got reset" on unmount. | `keepCurrentOriginalModel` / `keepCurrentModifiedModel`. |
| O4 | Monaco silently ignores `after` injected text on empty ranges unless `showIfCollapsed: true` is set. | Set it. Found by reading `textModel.js`. |
| O6 | Real pytest inside the read-only sandbox failed to write its cache, and fd-level output capture would collide with the worker's result channel. | `-p no:cacheprovider --capture=sys`, test files written to the tmpfs `/tmp`. |
| O7 | Starlette's `StaticFiles` passes OS-specific paths (`assets\\x.js` on Windows), so a `startswith("assets/")` cache rule silently never matched. | Normalise separators. |
| O8 | Docker Compose validates `${VAR:?required}` even for services in inactive profiles, so `docker compose build` failed without an unrelated MCP token. | Use defaults; the MCP server itself refuses to listen publicly without a token. |
| O9 | Typing code into Monaco in browser tests triggers auto-indent, mangling multi-line programs. | Tests load programs through share links instead. |
| O5 | Docker Desktop (Windows/WSL2): the first container after the daemon starts took ~10 s, so it overran our 5 s budget plus 2 s grace and was killed as a timeout. | Docker-specific 10 s startup grace (the 5 s user-code limit is enforced inside the worker), plus a warm-up container at server start. |
