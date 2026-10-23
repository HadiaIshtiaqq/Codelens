# CodeLens AI: Devpost submission (Build, Ship, Shape: Amazon Developer Hackathon)

> Draft answers for the Devpost form. Items marked **[YOU]** need the team's own input
> (links, accounts, first-hand opinions) before submitting.

## Track and challenges

- **Primary track: Alexa+.** Path: a self-hosted **MCP server** over **Streamable HTTP**, negotiating
  MCP protocol **2025-11-25** or later, plus an in-app **Alexa+ simulator** that talks to that server.
- **Mini challenge, Open Source:** the repository is public under the MIT license. The challenge asks for an
  *additional* open-source project or contribution made during the hackathon window, with its own URL. **[YOU]**
  Add that URL, or leave this challenge out.
- **Mini challenge, AWS Builder:** not entered. CodeLens does not call any AWS service today.

## What it does

CodeLens AI lets anyone, from an 8-year-old to a professional, **watch their Python run**
and **ask about it out loud**.

- **Ask Alexa about your code.** "Alexa, run my code." "Why did it crash?" "What is total?"
  "Fix it." "Test the fix." Alexa answers in one or two spoken sentences built from a recorded trace
  of the real run, so it never guesses: "The program crashed with an IndexError on line 4: list index
  out of range." "total is 247. Over the run it went: 0, then 90, then 162, then 247."
- **See every step.** A sandbox records every line, call, return, exception and variable. The web app
  replays the run side by side with the code:
  - **Kids mode:** a robot called Robo explains each step in plain words and reads them aloud.
  - **Game mode:** each variable gets its own card, with arrows between objects and a turtle drawing stage.
  - **Classic:** a conventional debugger view.
- **Fix with evidence.** A fix is proposed as a diff and validated with real pytest in a fresh sandbox
  before it can be called fixed.

## How it works

```
Alexa+ / any MCP client ──Streamable HTTP──▶  /mcp  (MCP server, 18 tools)
In-app Alexa+ simulator ──Streamable HTTP──▶   │   tools call the REST API in-process
                                               ▼
                                   FastAPI ── sandbox (Docker: no network, read-only,
                                      │        non-root, memory/CPU/pid limits)
                                      │        └─ sys.settrace worker → evidence trace
                                      ├─ narrators (syntax tree + recorded values)
                                      ├─ explanations / patches (offline rules or LLM, fact-checked)
                                      └─ pytest validation in a fresh sandbox
```

- **MCP server** ([`backend/app/mcp_server.py`](backend/app/mcp_server.py)): 18 tools.
  - **Six voice-ready tools:** `explain_code`, `get_debugging_summary`, `get_variable_state`,
    `get_execution_state`, `propose_fix` and `validate_fix`. Each returns a short `speech` string with the
    structured data behind it.
  - **Where it's served:** at `/mcp` on the main server ([`backend/app/main.py`](backend/app/main.py)), or
    standalone with `python -m app.mcp_server --http`.
  - **Security:** the in-app endpoint uses an access code; the standalone server requires a bearer token.
    DNS-rebinding and origin checks stay on in both cases.
- **Alexa+ simulator** ([`frontend/src/components/AlexaView.tsx`](frontend/src/components/AlexaView.tsx)):
  - **Device:** an Echo Show-style screen with Alexa's light bar, voice input (Web Speech API) and spoken
    answers.
  - **Client:** a small MCP client written from scratch
    ([`frontend/src/lib/mcpClient.ts`](frontend/src/lib/mcpClient.ts)). It handles `initialize`, sessions,
    `tools/list`, `tools/call` and SSE responses, and shows every request and response in a live traffic
    panel.
  - **Intent mapping:** each utterance becomes one tool call through a tested, rule-based mapper
    ([`frontend/src/lib/alexaIntents.ts`](frontend/src/lib/alexaIntents.ts)), so the demo works offline.
- **Grounding:** facts in every explanation come from the trace. When an AI model is used, its claims
  are checked against recorded line numbers, variable names and values before they are shown.
- **Built with REA:** the turtle drawing stage was designed after using REA, the reverse-engineering toolkit
  bundled with the project, to analyse Scratch's open-source pen and motion engine. We then implemented it
  ourselves; see [`docs/REA_SCRATCH_STUDY.md`](docs/REA_SCRATCH_STUDY.md).

**Testing:**
- 149 backend tests, including MCP over Streamable HTTP end to end.
- 20 frontend unit tests.
- A headless-browser suite (`npm run e2e`) that drives Kids mode, Game mode, the turtle stage and the
  Alexa+ simulator.
- GitHub Actions runs all three on every push.

## Built during the submission window

The repository's whole history is from 22–23 October 2026 (`git log --date=short`); **[YOU]** confirm this falls
inside the window. Highlights from the window:

- **Sandboxed tracer:** step-by-step replay with Kids, Game and Classic views.
- **MCP server:** 18 tools, with voice-ready speech output.
- **Alexa+ simulator and browser MCP client:** with the `/mcp` endpoint served from the main app.
- **Turtle drawing stage:** designed from the REA study of Scratch.
- **Kids mode:** Robo, read-aloud, blocks, challenges, auto-play and the progress track.
- **Evidence-checked fixes:** fix proposals with pytest validation.

## Product feedback (tools, APIs, SDKs used)

| Tool | What we used it for | What worked well | What needs work | Again? |
|---|---|---|---|---|
| **MCP Python SDK** (`mcp` 2.3.0), Streamable HTTP | The CodeLens MCP server, 18 tools | Typed tools with structured output; protocol negotiation to 2025-11-25 and later worked first time; DNS-rebinding and origin protection are on by default | Mounting inside an existing FastAPI app: the session manager's `run()` works only once per instance, which broke our test suite until we rebuilt the endpoint for each app start (friction log M3). The 1.x → 2.x rename of `FastMCP` to `MCPServer` cost time (M1) | Yes |
| **Model Context Protocol** (spec) | Browser MCP client written from scratch | Small surface: four messages are enough for a useful client. Session ids and SSE responses are simple to handle | A minimal "client in 50 lines" example for the Streamable HTTP wire format would help people building simulators | Yes |
| **Alexa+ (Developer Preview)** | Target platform for the MCP server | **[YOU]** Onboarding, console, how the MCP endpoint was registered | **[YOU]** | **[YOU]** |
| **REA** (`rea-agents` 6.7.0) | Studying Scratch's engine; reverse-engineering tab | Evidence documents with stable ids; accurate `destructiveHint` annotations | Analysing a 25 MB package over MCP returned only "Error executing tool", with no reason or size hint (friction log R9) | Yes |
| **Web Speech API** | Voice input and spoken answers | Built into Chrome and Edge, no keys | Recognition isn't in TypeScript's DOM types and differs by browser | Yes |
| **Docker Desktop** | Sandbox for user code | Strong isolation flags | Slow cold start on Windows (friction log O5) | Yes |

## Feature requests (optional)

| Request | Why | Urgency |
|---|---|---|
| Documented session-manager pattern for mounting MCP Streamable HTTP inside an existing ASGI app (restartable lifespan) | Most real servers already have an app and want `/mcp` beside it | Important |
| Alexa+ preview: a way to replay a conversation against a local MCP server in a browser simulator | Faster iteration than a device round-trip | Important |
| REA: report size limits and the failing phase in MCP tool errors | Lets agents retry with a narrower input | Nice-to-have |

## Friction log

See [`FRICTION_LOG.md`](FRICTION_LOG.md). Every entry records the task, the steps, what we expected
against what happened, a severity, the workaround and a suggestion.

## Demo video plan (under 3 minutes)

1. **0:00–0:20.** The problem: beginners can't see what their code does, and error messages are scary.
2. **0:20–1:20, Alexa+ simulator.** Load the "average" bug. Say "Alexa, run my code", "Why did it crash?", "What is
   total?", "Fix it", "Test the fix", "Apply the fix". Point at the MCP traffic panel (`initialize`, `tools/call`)
   and the protocol version.
3. **1:20–2:10, Kids mode.** Robo plays the "Draw a star" program. The turtle draws step by step, Robo explains each
   line, and the speaker is switched on.
4. **2:10–2:40, Game mode.** Side-by-side code and cards board on a bigger program.
5. **2:40–3:00.** How to connect real Alexa+ to `https://<host>/mcp`, then the repo and license.

## Links [YOU]

- Repository: https://github.com/HadiaIshtiaqq/Codelens (public, MIT)
- Demo video: …
- Hosted demo (optional): …
