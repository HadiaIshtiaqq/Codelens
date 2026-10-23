import { lazy, Suspense, useEffect, useState } from 'react';
import { ACCESS_DENIED_EVENT, api, getAccessCode, setAccessCode } from './api/client';
import type { Health } from './api/types';
import { DebuggerView } from './components/DebuggerView';
import { useDebugger } from './hooks/useDebugger';
import { setTheme, useTheme } from './lib/theme';

// Secondary tabs are split into their own chunks, so the debugger appears sooner.
const ReaView = lazy(() => import('./components/rea/ReaView').then((m) => ({ default: m.ReaView })));
const AlexaView = lazy(() => import('./components/AlexaView').then((m) => ({ default: m.AlexaView })));

type View = 'debugger' | 'alexa' | 'rea';

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

  const theme = useTheme();
  const showRea = !!health?.features?.rea_ui;
  const aiReady = !!health && health.llm_provider !== 'offline';

  const tabs: [View, string][] = [
    ['debugger', '🎮 Python Debugger'],
    ['alexa', '🔵 Alexa+'],
    ...(showRea ? ([['rea', '🛡 Reverse Engineering']] as [View, string][]) : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {locked && <AccessGate onUnlocked={() => setLocked(false)} />}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/10 bg-slate-950/70 px-4 py-2 backdrop-blur-xl">
        <h1 className="group flex items-center gap-2 text-lg font-extrabold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-cyan-400 to-sky-600 shadow-[0_0_16px_rgba(34,211,238,0.4)] transition group-hover:rotate-6">
            <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
              <circle cx="14" cy="14" r="9" fill="none" stroke="white" strokeWidth="4" />
              <path d="M21 21l7 7" stroke="white" strokeWidth="4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="text-white">
            CodeLens <span className="text-cyan-300">AI</span>
          </span>
        </h1>
        <nav role="tablist" aria-label="Workspace" className="flex flex-wrap gap-1 rounded-full border border-white/10 bg-slate-900/60 p-1">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className="tab" onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <button
            className="chip border-white/10 bg-slate-900/70 text-slate-200 transition hover:border-cyan-400/50"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            title={theme === 'light' ? 'Dark mode' : 'Light mode'}
          >
            {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
          </button>
          {healthError ? (
            <span className="chip border-red-500/50 bg-red-950/70 text-red-100" role="status">
              ✖ backend offline (start it with scripts\start.ps1)
            </span>
          ) : health ? (
            <>
              <span
                className={`chip ${health.sandbox === 'docker' ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-100' : 'border-yellow-500/40 bg-yellow-950/60 text-yellow-100'}`}
                title={health.sandbox === 'docker' ? 'User code runs in locked-down containers' : 'Dev mode: no container isolation'}
              >
                <span className={`cl-pulse-dot h-1.5 w-1.5 rounded-full ${health.sandbox === 'docker' ? 'bg-emerald-400 text-emerald-400/60' : 'bg-yellow-400 text-yellow-400/60'}`} />
                sandbox: {health.sandbox}
              </span>
              <span
                className={`chip ${aiReady ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-100' : 'border-white/10 bg-slate-900/70 text-slate-300'}`}
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
      <div className="cl-view-in min-h-0 flex-1" hidden={view !== 'debugger'}>
        <DebuggerView dbg={dbg} />
      </div>
      {visited.has('alexa') && (
        <div className="cl-view-in min-h-0 flex-1" hidden={view !== 'alexa'}>
          <Suspense fallback={loading}>
            <AlexaView dbg={dbg} onShowDebugger={() => setView('debugger')} />
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
