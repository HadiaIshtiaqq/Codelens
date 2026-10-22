import { useState } from 'react';
import type { TraceEvent } from '../api/types';

interface Props {
  event: TraceEvent | null;
  changed: Set<string>;
}

/** Variable inspector (spec §4.1, FR-04): locals snapshot for the active step. */
export function VariableInspector({ event, changed }: Props) {
  const [filter, setFilter] = useState('');
  const [hideCallables, setHideCallables] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rows = event
    ? Object.entries(event.locals).filter(([name, value]) => {
        if (filter && !name.toLowerCase().includes(filter.toLowerCase()) && !value.toLowerCase().includes(filter.toLowerCase())) return false;
        if (hideCallables && /^<(function|class|module) /.test(value)) return false;
        return true;
      })
    : [];

  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <section className="panel" aria-labelledby="vars-title">
      <div className="panel-title">
        <h2 id="vars-title">
          Variables{event ? ` · ${event.function}` : ''}
        </h2>
        <div className="flex items-center gap-2 normal-case tracking-normal">
          <label className="flex items-center gap-1 text-[11px] font-normal text-slate-400">
            <input type="checkbox" checked={hideCallables} onChange={(e) => setHideCallables(e.target.checked)} />
            hide functions
          </label>
          <input
            className="input w-28 py-0.5 text-xs font-normal"
            placeholder="Filter…"
            aria-label="Filter variables"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!event ? (
          <p className="p-3 text-sm text-slate-500">Run the program to inspect variables at each step.</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-sm text-slate-500">No local variables at this step.</p>
        ) : (
          <table className="w-full table-fixed text-left font-mono text-xs">
            <thead className="sticky top-0 bg-slate-900 text-slate-400">
              <tr>
                <th scope="col" className="w-1/4 px-3 py-1.5 font-semibold">Name</th>
                <th scope="col" className="px-3 py-1.5 font-semibold">Value</th>
                <th scope="col" className="w-20 px-3 py-1.5 font-semibold">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, value]) => {
                const isChanged = changed.has(name);
                const open = expanded.has(name);
                return (
                  <tr key={name} className={`border-t border-slate-800 ${isChanged ? 'bg-blue-950/50' : ''}`}>
                    <td className="truncate px-3 py-1 text-sky-300" title={name}>
                      {isChanged && (
                        <span className="mr-1 text-blue-400" aria-label="changed at this step" title="changed at this step">
                          ●
                        </span>
                      )}
                      {name}
                    </td>
                    <td className="px-3 py-1">
                      <button
                        type="button"
                        onClick={() => toggle(name)}
                        aria-expanded={open}
                        className={`w-full text-left text-slate-100 ${open ? 'whitespace-pre-wrap break-all' : 'truncate'}`}
                        title={open ? 'Collapse' : 'Expand'}
                      >
                        {value}
                      </button>
                    </td>
                    <td className="truncate px-3 py-1 text-emerald-300">{event.local_types?.[name] ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {event?.event === 'return' && (
        <div className="border-t border-slate-800 px-3 py-1.5 font-mono text-xs">
          <span className="text-slate-400">returns </span>
          <span className="text-emerald-300">{event.return_value}</span>
        </div>
      )}
    </section>
  );
}
