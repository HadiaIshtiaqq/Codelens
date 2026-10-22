import { useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { JsAnalysis } from '../../api/types';

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** JavaScript / Electron application analysis (spec §4.3.1). */
export function JsAnalysisPanel({ path, setPath }: { path: string; setPath: (p: string) => void }) {
  const [format, setFormat] = useState('auto');
  const [result, setResult] = useState<JsAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nodeFilter, setNodeFilter] = useState('');

  const analyze = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.reaAnalyzeJs(path, format));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const nodes = result?.nodes.filter(
    (n) => !nodeFilter || `${n.kind} ${n.label} ${n.source}`.toLowerCase().includes(nodeFilter.toLowerCase()),
  );

  return (
    <section className="panel shrink-0" aria-labelledby="js-title">
      <div className="panel-title">
        <h2 id="js-title">JavaScript / Electron application analysis</h2>
        <span className="font-normal normal-case text-slate-500">rea analyze-javascript-application</span>
      </div>
      <div className="space-y-3 p-3">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            analyze();
          }}
        >
          <input
            className="input min-w-[260px] flex-1 font-mono"
            placeholder="app directory or .asar (relative to the REA workspace)"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-label="Application path"
            required
          />
          <select className="input" value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Artifact format">
            <option value="auto">auto</option>
            <option value="directory">directory</option>
            <option value="asar">asar</option>
          </select>
          <button className="btn btn-primary" disabled={busy || !path.trim()}>
            {busy ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>
        {error && (
          <p role="alert" className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-lg font-semibold">{result.application.name ?? 'Application'}</span>
              {result.application.version && <span className="text-slate-400">v{result.application.version}</span>}
              {result.application.main && <span className="font-mono text-xs text-slate-400">main: {result.application.main}</span>}
              <span className="rounded bg-slate-800 px-2 py-0.5 text-xs">confidence: {result.confidence}</span>
              <a className="text-xs text-sky-300 underline" href={`/api/v1/rea/results/${result.result_id}`} target="_blank" rel="noreferrer">
                Full evidence JSON ↗
              </a>
            </div>

            {result.statistics && (
              <div className="flex flex-wrap gap-2 text-xs">
                {Object.entries(result.statistics).map(([k, v]) => (
                  <span key={k} className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
                    {k.replace(/_/g, ' ')}: <strong>{String(v)}</strong>
                  </span>
                ))}
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <Table
                title={`IPC channels (${result.ipc_channels.length})`}
                headers={['Channel', 'Side', 'Operation', 'Location']}
                rows={result.ipc_channels.map((c) => [c.channel, c.side ?? '—', c.operation ?? c.kind, c.location ?? '—'])}
              />
              <Table
                title={`Entrypoints (${result.entrypoints.length})`}
                headers={['Type', 'Path', 'Resolved via']}
                rows={result.entrypoints.map((e) => [e.type, e.path, e.mechanism ?? '—'])}
              />
              <Table
                title={`Context-bridge APIs (${result.context_bridge_apis.length})`}
                headers={['API', 'World', 'Location']}
                rows={result.context_bridge_apis.map((b) => [b.api, b.world ?? '—', b.location ?? '—'])}
              />
              <Table
                title={`Native add-ons (${result.native_addons.length})`}
                headers={['Kind', 'Label', 'Location']}
                rows={result.native_addons.map((n) => [n.kind, n.label, n.location ?? '—'])}
              />
              <Table title={`Source modules (${result.modules.length})`} headers={['Path', 'Format']} rows={result.modules.map((m) => [m.path, m.format ?? '—'])} />
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">External modules ({result.external_modules.length})</h3>
                <div className="flex flex-wrap gap-1 font-mono text-xs">
                  {result.external_modules.map((m) => (
                    <span key={m} className="rounded bg-slate-800 px-1.5 py-0.5">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <details>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                Application graph nodes ({result.nodes.length}) ·{' '}
                {Object.entries(result.node_kinds)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(', ')}
              </summary>
              <input className="input my-2 w-64 text-xs" placeholder="Filter nodes…" value={nodeFilter} onChange={(e) => setNodeFilter(e.target.value)} />
              <Table headers={['Kind', 'Label', 'Source']} rows={(nodes ?? []).slice(0, 500).map((n) => [n.kind, n.label ?? '—', n.source ? `${n.source}:${n.line ?? ''}` : '—'])} />
            </details>

            {result.limitations.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">Analysis limitations ({result.limitations.length})</summary>
                <ul className="mt-1 list-inside list-disc space-y-1 text-xs text-slate-400">
                  {result.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Table({ title, headers, rows }: { title?: string; headers: string[]; rows: string[][] }) {
  return (
    <div className="min-w-0">
      {title && <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{title}</h3>}
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">None found.</p>
      ) : (
        <div className="max-h-64 overflow-auto rounded border border-slate-800">
          <table className="w-full text-left font-mono text-xs">
            <thead className="sticky top-0 bg-slate-900 text-slate-400">
              <tr>
                {headers.map((h) => (
                  <th key={h} scope="col" className="px-2 py-1 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-slate-800">
                  {r.map((c, j) => (
                    <td key={j} className="max-w-[260px] truncate px-2 py-1" title={c}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
