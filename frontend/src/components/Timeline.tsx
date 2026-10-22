import { useEffect, useRef } from 'react';
import type { TraceEvent } from '../api/types';
import { eventLabel } from '../lib/trace';

const GLYPH: Record<TraceEvent['event'], { g: string; cls: string }> = {
  call: { g: '↘', cls: 'text-sky-300' },
  line: { g: '·', cls: 'text-slate-400' },
  return: { g: '↖', cls: 'text-emerald-300' },
  exception: { g: '✖', cls: 'text-orange-300' },
  stdout: { g: '»', cls: 'text-violet-300' },
  exit: { g: '■', cls: 'text-slate-300' },
};

/** Execution timeline: every recorded event; click to time-travel to it. */
export function Timeline({ events, step, onSelect }: { events: TraceEvent[]; step: number; onSelect: (s: number) => void }) {
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [step]);

  return (
    <section className="panel" aria-labelledby="timeline-title">
      <div className="panel-title">
        <h2 id="timeline-title">Timeline</h2>
        <span className="font-normal normal-case text-slate-500">{events.length} events</span>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs" aria-label="Trace events">
        {events.length === 0 && <li className="px-3 py-1 font-sans text-sm text-slate-500">No trace yet.</li>}
        {events.map((ev) => {
          const active = ev.step === step;
          const { g, cls } = GLYPH[ev.event];
          const gap = ev.skipped_before
            ? `⋯ ${ev.skipped_before.toLocaleString()} steps skipped`
            : ev.untraced_before
              ? '⏸ line recording paused (program kept running)'
              : null;
          return (
            <li key={ev.step}>
              {gap && <div className="border-y border-dashed border-slate-700 bg-slate-950 px-3 py-0.5 text-center text-[11px] text-slate-400">{gap}</div>}
              <button
                ref={active ? activeRef : undefined}
                type="button"
                aria-current={active ? 'step' : undefined}
                onClick={() => onSelect(ev.step)}
                className={`flex w-full items-center gap-2 px-2 py-0.5 text-left hover:bg-slate-800 ${active ? 'bg-blue-900/60 ring-1 ring-inset ring-blue-500' : ''}`}
                style={{ paddingLeft: `${8 + Math.min(ev.stack_depth - 1, 8) * 10}px` }}
              >
                <span className="w-9 shrink-0 text-right text-slate-500">{ev.step + 1}</span>
                <span className={`w-3 shrink-0 text-center ${cls}`} aria-label={ev.event}>
                  {g}
                </span>
                <span className="w-24 shrink-0 truncate text-slate-400">{ev.function}</span>
                <span className="w-10 shrink-0 text-slate-500">L{ev.line}</span>
                <span className={`truncate ${ev.event === 'exception' ? 'text-orange-200' : 'text-slate-200'}`} title={ev.narration}>
                  {ev.narration ?? eventLabel(ev)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
