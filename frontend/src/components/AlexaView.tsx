import { useEffect, useMemo, useRef, useState } from 'react';
import type { Debugger } from '../hooks/useDebugger';
import { parseIntent, SUGGESTIONS, type Intent } from '../lib/alexaIntents';
import { McpClient, MCP_PROTOCOL_VERSION, type McpLogEntry } from '../lib/mcpClient';
import { speak, speechSupported, stopSpeaking } from '../lib/speech';

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
  const [lastRun, setLastRun] = useState<{ execution_id: string; failed: boolean } | null>(null);
  const [lastPatch, setLastPatch] = useState<{ patch_id: string; patched_source: string } | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const variables = useMemo(() => variablesIn(dbg.source), [dbg.source]);

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

  const say = (text: string, viaVoice: boolean, extra: Partial<Turn> = {}) => {
    setTurns((prev) => [...prev, { id: ++turnCounter, who: 'alexa', text, ...extra }]);
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
        return say(res.speech, viaVoice, {
          tool: 'get_execution_state',
          card: res.event ? { kind: 'state', line: res.event.line, where: res.event.function } : undefined,
        });
      }
      case 'fix': {
        const run = await ensureRun();
        if (!run.failed) return say('Your program ran without any errors, so there is nothing to fix. Nice work!', viaVoice);
        const res = await client.callTool<{ speech: string; patch_id: string; patched_source: string; diff: string }>('propose_fix', {
          execution_id: run.execution_id,
        });
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
        return say("Sorry, I didn't catch that. Try: run my code, why did it crash, or fix it.", viaVoice);
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

  const listen = () => {
    if (!Recognition) return;
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
    rec.onerror = () => setLight('idle');
    rec.onend = () => {
      setHeard('');
      if (finalText) void ask(finalText, true);
      else setLight('idle');
    };
    recognition.current = rec;
    setLight('listening');
    rec.start();
  };

  const lightLabel = { idle: 'Ready', listening: 'Listening…', thinking: 'Asking CodeLens…', speaking: 'Speaking', error: 'Something went wrong' }[light];

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 overflow-auto p-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:overflow-hidden">
      {/* The device */}
      <section className="flex min-h-0 flex-col gap-3" aria-label="Alexa+ simulator">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-extrabold">
            <span className="gradient-text">Alexa+ simulator</span>
          </h2>
          <span className="text-xs text-slate-400">Talk to CodeLens the way Alexa+ does: through its MCP server.</span>
          <span
            className={`chip ml-auto ${connected === 'ok' ? 'border-cyan-400/40 bg-cyan-950/60 text-cyan-100' : connected === 'failed' ? 'border-red-500/50 bg-red-950/60 text-red-100' : 'border-white/10 text-slate-300'}`}
            role="status"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${connected === 'ok' ? 'cl-pulse-dot bg-cyan-400 text-cyan-400/60' : connected === 'failed' ? 'bg-red-400' : 'bg-slate-400'}`} />
            {connected === 'ok' ? `MCP connected · ${client.tools.length} tools` : connected === 'failed' ? 'MCP unavailable' : 'connecting…'}
          </span>
        </div>

        <div className="relative flex min-h-[380px] flex-1 flex-col overflow-hidden rounded-[2rem] border-[10px] border-slate-950 bg-gradient-to-br from-slate-900 via-[#0b1630] to-[#05202b] shadow-2xl shadow-cyan-950/40 ring-1 ring-white/10">
          <div ref={conversation} className="min-h-0 flex-1 space-y-3 overflow-auto p-5" aria-live="polite">
            {turns.length === 0 && (
              <div className="cl-view-in flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className={`alexa-orb ${light}`} aria-hidden />
                <p className="text-2xl font-semibold text-white">“Alexa, run my code.”</p>
                <p className="max-w-md text-sm text-slate-400">
                  Tap the microphone and speak, or type below. Alexa answers from the CodeLens trace: what ran, why it crashed, what a variable held, and a fix
                  that is tested before you trust it.
                </p>
              </div>
            )}
            {turns.map((t) =>
              t.who === 'you' ? (
                <p key={t.id} className="cl-view-in ml-auto w-fit max-w-[80%] rounded-2xl rounded-br-sm bg-slate-700/80 px-4 py-2 text-base text-slate-100">
                  {t.text}
                </p>
              ) : (
                <div key={t.id} className="cl-float-up max-w-[92%] rounded-2xl rounded-bl-sm border border-cyan-400/30 bg-cyan-950/40 px-4 py-3">
                  <p className="text-lg leading-snug text-white">{t.text}</p>
                  {t.card?.kind === 'diff' && (
                    <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-950/80 p-2 font-mono text-xs leading-relaxed">
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
                          <span className="rounded bg-slate-900 px-1.5 text-amber-100">{v}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {t.card?.kind === 'state' && (
                    <button className="btn mt-2" onClick={onShowDebugger}>
                      👀 Show line {t.card.line} in the debugger
                    </button>
                  )}
                  {t.card?.kind === 'tools' && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.card.names.map((n) => (
                        <span key={n} className="rounded-full bg-slate-900/80 px-2 py-0.5 font-mono text-[11px] text-cyan-100">
                          {n}
                        </span>
                      ))}
                    </div>
                  )}
                  {t.tool && <p className="mt-1.5 font-mono text-[11px] text-cyan-300/70">via MCP tool {t.tool}</p>}
                </div>
              ),
            )}
            {heard && <p className="ml-auto w-fit max-w-[80%] rounded-2xl bg-slate-800/60 px-4 py-2 italic text-slate-300">{heard}…</p>}
          </div>
          {/* Alexa's light bar along the bottom of the screen */}
          <div className="px-5 pb-3">
            <div className={`alexa-bar ${light}`} />
            <p className="mt-1 text-center text-[11px] font-semibold uppercase tracking-widest text-cyan-200/70">{lightLabel}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            className={`grid h-14 w-14 shrink-0 place-items-center rounded-full text-2xl shadow-lg transition hover:scale-105 active:scale-95 disabled:opacity-40 ${light === 'listening' ? 'bg-cyan-400 text-slate-900 shadow-cyan-400/50' : 'bg-gradient-to-br from-cyan-500 to-indigo-600 text-white shadow-cyan-900/50'}`}
            onClick={listen}
            disabled={!Recognition || connected !== 'ok'}
            aria-pressed={light === 'listening'}
            aria-label={light === 'listening' ? 'Stop listening' : 'Speak to Alexa'}
            title={Recognition ? 'Tap and speak' : 'Voice input needs Chrome or Edge; type instead'}
          >
            🎙
          </button>
          <form
            className="flex min-w-[220px] flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(typed, false);
              setTyped('');
            }}
          >
            <input
              className="input flex-1 py-2.5 text-base"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Or type what you'd say: “why did it crash?”"
              aria-label="Say something to Alexa"
              disabled={connected !== 'ok'}
            />
            <button className="btn btn-primary" disabled={connected !== 'ok' || !typed.trim()}>
              Ask
            </button>
          </form>
          {speechSupported && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400" title="Spoken questions always get a spoken answer">
              <input type="checkbox" checked={alwaysSpeak} onChange={(e) => setAlwaysSpeak(e.target.checked)} />
              🔊 read typed answers aloud
            </label>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="rounded-full border border-cyan-400/30 bg-cyan-950/30 px-3 py-1 text-sm text-cyan-100 transition hover:-translate-y-px hover:bg-cyan-900/50 disabled:opacity-40"
              onClick={() => void ask(s, false)}
              disabled={connected !== 'ok' || light === 'thinking'}
            >
              “{s}”
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Alexa works on the code in the Python Debugger tab ({dbg.source.split('\n').length} lines).{' '}
          <button className="underline hover:text-slate-300" onClick={onShowDebugger}>
            Edit it there
          </button>
          .
        </p>
      </section>

      {/* The developer's view of the same conversation */}
      <section className="panel min-h-[320px] overflow-hidden" aria-label="MCP traffic">
        <div className="panel-title">
          <span>🔌 MCP traffic · Streamable HTTP</span>
          <button className="normal-case text-slate-500 hover:text-slate-200" onClick={() => setLog([])}>
            clear
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 border-b border-white/10 px-3 py-2 font-mono text-[11px]">
          <dt className="text-slate-500">endpoint</dt>
          <dd className="truncate text-slate-200">POST {window.location.origin}/mcp</dd>
          <dt className="text-slate-500">protocol</dt>
          <dd className="text-slate-200">{client.protocolVersion || MCP_PROTOCOL_VERSION}</dd>
          <dt className="text-slate-500">session</dt>
          <dd className="truncate text-slate-200">{client.sessionId ?? '—'}</dd>
        </dl>
        <ol className="min-h-0 flex-1 space-y-1 overflow-auto p-2 font-mono text-xs" data-testid="mcp-log">
          {log.length === 0 && <li className="p-2 text-slate-500">Requests appear here as Alexa talks to the server.</li>}
          {log.map((e) => (
            <li key={e.id} className="cl-slide-in">
              <details className="rounded-md border border-white/5 bg-slate-950/60">
                <summary className="flex cursor-pointer items-center gap-2 px-2 py-1">
                  <span className={e.direction === 'request' ? 'text-sky-300' : e.direction === 'error' ? 'text-rose-300' : 'text-emerald-300'}>
                    {e.direction === 'request' ? '→' : e.direction === 'error' ? '✖' : '←'}
                  </span>
                  <span className="text-slate-100">{e.method}</span>
                  <span className="truncate text-slate-500">{e.summary}</span>
                </summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-white/5 p-2 text-[11px] text-slate-400">
                  {JSON.stringify(e.body, null, 2)?.slice(0, 6000) ?? '(no body)'}
                </pre>
              </details>
            </li>
          ))}
        </ol>
        <p className="border-t border-white/10 px-3 py-2 text-[11px] text-slate-500">
          Real Alexa+ connects to the same server: register <span className="font-mono text-slate-300">https://&lt;your-host&gt;/mcp</span> (see
          README, “Using it from agents”).
        </p>
      </section>
    </div>
  );
}
