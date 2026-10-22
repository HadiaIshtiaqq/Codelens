import { lazy, Suspense, useEffect, useState } from 'react';
import { ACCESS_DENIED_EVENT, api, getAccessCode, setAccessCode } from './api/client';
import type { Health } from './api/types';
import type { ConvertRequest } from './components/ConverterView';
import { DebuggerView } from './components/DebuggerView';
import { useDebugger } from './hooks/useDebugger';

// Secondary tabs are split into their own chunks, so the debugger appears sooner.
const ConverterView = lazy(() => import('./components/ConverterView').then((m) => ({ default: m.ConverterView })));
const ReaView = lazy(() => import('./components/rea/ReaView').then((m) => ({ default: m.ReaView })));

type View = 'debugger' | 'convert' | 'rea';

const loading = <p className="p-6 text-sm text-slate-500">Loading…</p>;

/** Shown on hosted deployments that require an access code (CODELENS_ACCESS_CODE). */
function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [code, setCode] = useState(getAccessCode());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <form
        className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setAccessCode(code.trim());
          try {
            await api.checkAccess();
            onUnlocked();
          } catch {
            setError('That code was not accepted.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id="gate-title" className="text-lg font-bold">
          🔒 Access code
        </h2>
        <p className="text-sm text-slate-400">This CodeLens server is private. Enter the access code you were given.</p>
        <input
          autoFocus
          type="password"
          className="input w-full"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-label="Access code"
          autoComplete="current-password"
        />
        {error && (
          <p role="alert" className="text-sm text-orange-300">
            {error}
          </p>
        )}
        <button className="btn btn-primary w-full justify-center" disabled={busy || !code.trim()}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const dbg = useDebugger();
  const [view, setView] = useState<View>('debugger');
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [convertRequest, setConvertRequest] = useState<ConvertRequest | null>(null);
  const [locked, setLocked] = useState(false);
  // Mount secondary views on first visit, then keep them mounted to preserve their state.
  const [visited, setVisited] = useState<Set<View>>(() => new Set(['debugger']));
  useEffect(() => {
    setVisited((prev) => (prev.has(view) ? prev : new Set([...prev, view])));
  }, [view]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setHealth(h);
          setHealthError(false);
          if (h.features?.access_code_required && !getAccessCode()) setLocked(true);
        }
      } catch {
        if (alive) setHealthError(true);
      }
    };
    poll();
    const id = setInterval(poll, 15000);
    const onDenied = () => setLocked(true);
    window.addEventListener(ACCESS_DENIED_EVENT, onDenied);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener(ACCESS_DENIED_EVENT, onDenied);
    };
  }, []);

  const showRea = !!health?.features?.rea_ui;
  const aiReady = !!health && health.llm_provider !== 'offline';

  const tabs: [View, string][] = [
    ['debugger', '🎮 Python Debugger'],
    ['convert', '🔄 Code Converter'],
    ...(showRea ? ([['rea', '🛡 Reverse Engineering']] as [View, string][]) : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {locked && <AccessGate onUnlocked={() => setLocked(false)} />}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-800 bg-slate-950 px-4 py-2">
        <h1 className="flex items-center gap-2 text-base font-bold tracking-tight">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
            <circle cx="14" cy="14" r="9" fill="none" stroke="#3b82f6" strokeWidth="4" />
            <path d="M21 21l7 7" stroke="#f97316" strokeWidth="4" strokeLinecap="round" />
          </svg>
          CodeLens AI
        </h1>
        <nav role="tablist" aria-label="Workspace" className="flex flex-wrap gap-1">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className="tab" onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          {healthError ? (
            <span className="rounded bg-red-900 px-2 py-0.5 text-red-100" role="status">
              ✖ backend offline (start it with scripts\start.ps1)
            </span>
          ) : health ? (
            <>
              <span
                className={`rounded px-2 py-0.5 ${health.sandbox === 'docker' ? 'bg-emerald-900 text-emerald-100' : 'bg-yellow-900 text-yellow-100'}`}
                title={health.sandbox === 'docker' ? 'User code runs in locked-down containers' : 'Dev mode: no container isolation'}
              >
                sandbox: {health.sandbox}
              </span>
              <span
                className={`rounded px-2 py-0.5 ${aiReady ? 'bg-emerald-900 text-emerald-100' : 'bg-slate-800 text-slate-300'}`}
                title={aiReady ? health.llm_model || 'model is chosen on first use' : 'Add NEBIUS_API_KEY to backend\\.env and restart to turn the AI on'}
              >
                {aiReady ? '🟢' : '⚪'} AI: {aiReady ? `${health.llm_provider}${health.llm_model ? ` · ${health.llm_model.split('/').pop()}` : ''}` : 'offline'}
              </span>
            </>
          ) : (
            <span className="text-slate-500">connecting…</span>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1" hidden={view !== 'debugger'}>
        <DebuggerView
          dbg={dbg}
          onConvert={(code, language) => {
            setConvertRequest({ code, from: language, nonce: Date.now() });
            setView('convert');
          }}
        />
      </div>
      {visited.has('convert') && (
        <div className="min-h-0 flex-1" hidden={view !== 'convert'}>
          <Suspense fallback={loading}>
            <ConverterView
              aiReady={aiReady}
              request={convertRequest}
              onRunPython={(code) => {
                dbg.loadProject(code);
                setView('debugger');
                void dbg.execute(code, { files: {}, stdin: '' });
              }}
            />
          </Suspense>
        </div>
      )}
      {showRea && visited.has('rea') && (
        <div className="min-h-0 flex-1" hidden={view !== 'rea'}>
          <Suspense fallback={loading}>
            <ReaView />
          </Suspense>
        </div>
      )}
    </div>
  );
}
