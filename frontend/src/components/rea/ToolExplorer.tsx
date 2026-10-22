import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type { JsonSchema, ReaTool, ReaToolResult } from '../../api/types';

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Skeleton arguments from a JSON schema: required properties, defaults where given. */
function skeleton(schema: JsonSchema | undefined, selectedPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = schema?.properties ?? {};
  for (const name of schema?.required ?? []) {
    const p = props[name] ?? {};
    if (p.default !== undefined) out[name] = p.default;
    else if (name.endsWith('path')) out[name] = selectedPath || '';
    else if (p.enum?.length) out[name] = p.enum[0];
    else if (p.type === 'integer' || p.type === 'number') out[name] = 0;
    else if (p.type === 'boolean') out[name] = false;
    else if (p.type === 'array') out[name] = [];
    else if (p.type === 'object') out[name] = {};
    else out[name] = '';
  }
  return out;
}

/** Browse and invoke any REA MCP tool (spec §4.2.6 tools/call). */
export function ToolExplorer({ selectedPath, allowDestructive }: { selectedPath: string; allowDestructive: boolean }) {
  const [tools, setTools] = useState<ReaTool[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReaTool | null>(null);
  const [args, setArgs] = useState('{}');
  const [argsError, setArgsError] = useState<string | null>(null);
  const [result, setResult] = useState<ReaToolResult | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoadError(null);
    try {
      setTools((await api.reaTools()).tools);
    } catch (e) {
      setLoadError(msg(e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!tools) return [];
    const q = query.toLowerCase();
    return tools.filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }, [tools, query]);

  const select = async (tool: ReaTool) => {
    setResult(null);
    setCallError(null);
    try {
      const full = await api.reaTool(tool.name);
      setSelected(full);
      setArgs(JSON.stringify(skeleton(full.input_schema, selectedPath), null, 2));
    } catch (e) {
      setCallError(msg(e));
    }
  };

  const call = async () => {
    if (!selected) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Arguments must be a JSON object');
      setArgsError(null);
    } catch (e) {
      setArgsError(msg(e));
      return;
    }
    setBusy(true);
    setCallError(null);
    setResult(null);
    try {
      setResult(await api.reaCallTool(selected.name, parsed));
    } catch (e) {
      setCallError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const props = selected?.input_schema?.properties ?? {};

  return (
    <section className="panel min-h-[480px] shrink-0" aria-labelledby="tools-title">
      <div className="panel-title">
        <h2 id="tools-title">REA tool explorer (MCP)</h2>
        <span className="font-normal normal-case text-slate-500">{tools ? `${tools.length} tools` : 'loading…'}</span>
      </div>
      {loadError ? (
        <div className="space-y-2 p-3 text-sm">
          <p className="text-orange-300">{loadError}</p>
          <button className="btn" onClick={load}>
            Retry
          </button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-slate-800">
            <input
              className="input m-2 text-xs"
              placeholder="Search tools (decompile, macho, apk, wasm…)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search REA tools"
            />
            <ul className="max-h-[55vh] min-h-0 flex-1 overflow-auto pb-2 font-mono text-xs">
              {filtered.map((t) => (
                <li key={t.name}>
                  <button
                    onClick={() => select(t)}
                    className={`flex w-full items-center gap-1 px-2 py-0.5 text-left hover:bg-slate-800 ${selected?.name === t.name ? 'bg-blue-900/60' : ''}`}
                    title={t.description}
                  >
                    <span className="w-4 shrink-0" aria-label={t.allowed ? (t.destructive ? 'destructive' : 'allowed') : 'blocked'}>
                      {!t.allowed ? '🔒' : t.destructive ? '⚠' : ''}
                    </span>
                    <span className={`truncate ${t.allowed ? 'text-slate-200' : 'text-slate-500'}`}>{t.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-h-0 overflow-auto p-3 text-sm">
            {!selected ? (
              <p className="text-slate-500">
                Select a tool. Path arguments are resolved inside the REA workspace. Tools marked 🔒 can modify state or run code and are blocked
                {allowDestructive ? '' : ' (set REA_ALLOW_DESTRUCTIVE=1 to enable)'}.
              </p>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono text-base text-sky-300">{selected.name}</h3>
                    {selected.read_only && <span className="rounded bg-emerald-900 px-1.5 text-xs">read-only</span>}
                    {selected.destructive && <span className="rounded bg-orange-900 px-1.5 text-xs">destructive</span>}
                    {selected.open_world && <span className="rounded bg-slate-700 px-1.5 text-xs">external I/O</span>}
                    {!selected.allowed && <span className="rounded bg-red-900 px-1.5 text-xs">🔒 blocked</span>}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-slate-300">{selected.description}</p>
                </div>

                {Object.keys(props).length > 0 && (
                  <details>
                    <summary className="cursor-pointer text-xs text-slate-400">Parameters ({Object.keys(props).length})</summary>
                    <table className="mt-1 w-full text-left text-xs">
                      <tbody>
                        {Object.entries(props).map(([name, p]) => (
                          <tr key={name} className="border-t border-slate-800 align-top">
                            <td className="py-1 pr-2 font-mono text-sky-300">
                              {name}
                              {selected.input_schema?.required?.includes(name) && <span className="text-orange-300">*</span>}
                            </td>
                            <td className="py-1 pr-2 font-mono text-emerald-300">{String(p.type ?? (p.enum ? 'enum' : 'any'))}</td>
                            <td className="py-1 text-slate-400">{p.description ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}

                <label className="block text-xs text-slate-400" htmlFor="tool-args">
                  Arguments (JSON)
                </label>
                <textarea
                  id="tool-args"
                  className="input h-36 w-full font-mono text-xs"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  spellCheck={false}
                />
                {argsError && <p className="text-xs text-orange-300">{argsError}</p>}
                <button className="btn btn-primary" onClick={call} disabled={busy || !selected.allowed}>
                  {busy ? 'Running…' : `Call ${selected.name}`}
                </button>
                {callError && (
                  <p role="alert" className="rounded border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-200">
                    {callError}
                  </p>
                )}
                {result && (
                  <div className="space-y-1">
                    <p className={`text-xs ${result.is_error ? 'text-orange-300' : 'text-emerald-300'}`}>
                      {result.is_error ? '✖ tool reported an error' : '✔ completed'} in {result.duration_ms} ms
                    </p>
                    <pre className="max-h-[50vh] overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-200">
                      {JSON.stringify(result.structured ?? result.content.map((c) => c.value), null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
