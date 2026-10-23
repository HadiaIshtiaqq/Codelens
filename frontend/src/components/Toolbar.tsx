import { useEffect, type ReactNode } from 'react';
import type { Debugger } from '../hooks/useDebugger';
import { EXAMPLES } from '../lib/examples';
import { SAFE_URL_LENGTH, shareUrl } from '../lib/share';
import { useState } from 'react';
import { StatusBadge } from './StatusBadge';

/** Header toolbar (spec §4.1) with keyboard shortcuts (spec §1.4 accessibility). */
export function Toolbar({ dbg, leading }: { dbg: Debugger; leading?: ReactNode }) {
  const [shareNote, setShareNote] = useState<string | null>(null);
  const { phase, step, total, run, stale } = dbg;
  const running = phase === 'running';
  const canStep = !!run && total > 0 && !running;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      let handled = true;
      if (mod && e.key === 'Enter') dbg.execute();
      else if (e.key === 'F10' && e.shiftKey) dbg.prev();
      else if (e.key === 'F10') dbg.next();
      else if (e.altKey && e.key === 'ArrowRight') dbg.next();
      else if (e.altKey && e.key === 'ArrowLeft') dbg.prev();
      else if (e.altKey && e.key === 'Home') dbg.reset();
      else if (e.altKey && e.key === 'End') dbg.last();
      else if (e.altKey && (e.key === 'e' || e.key === 'E')) dbg.jumpToFailure();
      else if (e.key === 'F8' && e.shiftKey) dbg.backToBreakpoint();
      else if (e.key === 'F8') dbg.continueToBreakpoint();
      else if (e.key === 'F9' && dbg.run && !dbg.stale) {
        const ev = dbg.run.events[dbg.step];
        if (ev) dbg.toggleBreakpoint(ev.line, ev.file);
      }
      else if (e.key === 'Escape' && running) dbg.cancel();
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true); // capture: works while Monaco has focus
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dbg, running]);

  return (
    <div role="toolbar" aria-label="Execution controls" className="flex flex-wrap items-center gap-2 px-3 py-2">
      {leading}
      <label className="sr-only" htmlFor="example">
        Load example
      </label>
      <select
        id="example"
        className="input w-48"
        defaultValue=""
        onChange={(e) => {
          const ex = EXAMPLES.find((x) => x.id === e.target.value);
          if (ex) {
            dbg.loadProject(ex.source);
            dbg.setTests('');
          }
          e.target.value = '';
        }}
      >
        <option value="" disabled>
          Load example…
        </option>
        {EXAMPLES.map((ex) => (
          <option key={ex.id} value={ex.id}>
            {ex.title}
          </option>
        ))}
      </select>

      {running ? (
        <button className="btn btn-warn" onClick={dbg.cancel} aria-keyshortcuts="Escape">
          ■ Cancel <span className="kbd">Esc</span>
        </button>
      ) : (
        <button className="btn btn-primary" onClick={dbg.execute} aria-keyshortcuts="Control+Enter">
          ▶ Run Code <span className="kbd hidden 2xl:inline">Ctrl+↵</span>
        </button>
      )}

      <button
        className="btn"
        title="Copy a link that opens this program"
        onClick={async () => {
          const url = await shareUrl({ source: dbg.source, files: dbg.files, stdin: dbg.stdin });
          history.replaceState(null, '', url);
          let note = 'Link copied';
          try {
            await navigator.clipboard.writeText(url);
          } catch {
            note = 'Link is in the address bar';
          }
          if (url.length > SAFE_URL_LENGTH) note = `Link is very long (${Math.round(url.length / 1000)}k chars) and may break in some apps`;
          setShareNote(note);
          setTimeout(() => setShareNote(null), 3500);
        }}
      >
        🔗 Share
      </button>
      {shareNote && (
        <span role="status" className="text-xs text-slate-300">
          {shareNote}
        </span>
      )}

      <div className="mx-1 h-6 w-px bg-slate-700" aria-hidden />

      <button className="btn" onClick={dbg.reset} disabled={!canStep || step === 0} aria-keyshortcuts="Alt+Home" title="Reset to first step (Alt+Home)">
        ⏮ Reset
      </button>
      <button className="btn" onClick={dbg.prev} disabled={!canStep || step === 0} aria-keyshortcuts="Shift+F10 Alt+ArrowLeft" title="Step previous (Shift+F10 / Alt+←)">
        ◀ Step Prev
      </button>
      <button
        className="btn"
        onClick={dbg.next}
        disabled={!canStep || step >= total - 1}
        aria-keyshortcuts="F10 Alt+ArrowRight"
        title="Step next (F10 / Alt+→)"
      >
        Step Next ▶
      </button>
      <button className="btn" onClick={dbg.last} disabled={!canStep || step >= total - 1} aria-keyshortcuts="Alt+End" title="Last step (Alt+End)">
        ⏭
      </button>
      <button
        className="btn"
        onClick={dbg.backToBreakpoint}
        disabled={!canStep || step === 0}
        aria-keyshortcuts="Shift+F8"
        title="Back to the previous breakpoint (Shift+F8)"
      >
        ⏪
      </button>
      <button
        className="btn"
        onClick={dbg.continueToBreakpoint}
        disabled={!canStep || step >= total - 1}
        aria-keyshortcuts="F8"
        title="Continue to the next breakpoint (F8). Click the gutter next to a line number to set one."
      >
        ⏩ Continue
      </button>
      {dbg.breakpoints.size > 0 && (
        <span className="flex items-center gap-1 rounded-full border border-red-800 bg-red-950/60 px-2 py-0.5 text-xs text-red-200">
          ● {dbg.breakpoints.size} breakpoint{dbg.breakpoints.size > 1 ? 's' : ''}
          <button className="ml-1 text-red-300 hover:text-white" onClick={dbg.clearBreakpoints} aria-label="Clear all breakpoints" title="Clear all breakpoints">
            ✕
          </button>
        </span>
      )}
      {dbg.failStep !== null && (
        <button className="btn border-orange-600 text-orange-200" onClick={dbg.jumpToFailure} aria-keyshortcuts="Alt+E" title="Jump to failure (Alt+E)">
          ✖ Go to error
        </button>
      )}

      {canStep && (
        <div className="flex min-w-[220px] flex-1 items-center gap-2">
          <label htmlFor="step-slider" className="sr-only">
            Trace step
          </label>
          <input
            id="step-slider"
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={step}
            onChange={(e) => dbg.goTo(Number(e.target.value))}
            className="flex-1 accent-blue-500"
            aria-valuetext={`Step ${step + 1} of ${total}`}
          />
          <span className="whitespace-nowrap font-mono text-xs text-slate-300" aria-live="polite">
            Step {step + 1}/{total}
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-slate-400">
          Timeout
          <select className="input py-1 text-xs" value={dbg.timeoutSeconds} onChange={(e) => dbg.setTimeoutSeconds(Number(e.target.value))}>
            {[1, 2, 3, 5].map((s) => (
              <option key={s} value={s}>
                {s}s
              </option>
            ))}
          </select>
        </label>
        {stale && (
          <span className="rounded bg-yellow-900/60 px-2 py-0.5 text-xs text-yellow-200" title="The code changed since this trace was recorded">
            ⚠ trace out of date
          </span>
        )}
        <StatusBadge phase={phase} summary={run?.summary ?? null} progress={dbg.progress} />
      </div>
    </div>
  );
}
