import type { HeapObject, VizFrame, VizSnapshot, VizValue } from '../../api/types';
import { aliasesOf, isRef } from '../../lib/viz';

// The readable board: one card per variable with its value written out, no arrows to follow.
// Objects inside objects are shown as short previews ({'Park': 3}, [1, 2, …]) instead of more boxes.

const TYPE_COLOR: Record<string, string> = {
  int: 'text-sky-200',
  float: 'text-sky-200',
  complex: 'text-sky-200',
  str: 'text-emerald-200',
  bool: 'text-fuchsia-200',
  NoneType: 'text-slate-400',
};

const KIND_ICON: Record<HeapObject['kind'], string> = {
  list: '📦',
  tuple: '🔒',
  set: '🎲',
  dict: '📒',
  instance: '🧩',
  function: 'ƒ',
  class: '🏛',
  other: '◆',
};

const isCallable = (v: VizValue, viz: VizSnapshot) => isRef(v) && ['function', 'class'].includes(viz.heap[v.r]?.kind ?? '');

/** A value in one short line, like Python would print it (nested objects are abbreviated). */
export function preview(v: VizValue, viz: VizSnapshot, depth = 1): string {
  if (!isRef(v)) return v.p;
  const obj = viz.heap[v.r];
  if (!obj) return '…';
  const more = obj.more ? ', …' : '';
  const inner = (x: VizValue) => (depth > 0 ? preview(x, viz, depth - 1) : isRef(x) ? '…' : x.p);
  switch (obj.kind) {
    case 'list':
      return `[${(obj.items ?? []).slice(0, 4).map(inner).join(', ')}${(obj.items?.length ?? 0) > 4 ? ', …' : more}]`;
    case 'tuple':
      return `(${(obj.items ?? []).slice(0, 4).map(inner).join(', ')}${(obj.items?.length ?? 0) > 4 ? ', …' : more})`;
    case 'set':
      return obj.items?.length ? `{${obj.items.slice(0, 4).map(inner).join(', ')}${obj.items.length > 4 ? ', …' : more}}` : 'set()';
    case 'dict':
      return `{${(obj.entries ?? [])
        .slice(0, 3)
        .map(([k, val]) => `${inner(k)}: ${inner(val)}`)
        .join(', ')}${(obj.entries?.length ?? 0) > 3 ? ', …' : more}}`;
    case 'instance':
      return `${obj.type}(…)`;
    default:
      return obj.label ?? obj.type;
  }
}

function Chip({ v, viz }: { v: VizValue; viz: VizSnapshot }) {
  const text = preview(v, viz, 0);
  return (
    <span
      className={`inline-block max-w-[260px] truncate rounded border border-slate-700 bg-slate-950/70 px-1.5 font-mono text-sm ${isRef(v) ? 'text-amber-100' : TYPE_COLOR[v.t] ?? 'text-slate-100'}`}
      title={preview(v, viz, 2)}
    >
      {text}
    </span>
  );
}

const ROW_LIMIT = 12;

function ObjectBody({ obj, viz }: { obj: HeapObject; viz: VizSnapshot }) {
  if (obj.kind === 'list' || obj.kind === 'tuple' || obj.kind === 'set') {
    const items = obj.items ?? [];
    const hidden = Math.max(0, items.length - ROW_LIMIT) + (obj.more ?? 0);
    if (!items.length) return <span className="text-sm italic text-slate-500">empty</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {items.slice(0, ROW_LIMIT).map((item, i) => (
          <span key={i} className="flex flex-col items-center">
            <Chip v={item} viz={viz} />
            {obj.kind !== 'set' && <span className="text-[10px] text-slate-500">{i}</span>}
          </span>
        ))}
        {hidden > 0 && <span className="self-center text-xs text-slate-400">+{hidden} more</span>}
      </div>
    );
  }
  const rows = obj.kind === 'dict' ? obj.entries ?? [] : (obj.attrs ?? []).map(([k, val]) => [{ p: k, t: 'attr' }, val] as [VizValue, VizValue]);
  if (!rows.length) return <span className="text-sm italic text-slate-500">empty</span>;
  const hidden = Math.max(0, rows.length - ROW_LIMIT) + (obj.more ?? 0);
  return (
    <table className="text-sm">
      <tbody>
        {rows.slice(0, ROW_LIMIT).map(([k, val], i) => (
          <tr key={i}>
            <td className="py-0.5 pr-2 align-top">
              {!isRef(k) && k.t === 'attr' ? <span className="font-mono text-pink-200">.{k.p}</span> : <Chip v={k} viz={viz} />}
            </td>
            <td className="py-0.5 pr-2 align-top text-slate-500">→</td>
            <td className="py-0.5 align-top">
              <Chip v={val} viz={viz} />
            </td>
          </tr>
        ))}
        {hidden > 0 && (
          <tr>
            <td colSpan={3} className="text-xs text-slate-400">
              +{hidden} more
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function VarCard({ name, v, viz, changed }: { name: string; v: VizValue; viz: VizSnapshot; changed: boolean }) {
  const obj = isRef(v) ? viz.heap[v.r] : null;
  const shared = isRef(v) ? aliasesOf(viz, v.r).filter((n) => n !== name) : [];
  const size = obj ? (obj.items?.length ?? 0) + (obj.entries?.length ?? 0) * 2 + (obj.attrs?.length ?? 0) * 2 : 0;
  const glow = changed ? 'border-yellow-400 shadow-[0_0_14px_rgba(250,204,21,0.35)]' : 'border-slate-700';
  if (!obj) {
    // A simple value: one compact row.
    return (
      <div className={`flex items-center gap-2 rounded-lg border-2 bg-slate-900/80 px-2 py-1.5 transition-colors ${glow}`} data-var={name} title={isRef(v) ? '' : v.t}>
        <span className="rounded-md bg-sky-500/20 px-1.5 font-mono text-sm font-bold text-sky-100">{name}</span>
        {!isRef(v) && (
          <span className={`cl-pop min-w-0 truncate font-mono text-base font-semibold ${TYPE_COLOR[v.t] ?? 'text-slate-100'}`} key={v.p}>
            {v.p}
          </span>
        )}
        {changed && <span className="ml-auto shrink-0 rounded-full bg-yellow-500 px-1.5 text-[10px] font-black uppercase text-slate-900">new</span>}
      </div>
    );
  }
  return (
    <div
      className={`rounded-xl border-2 bg-slate-900/80 p-2.5 transition-colors ${glow} ${size > 8 ? 'sm:col-span-2' : ''}`}
      data-var={name}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-sky-500/20 px-2 py-0.5 font-mono text-sm font-bold text-sky-100">{name}</span>
        <span className="text-xs text-slate-400">
          {KIND_ICON[obj.kind]} {obj.type}
          {obj.items || obj.entries ? ` · ${(obj.items?.length ?? obj.entries?.length ?? 0) + (obj.more ?? 0)}` : ''}
        </span>
        {changed && <span className="cl-pop rounded-full bg-yellow-500 px-1.5 text-[10px] font-black uppercase text-slate-900">changed</span>}
      </div>
      <ObjectBody obj={obj} viz={viz} />
      {shared.length > 0 && <p className="mt-1.5 text-xs text-fuchsia-300">🔗 same object as {shared.join(', ')}</p>}
    </div>
  );
}

function FrameCards({ frame, viz, changed }: { frame: VizFrame; viz: VizSnapshot; changed: Set<string> }) {
  const shown = frame.locals.filter(([, v]) => !isCallable(v, viz) && (isRef(v) || v.t !== 'module'));
  // Simple values first (they are what usually changes), then lists and dicts, biggest last. The order stays put between steps.
  const weight = ([, v]: [string, VizValue]) => {
    if (!isRef(v)) return 0;
    const obj = viz.heap[v.r];
    return 1 + (obj?.items?.length ?? 0) + (obj?.entries?.length ?? 0) * 2 + (obj?.attrs?.length ?? 0) * 2 > 9 ? 2 : 1;
  };
  const locals = [...shown].sort((a, b) => weight(a) - weight(b));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] items-start gap-2">
      {locals.length === 0 && <p className="text-sm italic text-slate-500">No variables yet.</p>}
      {locals.map(([name, v]) => (
        <VarCard key={name} name={name} v={v} viz={viz} changed={changed.has(name)} />
      ))}
      {frame.return_value && (
        <div className="rounded-xl border-2 border-emerald-500 bg-emerald-950/50 p-2.5">
          <span className="text-sm font-bold text-emerald-200">↩ gives back</span>
          <div className="mt-1 font-mono text-lg text-emerald-100">{preview(frame.return_value, viz, 2)}</div>
        </div>
      )}
    </div>
  );
}

const frameTitle = (f: VizFrame) => (f.function === '<module>' ? '🌍 Main program' : `🚪 Inside ${f.function}()`);

/** Variables of the function the robot is in, big; the callers' variables folded underneath. */
export function CardsBoard({ viz, changed }: { viz: VizSnapshot; changed: Set<string> }) {
  const frames = [...viz.stack].reverse();
  const [active, ...callers] = frames;
  if (!active) return null;
  return (
    <div className="space-y-3 p-3" data-testid="cards-board">
      <section aria-label="Variables where the robot is">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-200">
          {frameTitle(active)}
          <span className="text-xs font-normal text-slate-400">values just before line {active.line} runs</span>
        </h3>
        <FrameCards frame={active} viz={viz} changed={changed} />
      </section>
      {callers.map((f) => (
        <details key={f.id} className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
          <summary className="cursor-pointer text-sm font-semibold text-slate-400">
            {frameTitle(f)} · waiting at line {f.line} ({f.locals.filter(([, v]) => !isCallable(v, viz)).length} variables)
          </summary>
          <div className="mt-2">
            <FrameCards frame={f} viz={viz} changed={new Set()} />
          </div>
        </details>
      ))}
      {viz.hidden_frames > 0 && <p className="text-xs text-slate-500">⋯ {viz.hidden_frames} older calls not shown</p>}
    </div>
  );
}
