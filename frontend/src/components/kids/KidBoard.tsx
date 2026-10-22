import type { VizFrame, VizSnapshot, VizValue } from '../../api/types';
import { isRef } from '../../lib/viz';

/** A primitive value as a child would read it. */
function friendly(v: { p: string; t: string }): string {
  if (v.t === 'str') return v.p.length >= 2 ? `“${v.p.slice(1, -1)}”` : v.p;
  if (v.t === 'bool') return v.p === 'True' ? 'True ✅' : 'False ❌';
  if (v.t === 'NoneType') return 'empty';
  return v.p;
}

function Train({ items, more }: { items: VizValue[]; more: number }) {
  return (
    <div className="flex flex-wrap items-end gap-1">
      <span className="text-2xl" aria-hidden>
        🚂
      </span>
      {items.length === 0 && <span className="text-sm italic text-amber-200/70">no cars yet</span>}
      {items.map((item, i) => (
        <div key={i} className="flex flex-col items-center">
          <div className="min-w-[44px] rounded-md border-2 border-amber-400 bg-amber-500/20 px-2 py-1 text-center text-base font-bold text-amber-50">
            {isRef(item) ? '📦' : friendly(item)}
          </div>
          <span className="mt-0.5 text-[11px] font-semibold text-amber-300">car {i}</span>
        </div>
      ))}
      {more > 0 && <span className="text-sm text-amber-200">+{more} more</span>}
    </div>
  );
}

function BoxValue({ v, viz }: { v: VizValue; viz: VizSnapshot }) {
  if (!isRef(v)) return <span className="text-2xl font-black text-white">{friendly(v)}</span>;
  const obj = viz.heap[v.r];
  if (!obj) return <span className="text-white">?</span>;
  if (obj.kind === 'list' || obj.kind === 'tuple') return <Train items={obj.items ?? []} more={obj.more ?? 0} />;
  if (obj.kind === 'dict') {
    return (
      <div className="space-y-0.5 text-sm">
        {(obj.entries ?? []).map(([k, val], i) => (
          <div key={i} className="flex gap-2">
            <span className="rounded bg-violet-500/30 px-1.5 font-semibold text-violet-100">{isRef(k) ? '📦' : friendly(k)}</span>→
            <span className="font-bold text-white">{isRef(val) ? '📦' : friendly(val)}</span>
          </div>
        ))}
      </div>
    );
  }
  if (obj.kind === 'instance') return <span className="text-lg text-pink-100">a {obj.type} 🧩</span>;
  return <span className="text-lg text-slate-200">{obj.label ?? obj.type}</span>;
}

/** Hide tricks, blueprints and toolboxes: young learners care about the values. */
function visibleLocals(frame: VizFrame, viz: VizSnapshot): [string, VizValue][] {
  return frame.locals.filter(([, v]) => {
    if (!isRef(v)) return v.t !== 'module';
    const kind = viz.heap[v.r]?.kind;
    return kind !== 'function' && kind !== 'class';
  });
}

/** The robot's boxes: one labeled cardboard box per variable, lists drawn as trains. */
export function KidBoard({ viz, changed }: { viz: VizSnapshot | null; changed: Set<string> }) {
  if (!viz || viz.stack.length === 0) {
    return <p className="p-4 text-lg text-slate-400">Robo's boxes will show up here when you press Start.</p>;
  }
  const main = viz.stack[0];
  const inner = viz.stack.length > 1 ? viz.stack[viz.stack.length - 1] : null;
  const section = (frame: VizFrame, title: string, active: boolean) => {
    const locals = visibleLocals(frame, viz);
    return (
      <div className={`rounded-2xl border-2 p-3 ${active ? 'border-sky-400 bg-sky-950/40' : 'border-slate-700 bg-slate-900/50'}`}>
        <h3 className="mb-2 text-base font-bold text-sky-200">{title}</h3>
        {locals.length === 0 ? (
          <p className="text-base italic text-slate-400">No boxes yet.</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {locals.map(([name, v]) => {
              const isNew = active && changed.has(name);
              return (
                <div
                  key={name}
                  className={`relative min-w-[110px] rounded-xl border-4 bg-[#7a5230] p-2 pt-5 shadow-lg ${isNew ? 'cl-pop border-yellow-300' : 'border-[#a8743f]'}`}
                >
                  <span className="absolute -top-3 left-2 rounded-md bg-yellow-200 px-2 py-0.5 font-mono text-sm font-black text-slate-900 shadow">
                    {name}
                  </span>
                  {isNew && (
                    <span className="absolute -right-2 -top-3 rounded-full bg-yellow-300 px-1.5 text-xs font-bold text-slate-900">new!</span>
                  )}
                  <div className="flex min-h-[44px] items-center justify-center rounded-lg bg-[#5a3a1f] px-2 py-1">
                    <BoxValue v={v} viz={viz} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="space-y-3 p-3">
      {section(main, '📦 Robo\'s boxes', inner === null)}
      {inner && section(inner, `🎩 Boxes inside the ${inner.function} trick`, true)}
    </div>
  );
}
