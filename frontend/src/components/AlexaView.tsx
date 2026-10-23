import { useEffect, useMemo, useRef, useState } from 'react';
import type { Debugger } from '../hooks/useDebugger';
import { parseIntent, SUGGESTIONS, type Intent } from '../lib/alexaIntents';
import { McpClient, MCP_PROTOCOL_VERSION, type McpLogEntry } from '../lib/mcpClient';
import { speak, speechSupported, stopSpeaking } from '../lib/speech';
import { useCompanion } from './Companion';
import { Lexi } from './Lexi';

// A simulated Alexa+ device. Everything it knows comes from the CodeLens MCP server, reached
// over Streamable HTTP exactly as Alexa+ reaches an MCP integration; the right-hand panel shows
// that traffic live.

type Light = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface Turn {
  id: number;
  who: 'you' | 'alexa';
  text: string;
  tool?: string;
  card?: Card;
  /** The code line this answer is about, so Lexi can point at it. */
  line?: number;
}

type Card =
  | { kind: 'diff'; diff: string }
  | { kind: 'history'; name: string; values: string[] }
  | { kind: 'state'; line: number; where: string }
  | { kind: 'tools'; names: string[] };

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

const Recognition: (new () => SpeechRecognitionLike) | undefined =
  typeof window !== 'undefined' ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : undefined;

const MCP_URL = '/mcp';
let turnCounter = 0;

/** Variable names in the code, so "total score" can be heard as total_score. */
function variablesIn(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^\s*([A-Za-z_]\w*)\s*(?:[+\-*/]?=)(?!=)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/\bfor\s+([A-Za-z_]\w*)(?:\s*,\s*([A-Za-z_]\w*))?\s+in\b/g)) [m[1], m[2]].forEach((n) => n && names.add(n));
  for (const m of source.matchAll(/\bdef\s+\w+\s*\(([^)]*)\)/g)) m[1].split(',').forEach((p) => p.trim() && names.add(p.trim().split(/[=:\s]/)[0]));
  return [...names];
}

export function AlexaView({ dbg, onShowDebugger }: { dbg: Debugger; onShowDebugger: () => void }) {
  const [log, setLog] = useState<McpLogEntry[]>([]);
  const client = useMemo(() => new McpClient(MCP_URL, (entry) => setLog((prev) => [...prev.slice(-199), entry])), []);
  const [connected, setConnected] = useState<'connecting' | 'ok' | 'failed'>('connecting');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [light, setLight] = useState<Light>('idle');
  const [heard, setHeard] = useState('');
  const [typed, setTyped] = useState('');
  const [alwaysSpeak, setAlwaysSpeak] = useState(false);
  // The MCP traffic panel is for developers (and demo videos); it stays hidden until asked for.
  const [showTraffic, setShowTraffic] = useState(false);
  const [lastRun, setLastRun] = useState<{ execution_id: string; failed: boolean } | null>(null);
  const [lastPatch, setLastPatch] = useState<{ patch_id: string; patched_source: string } | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const variables = useMemo(() => variablesIn(dbg.source), [dbg.source]);
  const lexi = useCompanion();

  /** Lexi flies to the line; the debugger runs the same code so its board shows the same moment. */
  const showLine = (line: number, text: string) => {
    const short = text.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    if (!dbg.run || dbg.stale) void dbg.execute();
    lexi.pointAt(line, short);
  };

  useEffect(() => {
    client
      .connect()
      .then(() => setConnected('ok'))
      .catch(() => setConnected('failed'));
    return () => stopSpeaking();
  }, [client]);

  // A new edit means the old run and fix no longer describe the code.
  useEffect(() => {
    setLastRun(null);
    setLastPatch(null);
  }, [dbg.source]);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  // Lexi's face follows the device: listening, thinking, speaking, or worried when something failed.
  const { setTalking, setMood } = lexi;
  useEffect(() => {
    setTalking(light === 'speaking');
    setMood(light === 'thinking' ? 'thinking' : light === 'listening' ? 'listening' : light === 'error' ? 'worried' : 'happy');
  }, [light, setTalking, setMood]);
  useEffect(() => () => setTalking(false), [setTalking]);

  /** Add Alexa's answer. Answers that mention "line N" let Lexi point at that line; `point` flies there now. */
  const say = (text: string, viaVoice: boolean, extra: Partial<Turn> = {}, point = false) => {
    const line = extra.line ?? Number(text.match(/\bline (\d+)\b/)?.[1] ?? 0);
    setTurns((prev) => [...prev, { id: ++turnCounter, who: 'alexa', text, ...extra, line: line || undefined }]);
    if (point && line) showLine(line, text);
    if ((viaVoice || alwaysSpeak) && speechSupported) {
      setLight('speaking');
      speak(text, () => setLight('idle'));
    } else {
      setLight('idle');
    }
  };

  const ensureRun = async () => {
    if (lastRun) return lastRun;
    const res = await client.callTool<{ execution_id: string; run: { error: unknown; status: string } }>('explain_code', { source_code: dbg.source });
    const run = { execution_id: res.execution_id, failed: !!res.run.error || res.run.status !== 'completed' };
    setLastRun(run);
    return run;
  };

  const act = async (intent: Intent, viaVoice: boolean) => {
    switch (intent.kind) {
      case 'help':
        return say(
          `I'm connected to CodeLens through its MCP server, with ${client.tools.length} tools. Ask me to run your code, why it crashed, what a variable is, where it stopped, to fix it, or to test the fix.`,
          viaVoice,
          { card: { kind: 'tools', names: client.tools.map((t) => t.name) } },
        );
      case 'run': {
        const res = await client.callTool<{ speech: string; execution_id: string; run: { error: unknown; status: string } }>('explain_code', {
          source_code: dbg.source,
        });
        setLastRun({ execution_id: res.execution_id, failed: !!res.run.error || res.run.status !== 'completed' });
        setLastPatch(null);
        return say(res.speech, viaVoice, { tool: 'explain_code' });
      }
      case 'summary': {
        const run = await ensureRun();
        const res = await client.callTool<{ speech: string }>('get_debugging_summary', { execution_id: run.execution_id });
        return say(res.speech, viaVoice, { tool: 'get_debugging_summary' });
      }
      case 'variable': {
        const run = await ensureRun();
        const res = await client.callTool<{ speech: string; found: boolean; history: { value: string }[] }>('get_variable_state', {
          execution_id: run.execution_id,
          name: intent.name,
        });
        return say(res.speech, viaVoice, {
          tool: 'get_variable_state',
          card: res.found ? { kind: 'history', name: intent.name, values: res.history.map((h) => h.value).slice(0, 12) } : undefined,
        });
      }
      case 'state': {
        const run = await ensureRun();
        const res = await client.callTool<{ speech: string; event: { line: number; function: string } }>('get_execution_state', {
          execution_id: run.execution_id,
          ...(intent.step !== undefined ? { step: intent.step } : {}),
        });
        // "Where did it stop?" is about a place in the code, so Lexi goes and shows it.
        return say(res.speech, viaVoice, { tool: 'get_execution_state', line: res.event?.line }, true);
      }
      case 'show': {
        const run = await ensureRun();
        if (run.failed) {
          const res = await client.callTool<{ speech: string }>('get_debugging_summary', { execution_id: run.execution_id });
          return say(res.speech, viaVoice, { tool: 'get_debugging_summary' }, true);
        }
        const res = await client.callTool<{ speech: string; event: { line: number } }>('get_execution_state', { execution_id: run.execution_id });
        return say(res.speech, viaVoice, { tool: 'get_execution_state', line: res.event?.line }, true);
      }
      case 'fix': {
        const run = await ensureRun();
        if (!run.failed) return say('Your program ran without any errors, so there is nothing to fix. Nice work!', viaVoice);
        const res = await client.callTool<{ speech: string; found: boolean; patch_id: string; patched_source: string; diff: string }>('propose_fix', {
          execution_id: run.execution_id,
        });
        if (!res.found) return say(res.speech, viaVoice, { tool: 'propose_fix' });
        setLastPatch({ patch_id: res.patch_id, patched_source: res.patched_source });
        return say(res.speech, viaVoice, { tool: 'propose_fix', card: { kind: 'diff', diff: res.diff } });
      }
      case 'validate': {
        if (!lastPatch) return say('There is no fix to test yet. Say "fix it" first.', viaVoice);
        const res = await client.callTool<{ speech: string; status: string }>('validate_fix', { patch_id: lastPatch.patch_id });
        const next = res.status === 'failed' ? '' : ' Say "apply the fix" to put it in your editor.';
        return say(res.speech + next, viaVoice, { tool: 'validate_fix' });
      }
      case 'apply': {
        if (!lastPatch) return say('There is no fix to apply yet. Say "fix it" first.', viaVoice);
        dbg.setSource(lastPatch.patched_source);
        return say("Done. I put the fixed code in your editor. Say run my code to try it.", viaVoice);
      }
      default:
        return say("I'm your coding helper, so I can only answer questions about the code in your editor. Try one of the buttons below.", viaVoice);
    }
  };

  const ask = async (utterance: string, viaVoice: boolean) => {
    const text = utterance.trim();
    if (!text) return;
    stopSpeaking();
    setTurns((prev) => [...prev, { id: ++turnCounter, who: 'you', text }]);
    setLight('thinking');
    try {
      await act(parseIntent(text, variables), viaVoice);
    } catch (err) {
      setLight('error');
      say(`Sorry, CodeLens didn't answer: ${(err as Error).message}`, viaVoice);
    }
  };

  const inputRef = useRef<HTMLInputElement>(null);

  const listen = () => {
    if (!Recognition) {
      say('Voice input needs Chrome or Edge. Type your question in the box below instead.', false);
      inputRef.current?.focus();
      return;
    }
    if (light === 'listening') {
      recognition.current?.stop();
      return;
    }
    stopSpeaking();
    const rec = new Recognition();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      const parts = Array.from(e.results);
      setHeard(parts.map((r) => r[0].transcript).join(' '));
      const done = parts.filter((r) => r.isFinal).map((r) => r[0].transcript);
      if (done.length) finalText = done.join(' ');
    };
    let failed = false;
    rec.onerror = (e) => {
      failed = true;
      // Say why nothing happened instead of going quiet.
      const why: Record<string, string> = {
        'not-allowed': 'the browser blocked the microphone. Allow it with the icon in the address bar, or type below.',
        'service-not-allowed': 'the browser blocked the microphone. Allow it with the icon in the address bar, or type below.',
        'no-speech': "I didn't hear anything. Tap the microphone and speak, or type below.",
        'audio-capture': 'no microphone was found. Type your question below instead.',
        network: "the browser's speech service couldn't be reached. Type your question below instead.",
      };
      if (e.error !== 'aborted') say(`Sorry, ${why[e.error] ?? `voice input stopped (${e.error}). Type your question below instead.`}`, false);
      else setLight('idle');
    };
    rec.onend = () => {
      setHeard('');
      if (finalText) void ask(finalText, true);
      else if (!failed) say("I didn't hear anything. Tap the microphone and speak, or type below.", false);
    };
    recognition.current = rec;
    setLight('listening');
    try {
      rec.start();
    } catch {
      say('Voice input could not start. Type your question below instead.', false);
    }
  };

  const lightLabel = { idle: 'Ready', listening: 'Listening…', thinking: 'Asking CodeLens…', speaking: 'Speaking', error: 'Something went wrong' }[light];
  const ready = connected === 'ok';
  const busy = light === 'thinking';

  // What makes sense to ask next, given where the conversation is.
  const example = variables.find((v) => v.length > 1) ?? variables[0];
  const followUps = !lastRun
    ? SUGGESTIONS.slice(0, 1).concat('What can you do?')
    : lastPatch
      ? ['Test the fix', 'Apply the fix', 'Why did it crash?']
      : lastRun.failed
        ? ['Why did it crash?', 'Fix it', 'Where did it stop?', ...(example ? [`What is ${example}?`] : [])]
        : [...(example ? [`What is ${example}?`] : []), 'Where did it stop?', 'Run my code'];

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-1 gap-4 overflow-auto p-4 ${showTraffic ? 'lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]' : 'mx-auto w-full max-w-4xl'}`}
    >
      {/* The device */}
      <section className="flex min-h-[460px] min-w-0 flex-col gap-3 lg:min-h-0" aria-label="Alexa+ simulator">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="flex items-center gap-2 text-lg font-bold text-white">
            {turns.length > 0 ? (
              <span data-lexi-home className="block h-12 w-12 shrink-0" aria-hidden />
            ) : (
              <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.9)]" aria-hidden />
            )}
            Alexa+ simulator
          </h2>
          <span className="text-sm text-slate-400">Ask about your code. Alexa answers through the CodeLens MCP server.</span>
          <span
            className={`chip ml-auto ${ready ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-100' : connected === 'failed' ? 'border-rose-500/50 bg-rose-500/10 text-rose-100' : 'border-white/10 text-slate-300'}`}
            role="status"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'cl-pulse-dot bg-cyan-400 text-cyan-400/60' : connected === 'failed' ? 'bg-rose-400' : 'bg-slate-400'}`} />
            {ready ? `MCP connected · ${client.tools.length} tools` : connected === 'failed' ? 'MCP unavailable' : 'connecting…'}
          </span>
          <button
            className="rounded-full border border-white/10 px-2.5 py-0.5 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-200"
            onClick={() => setShowTraffic(!showTraffic)}
            aria-pressed={showTraffic}
          >
            {showTraffic ? 'Hide MCP traffic' : 'Show MCP traffic'}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.75rem] border-[8px] border-slate-950 bg-slate-900 shadow-2xl shadow-black/50 ring-1 ring-white/10">
          <div ref={conversation} className="min-h-0 flex-1 space-y-3 overflow-auto p-4 sm:p-5" aria-live="polite">
            {turns.length === 0 && (
              <div className="cl-view-in flex min-h-full flex-col items-center justify-center gap-3 py-4 text-center">
                {/* Lexi is drawn over this button by the companion layer; tapping Lexi starts listening. */}
                <button
                  data-lexi-home
                  className="h-[120px] w-[120px] shrink-0 rounded-full disabled:opacity-50"
                  onClick={listen}
                  disabled={!ready}
                  aria-label="Tap Lexi to speak to Alexa"
                  title="Tap to speak"
                />
                <p className="text-xl font-semibold text-white">Hi, I'm Lexi! Tap me and say “Alexa, run my code.”</p>
                <p className="max-w-md text-sm leading-relaxed text-slate-400">
                  Or type below. Alexa answers from the recorded run of your code: what happened, why it crashed, what a variable held, and a fix that is
                  tested before you trust it.
                </p>
              </div>
            )}
            {turns.map((t) =>
              t.who === 'you' ? (
                <p key={t.id} className="cl-view-in ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-md bg-cyan-500/15 px-4 py-2 text-base text-cyan-50 ring-1 ring-cyan-400/25">
                  {t.text}
                </p>
              ) : (
                <div key={t.id} className="cl-float-up flex max-w-[92%] gap-3">
                  <span className="mt-0.5 shrink-0" aria-hidden>
                    <Lexi size={32} />
                  </span>
                  <div className="min-w-0 rounded-2xl rounded-tl-md bg-slate-800/70 px-4 py-3 ring-1 ring-white/10">
                    <p className="text-[17px] leading-snug text-slate-50">{t.text}</p>
                    {t.card?.kind === 'diff' && (
                      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-xs leading-relaxed">
                        {t.card.diff.split('\n').map((line, i) => (
                          <span
                            key={i}
                            className={`block ${line.startsWith('+') && !line.startsWith('+++') ? 'text-emerald-300' : line.startsWith('-') && !line.startsWith('---') ? 'text-rose-300' : 'text-slate-400'}`}
                          >
                            {line || ' '}
                          </span>
                        ))}
                      </pre>
                    )}
                    {t.card?.kind === 'history' && (
                      <div className="mt-2 flex flex-wrap items-center gap-1 font-mono text-sm">
                        <span className="text-cyan-200">{t.card.name}:</span>
                        {t.card.values.map((v, i) => (
                          <span key={i} className="flex items-center gap-1">
                            {i > 0 && <span className="text-slate-500">→</span>}
                            <span className="rounded bg-black/40 px-1.5 text-slate-100">{v}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {t.card?.kind === 'tools' && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {t.card.names.map((n) => (
                          <span key={n} className="rounded-full bg-black/40 px-2 py-0.5 font-mono text-[11px] text-cyan-100">
                            {n}
                          </span>
                        ))}
                      </div>
                    )}
                    {t.line && (
                      <button className="btn mt-2 border-cyan-400/40 text-cyan-100" onClick={() => showLine(t.line!, t.text)}>
                        👉 Show me line {t.line}
                      </button>
                    )}
                    {t.tool && <p className="mt-1.5 font-mono text-[11px] text-slate-500">via MCP tool {t.tool}</p>}
                  </div>
                </div>
              ),
            )}
            {heard && <p className="ml-auto w-fit max-w-[80%] rounded-2xl bg-cyan-500/10 px-4 py-2 italic text-cyan-100/80">{heard}…</p>}
          </div>

          {/* Docked at the bottom of the screen, so it is always in view. */}
          <div className="space-y-2 border-t border-white/10 bg-black/20 px-3 pb-3 pt-2">
            <div className="flex flex-wrap gap-1.5" aria-label="Suggestions">
              {followUps.map((s) => (
                <button
                  key={s}
                  className="rounded-full border border-cyan-400/30 bg-cyan-400/5 px-3 py-1 text-sm text-cyan-100 transition hover:-translate-y-px hover:bg-cyan-400/15 disabled:opacity-40"
                  onClick={() => void ask(s, false)}
                  disabled={!ready || busy}
                >
                  {s}
                </button>
              ))}
            </div>
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(typed, false);
                setTyped('');
              }}
            >
              <button
                type="button"
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl transition hover:scale-105 active:scale-95 disabled:opacity-40 ${light === 'listening' ? 'bg-cyan-300 text-slate-900 shadow-[0_0_20px_rgba(34,211,238,0.8)]' : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'}`}
                onClick={listen}
                disabled={!ready}
                aria-pressed={light === 'listening'}
                aria-label={light === 'listening' ? 'Stop listening' : 'Speak to Alexa'}
                title={Recognition ? 'Tap and speak' : 'Voice input needs Chrome or Edge; type instead'}
              >
                🎙
              </button>
              <input
                ref={inputRef}
                className="input min-w-0 flex-1 rounded-full px-4 py-2.5 text-base"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="Type a question, like “why did it crash?”"
                aria-label="Say something to Alexa"
                disabled={!ready}
              />
              <button className="btn btn-primary rounded-full px-4" disabled={!ready || !typed.trim() || busy}>
                Ask
              </button>
            </form>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <div className={`alexa-bar ${light} min-w-[120px] flex-1`} />
              <span className="text-[11px] font-semibold uppercase tracking-widest text-cyan-200/70">{lightLabel}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            Alexa works on the code in the Python Debugger tab ({dbg.source.split('\n').length} lines).{' '}
            <button className="underline hover:text-slate-300" onClick={onShowDebugger}>
              Edit it there
            </button>
          </span>
          {speechSupported && (
            <label className="flex items-center gap-1.5" title="Spoken questions always get a spoken answer">
              <input type="checkbox" checked={alwaysSpeak} onChange={(e) => setAlwaysSpeak(e.target.checked)} />
              🔊 read typed answers aloud
            </label>
          )}
        </div>
      </section>

      {/* The developer's view of the same conversation */}
      {showTraffic && (
      <section className="panel min-h-[320px] min-w-0 overflow-hidden" aria-label="MCP traffic">
        <div className="panel-title">
          <span>MCP traffic · Streamable HTTP</span>
          <button className="normal-case text-slate-500 hover:text-slate-200" onClick={() => setLog([])}>
            clear
          </button>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-white/10 px-3 py-2 font-mono text-[11px]">
          <dt className="text-slate-500">endpoint</dt>
          <dd className="truncate text-slate-200">POST {window.location.origin}/mcp</dd>
          <dt className="text-slate-500">protocol</dt>
          <dd className="truncate text-slate-200">{client.protocolVersion || MCP_PROTOCOL_VERSION}</dd>
          <dt className="text-slate-500">session</dt>
          <dd className="truncate text-slate-200">{client.sessionId ?? '—'}</dd>
        </dl>
        <ol className="min-h-0 flex-1 space-y-1 overflow-auto p-2 font-mono text-xs" data-testid="mcp-log">
          {log.length === 0 && <li className="p-2 text-slate-500">Requests appear here as Alexa talks to the server.</li>}
          {log.map((e) => (
            <li key={e.id} className="cl-slide-in min-w-0">
              <details className="rounded-md border border-white/5 bg-black/30">
                <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2 py-1">
                  <span className={`shrink-0 ${e.direction === 'request' ? 'text-cyan-300' : e.direction === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}>
                    {e.direction === 'request' ? '→' : e.direction === 'error' ? '✖' : '←'}
                  </span>
                  <span className="shrink-0 text-slate-100">{e.method}</span>
                  <span className="min-w-0 truncate text-slate-500">{e.summary}</span>
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-white/5 p-2 text-[11px] text-slate-400">
                  {JSON.stringify(e.body, null, 2)?.slice(0, 6000) ?? '(no body)'}
                </pre>
              </details>
            </li>
          ))}
        </ol>
        <p className="border-t border-white/10 px-3 py-2 text-[11px] text-slate-500">
          Real Alexa+ connects to the same server: register <span className="font-mono text-slate-300">https://&lt;your-host&gt;/mcp</span>.
        </p>
      </section>
      )}
    </div>
  );
}
