import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ExecutionResponse, HeapObject, TraceEvent, VizFrame, VizSnapshot, VizValue } from '../../api/types';
import { aliasesOf, describeViz, heapOrder, isRef } from '../../lib/viz';

interface Props {
  viz: VizSnapshot | null;
  event: TraceEvent | null;
  summary: ExecutionResponse | null;
  isLast: boolean;
  onExplain: () => void;
  onFix: () => void;
  onReplay: () => void;
}

interface Arrow {
  key: string;
  d: string;
  active: boolean;
}

const TYPE_STYLE: Record<string, string> = {
  int: 'text-sky-200 border-sky-500/50 bg-sky-500/10',
  float: 'text-sky-200 border-sky-500/50 bg-sky-500/10',
  complex: 'text-sky-200 border-sky-500/50 bg-sky-500/10',
  str: 'text-emerald-200 border-emerald-500/50 bg-emerald-500/10',
  bool: 'text-fuchsia-200 border-fuchsia-500/50 bg-fuchsia-500/10',
  NoneType: 'text-slate-400 border-slate-600 bg-slate-700/30',
};

const KIND_STYLE: Record<HeapObject['kind'], { border: string; badge: string; icon: string }> = {
  list: { border: 'border-amber-400/70', badge: 'bg-amber-500/20 text-amber-200', icon: '📦' },
  tuple: { border: 'border-yellow-300/60', badge: 'bg-yellow-500/20 text-yellow-100', icon: '🔒' },
  set: { border: 'border-lime-400/60', badge: 'bg-lime-500/20 text-lime-100', icon: '🎲' },
  dict: { border: 'border-violet-400/70', badge: 'bg-violet-500/20 text-violet-200', icon: '📒' },
  instance: { border: 'border-pink-400/70', badge: 'bg-pink-500/20 text-pink-200', icon: '🧩' },
  function: { border: 'border-slate-600', badge: 'bg-slate-700 text-slate-300', icon: 'ƒ' },
  class: { border: 'border-slate-500', badge: 'bg-slate-700 text-slate-200', icon: '🏛' },
  other: { border: 'border-slate-600', badge: 'bg-slate-700 text-slate-300', icon: '◆' },
};

/** A primitive is shown inline; a reference is a dot that an arrow starts from. */
function Value({ v, srcKey, small }: { v: VizValue; srcKey: string; small?: boolean }) {
  if (isRef(v)) {
    return (
      <span
        data-src={srcKey}
        data-target={v.r}
        className="inline-block h-3 w-3 rounded-full border-2 border-blue-300 bg-blue-500 shadow-[0_0_8px_rgba(96,165,250,0.9)]"
        title="reference: follow the arrow"
      />
    );
  }
  return (
    <span
      key={v.p} // remount on change -> replays the "pop" animation
      className={`cl-pop inline-block max-w-[220px] truncate rounded border px-1.5 font-mono ${small ? 'text-[11px]' : 'text-xs'} ${
        TYPE_STYLE[v.t] ?? 'border-slate-600 bg-slate-800 text-slate-200'
      }`}
      title={`${v.p}  (${v.t})`}
    >
      {v.p}
    </span>
  );
}

function FrameCard({
  frame,
  active,
  event,
}: {
  frame: VizFrame;
  active: boolean;
  event: TraceEvent | null;
}) {
  const crashed = active && event?.event === 'exception';
  const returning = active && event?.event === 'return';
  const isModule = frame.function === '<module>';
  return (
    <div
      className={`cl-slide-in relative rounded-xl border-2 p-2.5 transition-colors ${
        crashed
          ? 'cl-shake border-orange-500 bg-orange-950/50'
          : active
            ? 'border-blue-400 bg-blue-950/50 shadow-[0_0_24px_rgba(59,130,246,0.35)]'
            : 'border-slate-700 bg-slate-900/80 opacity-80'
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-bold text-slate-100">
          {isModule ? '🏠 Global world' : `🚪 ${frame.function}()`}
        </span>
        {active ? (
          <span className={`cl-bob rounded-full px-2 py-0.5 text-xs font-semibold ${crashed ? 'bg-orange-600' : 'bg-blue-600'}`}>
            {crashed ? '😵' : '🤖'} line {frame.line}
          </span>
        ) : (
          <span className="text-[11px] text-slate-500">waiting at line {frame.line}</span>
        )}
      </div>
      {frame.locals.length === 0 ? (
        <p className="text-xs italic text-slate-500">empty room</p>
      ) : (
        <table className="w-full border-separate border-spacing-y-1 text-xs">
          <tbody>
            {frame.locals.map(([name, v]) => (
              <tr key={name} className="cl-slide-in">
                <td className="w-1/3 pr-2 text-right font-mono text-sky-300">{name}</td>
                <td className="relative">
                  <Value v={v} srcKey={`${frame.id}:${name}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {returning && frame.return_value && (
        <div className="cl-float-up mt-2 flex items-center gap-2 rounded-lg bg-emerald-900/70 px-2 py-1 text-xs font-semibold text-emerald-100">
          ↩ returns <Value v={frame.return_value} srcKey={`${frame.id}:<return>`} />
        </div>
      )}
    </div>
  );
}

function HeapCard({ id, obj, viz }: { id: string; obj: HeapObject; viz: VizSnapshot }) {
  const style = KIND_STYLE[obj.kind];
  const aliases = aliasesOf(viz, id);
  const shared = aliases.length > 1;
  return (
    <div
      data-heap={id}
      className={`cl-appear relative w-fit max-w-[560px] rounded-xl border-2 bg-slate-900/90 p-2 ${style.border} ${shared ? 'ring-2 ring-fuchsia-400/60' : ''}`}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        <span className={`rounded px-1.5 py-0.5 font-semibold ${style.badge}`}>
          {style.icon} {obj.type}
        </span>
        {obj.items && <span className="text-slate-400">len {obj.items.length + (obj.more ?? 0)}</span>}
        {shared && (
          <span className="rounded bg-fuchsia-600/30 px-1.5 text-fuchsia-200" title="Several names point at this same object">
            🔗 shared by {aliases.join(', ')}
          </span>
        )}
      </div>

      {(obj.kind === 'list' || obj.kind === 'tuple' || obj.kind === 'set') && obj.items && (
        <div className="flex flex-wrap gap-0.5">
          {obj.items.length === 0 && <span className="px-2 text-xs italic text-slate-500">empty</span>}
          {obj.items.map((item, i) => (
            <div key={i} className="flex min-w-[34px] flex-col items-center rounded border border-slate-700 bg-slate-950 px-1 py-1">
              <Value v={item} srcKey={`${id}:${i}`} small />
              {obj.kind !== 'set' && <span className="mt-0.5 font-mono text-[9px] text-slate-500">{i}</span>}
            </div>
          ))}
          {!!obj.more && <span className="self-center px-1 text-xs text-slate-400">+{obj.more} more</span>}
        </div>
      )}

      {obj.kind === 'dict' && obj.entries && (
        <table className="text-xs">
          <tbody>
            {obj.entries.length === 0 && (
              <tr>
                <td className="px-2 italic text-slate-500">empty</td>
              </tr>
            )}
            {obj.entries.map(([k, v], i) => (
              <tr key={i} className="border-t border-slate-800">
                <td className="py-0.5 pr-2 text-right">
                  <Value v={k} srcKey={`${id}:k${i}`} small />
                </td>
                <td className="text-slate-500">→</td>
                <td className="py-0.5 pl-2">
                  <Value v={v} srcKey={`${id}:v${i}`} small />
                </td>
              </tr>
            ))}
            {!!obj.more && (
              <tr>
                <td colSpan={3} className="text-slate-400">
                  +{obj.more} more keys
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {obj.kind === 'instance' && (
        <table className="text-xs">
          <tbody>
            {(obj.attrs ?? []).map(([name, v]) => (
              <tr key={name}>
                <td className="pr-2 text-right font-mono text-pink-200">.{name}</td>
                <td>
                  <Value v={v} srcKey={`${id}:${name}`} small />
                </td>
              </tr>
            ))}
            {(obj.attrs ?? []).length === 0 && (
              <tr>
                <td className="italic text-slate-500">no attributes</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {(obj.kind === 'function' || obj.kind === 'class' || obj.kind === 'other') && (
        <span className="font-mono text-xs text-slate-300">{obj.label}</span>
      )}
    </div>
  );
}

const CONFETTI_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#eab308', '#ec4899', '#a855f7'];

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        duration: 1.6 + Math.random() * 1.4,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        rotate: Math.random() * 360,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="cl-fall absolute top-[-12px] h-3 w-2 rounded-sm"
          style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s`, rotate: `${p.rotate}deg` }}
        />
      ))}
    </div>
  );
}

/** Python-Tutor-style frames & objects view, presented as a game board. */
export function Stage({ viz, event, summary, isLast, onExplain, onFix, onReplay }: Props) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hideCallables, setHideCallables] = useState(true);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const order = useMemo(() => (viz ? heapOrder(viz, hideCallables) : []), [viz, hideCallables]);
  const visible = useMemo(() => new Set(order), [order]);
  const activeFrameId = viz?.stack[viz.stack.length - 1]?.id;

  // Measure DOM after layout and draw curved arrows from reference dots to heap objects.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const draw = () => {
      const base = content.getBoundingClientRect();
      const next: Arrow[] = [];
      content.querySelectorAll<HTMLElement>('[data-target]').forEach((src) => {
        const targetId = src.dataset.target!;
        const target = content.querySelector<HTMLElement>(`[data-heap="${targetId}"]`);
        if (!target) return;
        const s = src.getBoundingClientRect();
        const t = target.getBoundingClientRect();
        const x1 = s.left + s.width / 2 - base.left;
        const y1 = s.top + s.height / 2 - base.top;
        const leftward = t.left + 2 < s.left;
        const x2 = (leftward ? t.right : t.left) - base.left + (leftward ? 2 : -2);
        const y2 = t.top - base.top + 16;
        const bend = Math.max(40, Math.abs(x2 - x1) * 0.4);
        const c1 = x1 + bend;
        const c2 = leftward ? x2 + bend : x2 - bend;
        next.push({
          key: `${src.dataset.src}->${targetId}`,
          d: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`,
          active: !!activeFrameId && (src.dataset.src ?? '').startsWith(activeFrameId + ':'),
        });
      });
      setArrows(next);
      setSize({ w: content.scrollWidth, h: content.scrollHeight });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(content);
    return () => ro.disconnect();
  }, [viz, order, activeFrameId]);

  if (!viz && summary && (summary.error || summary.status !== 'completed')) {
    return (
      <div className="cl-stage-bg flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="cl-shake text-6xl">💥</div>
        <p className="text-2xl font-black text-orange-300">The robot couldn&apos;t even start!</p>
        <p className="max-w-lg font-mono text-sm text-slate-300">
          {summary.error
            ? summary.error.line
              ? `${summary.error.type} at line ${summary.error.line}: ${summary.error.message}`
              : `${summary.error.type}: ${summary.error.message}`
            : summary.status}
        </p>
        <p className="max-w-lg text-sm text-slate-400">
          {summary.status === 'timed_out'
            ? 'The sandbox ran out of time before your program could start. If Docker was just launched it may still be warming up, so press Run again.'
            : summary.status === 'failed'
              ? 'The sandbox could not run the program (see the message above).'
              : 'Python checks the whole program before running it. Fix the marked line and press Run again.'}
        </p>
        {summary.error && (
          <button className="btn btn-primary" onClick={onExplain}>
            🧠 Explain this error
          </button>
        )}
      </div>
    );
  }

  if (!viz) {
    return (
      <div className="cl-stage-bg flex h-full flex-col items-center justify-center gap-3 text-center">
        <div className="cl-bob text-6xl">🤖</div>
        <p className="text-lg font-semibold">Press ▶ Run Code to start the game</p>
        <p className="max-w-md text-sm text-slate-400">
          Your program becomes a board: every function call is a room, every list, dict and object is a box, and arrows show which
          variables point at which objects.
        </p>
      </div>
    );
  }

  const crashedHere = event?.event === 'exception';
  const endOverlay = isLast && summary && dismissedAt !== event?.step;
  const won = summary?.status === 'completed' && !summary.error;

  return (
    <div className={`cl-stage-bg relative h-full overflow-auto ${crashedHere ? 'cl-shake-soft' : ''}`}>
      {crashedHere && event.event === 'exception' && (
        <div className="cl-pop sticky top-0 z-20 mx-auto w-fit rounded-b-xl bg-orange-600 px-4 py-1.5 text-sm font-bold text-white shadow-lg">
          💥 {event.exception.type}: {event.exception.message} — line {event.line}
        </div>
      )}
      {event?.event === 'stdout' && (
        <div className="cl-bubble absolute left-4 top-3 z-20 max-w-[60%] rounded-2xl rounded-bl-none border border-violet-400 bg-violet-950 px-3 py-1.5 font-mono text-sm text-violet-100 shadow-lg">
          💬 {event.stdout_chunk.trimEnd() || '(blank line)'}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {describeViz(viz)}
      </p>
      {/* Narrow screens stack frames above objects; arrows are recomputed from the layout either way. */}
      <div ref={contentRef} aria-hidden className="relative flex min-h-full flex-col items-start gap-10 p-4 pt-12 sm:min-w-fit sm:flex-row sm:gap-24 sm:p-5 sm:pt-12">
        <section aria-label="Call stack frames" className="flex w-full max-w-[300px] shrink-0 flex-col gap-3 sm:w-[300px]">
          <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">Frames · where the robot is</h3>
          {viz.hidden_frames > 0 && (
            <div className="rounded-lg border border-dashed border-slate-600 px-2 py-1 text-center text-xs text-slate-400">
              ⋯ {viz.hidden_frames} older frames
            </div>
          )}
          {viz.stack.map((f) => (
            <FrameCard key={f.id} frame={f} active={f.id === activeFrameId} event={event} />
          ))}
        </section>

        <section aria-label="Objects" className="flex min-w-[240px] flex-col gap-4">
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">Objects · what they point at</h3>
            <label className="flex items-center gap-1 text-[11px] text-slate-400">
              <input type="checkbox" checked={hideCallables} onChange={(e) => setHideCallables(e.target.checked)} />
              hide functions
            </label>
          </div>
          {order.length === 0 && <p className="text-xs italic text-slate-500">No objects yet: only simple values so far.</p>}
          {order.map((id) => (
            <HeapCard key={id} id={id} obj={viz.heap[id]} viz={viz} />
          ))}
        </section>

        <svg className="pointer-events-none absolute left-0 top-0" width={size.w} height={size.h} aria-hidden>
          <defs>
            <marker id="cl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#60a5fa" />
            </marker>
            <marker id="cl-arrow-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#475569" />
            </marker>
          </defs>
          {arrows
            .filter((a) => visible.has(a.key.split('->')[1]))
            .map((a) => (
              <path
                key={a.key + a.d.length}
                d={a.d}
                pathLength={1}
                fill="none"
                stroke={a.active ? '#60a5fa' : '#475569'}
                strokeWidth={a.active ? 2.2 : 1.6}
                markerEnd={`url(#${a.active ? 'cl-arrow' : 'cl-arrow-dim'})`}
                className="cl-draw"
              />
            ))}
        </svg>
      </div>

      {endOverlay && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/70 backdrop-blur-[2px]">
          {won && <Confetti />}
          <div className="cl-pop relative rounded-2xl border-2 border-slate-600 bg-slate-900 p-6 text-center shadow-2xl">
            {won ? (
              <>
                <div className="text-5xl">🏁</div>
                <h3 className="mt-2 text-2xl font-black text-emerald-300">YOU WIN!</h3>
                <p className="text-sm text-slate-300">The program finished cleanly in {summary.total_steps} steps.</p>
              </>
            ) : summary.status === 'timed_out' ? (
              <>
                <div className="text-5xl">⏱</div>
                <h3 className="mt-2 text-2xl font-black text-orange-300">TIME&apos;S UP!</h3>
                <p className="text-sm text-slate-300">The robot is stuck in a loop that never ends. Find the line it keeps repeating.</p>
              </>
            ) : (
              <>
                <div className="text-5xl">💥</div>
                <h3 className="mt-2 text-2xl font-black text-orange-300">GAME OVER</h3>
                <p className="text-sm text-slate-300">
                  {summary.error ? `${summary.error.type} at line ${summary.error.line}: ${summary.error.message}` : 'The program crashed.'}
                </p>
              </>
            )}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button className="btn" onClick={onReplay}>
                ↺ Replay
              </button>
              {!won && (
                <>
                  <button className="btn btn-primary" onClick={onExplain}>
                    🧠 Explain the bug
                  </button>
                  {summary.error && (
                    <button className="btn btn-warn" onClick={onFix}>
                      🛠 Fix it
                    </button>
                  )}
                </>
              )}
              <button className="btn" onClick={() => setDismissedAt(event?.step ?? null)}>
                Keep exploring
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
