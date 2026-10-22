import { useEffect, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { ReaStatus, ReaWorkspace } from '../../api/types';
import { JsAnalysisPanel } from './JsAnalysisPanel';
import { ToolExplorer } from './ToolExplorer';

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Reverse-engineering workspace (Persona C, FR-02). */
export function ReaView() {
  const [status, setStatus] = useState<ReaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [workspace, setWorkspace] = useState<ReaWorkspace | null>(null);
  const [path, setPath] = useState('');

  const loadStatus = async (refresh = false) => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      setStatus(await api.reaStatus(refresh));
    } catch (e) {
      setStatusError(msg(e));
    } finally {
      setLoadingStatus(false);
    }
  };
  const loadWorkspace = async () => {
    try {
      setWorkspace(await api.reaWorkspace());
    } catch {
      setWorkspace(null);
    }
  };

  useEffect(() => {
    loadStatus();
    loadWorkspace();
  }, []);

  const okCount = status?.checks.filter((c) => c.ok).length ?? 0;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-2 overflow-auto p-2 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-2">
        <section className="panel" aria-labelledby="rea-status-title">
          <div className="panel-title">
            <h2 id="rea-status-title">REA engines</h2>
            <button className="btn px-2 py-0.5 text-xs normal-case" onClick={() => loadStatus(true)} disabled={loadingStatus}>
              {loadingStatus ? 'Checking…' : 'Re-check'}
            </button>
          </div>
          <div className="max-h-[40vh] overflow-auto p-3 text-xs">
            {statusError && <p className="text-orange-300">{statusError}</p>}
            {!status && !statusError && <p className="text-slate-500">Running rea doctor…</p>}
            {status && (
              <>
                <p className="mb-2 text-slate-400">
                  {okCount}/{status.checks.length} checks ready. JS/Electron analysis needs only Node; native decompilation needs Ghidra, Hopper or IDA.
                </p>
                <ul className="space-y-1">
                  {status.checks.map((c) => (
                    <li key={c.name} title={c.remediation ?? c.detail ?? ''}>
                      <span className={c.ok ? 'text-emerald-300' : 'text-slate-500'}>{c.ok ? '✔' : '○'}</span>{' '}
                      <span className={c.ok ? 'text-slate-200' : 'text-slate-400'}>{c.name}</span>
                      {!c.ok && c.remediation && <div className="ml-4 text-[11px] text-slate-500">{c.remediation}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>

        <section className="panel min-h-0 flex-1" aria-labelledby="rea-ws-title">
          <div className="panel-title">
            <h2 id="rea-ws-title">Workspace</h2>
            <button className="btn px-2 py-0.5 text-xs normal-case" onClick={loadWorkspace}>
              Refresh
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
            {workspace && (
              <>
                <p className="mb-2 break-all text-slate-500">
                  Targets must be inside <code className="text-slate-300">{workspace.root}</code>
                  {status?.allow_any_path ? ' (any path allowed)' : ''}.
                </p>
                {workspace.entries.length === 0 && <p className="text-slate-500">Empty. Copy an app, ASAR or binary here.</p>}
                <ul className="font-mono">
                  {workspace.entries.map((e) => (
                    <li key={e.path}>
                      <button
                        className={`w-full truncate rounded px-1 text-left hover:bg-slate-800 ${path === e.path ? 'bg-blue-900/60' : ''}`}
                        style={{ paddingLeft: `${(e.path.split('/').length - 1) * 12 + 4}px` }}
                        onClick={() => setPath(e.path)}
                        title={e.path}
                      >
                        {e.is_dir ? '📁' : '📄'} {e.path.split('/').pop()}
                        {e.size !== null && <span className="text-slate-500"> · {(e.size / 1024).toFixed(1)} KB</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      </aside>

      <main className="flex flex-col gap-2">
        <JsAnalysisPanel path={path} setPath={setPath} />
        <ToolExplorer selectedPath={path} allowDestructive={status?.allow_destructive ?? false} />
      </main>
    </div>
  );
}
