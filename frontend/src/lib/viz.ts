import type { HeapObject, TraceEvent, VizSnapshot, VizValue } from '../api/types';

export const isRef = (v: VizValue): v is { r: string } => 'r' in v;

/** Visual snapshot in effect at `step` (stdout/exit events carry none, so use the latest before them). */
export function vizAt(events: TraceEvent[], step: number): VizSnapshot | null {
  for (let i = Math.min(step, events.length - 1); i >= 0; i--) {
    const viz = events[i].viz;
    if (viz) return viz;
  }
  return null;
}

function childRefs(obj: HeapObject): string[] {
  const out: string[] = [];
  const add = (v: VizValue) => isRef(v) && out.push(v.r);
  obj.items?.forEach(add);
  obj.entries?.forEach(([k, v]) => {
    add(k);
    add(v);
  });
  obj.attrs?.forEach(([, v]) => add(v));
  return out;
}

/**
 * Heap objects in the order the eye reads them: breadth-first from the innermost
 * frame's variables outwards, so the objects you are working with appear first.
 * Functions and classes go last; they are rarely the interesting part.
 */
export function heapOrder(viz: VizSnapshot, hideCallables: boolean): string[] {
  const seen = new Set<string>();
  const queue: string[] = [];
  const frames = [...viz.stack].reverse();
  for (const f of frames) {
    for (const [, v] of f.locals) if (isRef(v)) queue.push(v.r);
    if (f.return_value && isRef(f.return_value)) queue.push(f.return_value.r);
  }
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id) || !viz.heap[id]) continue;
    seen.add(id);
    order.push(id);
    queue.push(...childRefs(viz.heap[id]));
  }
  const callable = (id: string) => ['function', 'class'].includes(viz.heap[id].kind);
  const data = order.filter((id) => !callable(id));
  return hideCallables ? data : [...data, ...order.filter(callable)];
}

/** Names of variables that hold a reference to `id` anywhere on the stack (for "aliasing" call-outs). */
export function aliasesOf(viz: VizSnapshot, id: string): string[] {
  const names: string[] = [];
  for (const f of viz.stack) for (const [name, v] of f.locals) if (isRef(v) && v.r === id) names.push(name);
  return names;
}

function describeValue(v: VizValue, viz: VizSnapshot): string {
  if (!isRef(v)) return v.p;
  const obj = viz.heap[v.r];
  if (!obj) return 'an object';
  const preview = (items: VizValue[]) =>
    items
      .slice(0, 8)
      .map((i) => (isRef(i) ? `(${viz.heap[i.r]?.type ?? 'object'})` : i.p))
      .join(', ');
  switch (obj.kind) {
    case 'list':
    case 'tuple':
    case 'set':
      return `${obj.type} of ${(obj.items?.length ?? 0) + (obj.more ?? 0)}: ${preview(obj.items ?? [])}${obj.more ? ', …' : ''}`;
    case 'dict':
      return `dict with ${(obj.entries?.length ?? 0) + (obj.more ?? 0)} keys`;
    case 'instance':
      return `${obj.type} object`;
    default:
      return obj.label ?? obj.type;
  }
}

/** Plain-text description of the board for screen readers (the drawing itself is visual only). */
export function describeViz(viz: VizSnapshot): string {
  const frames = viz.stack.map((f) => `${f.function} at line ${f.line}`).join(', called from ');
  const parts = [`Call stack, innermost last: ${viz.stack.map((f) => `${f.function} (line ${f.line})`).join(' then ')}.`];
  const active = viz.stack[viz.stack.length - 1];
  if (active) {
    const vars = active.locals
      .filter(([, v]) => !(isRef(v) && ['function', 'class'].includes(viz.heap[v.r]?.kind ?? '')))
      .map(([name, v]) => {
        const shared = isRef(v) ? aliasesOf(viz, v.r).filter((n) => n !== name) : [];
        return `${name} is ${describeValue(v, viz)}${shared.length ? `, the same object as ${shared.join(' and ')}` : ''}`;
      });
    parts.push(vars.length ? `In ${active.function}: ${vars.join('; ')}.` : `${active.function} has no variables yet.`);
  }
  return frames ? parts.join(' ') : '';
}
