import { useEffect, useMemo, useRef } from 'react';
import type { CodeExplanation, ExplainLevel } from '../api/types';

// "What does this program do?" as its own page: a summary, any bugs spotted before running, then
// every line of code beside its explanation. Built from the code alone, so it works before a run.

const TITLES: Record<ExplainLevel, { title: string; subtitle: string }> = {
  kid: { title: 'What does this program do?', subtitle: "Robo reads the code with you, one line at a time." },
  game: { title: 'Quest briefing', subtitle: 'Every move the robot will make, before you press Run.' },
  classic: { title: 'Program walkthrough', subtitle: 'A line-by-line reading of the source, before execution.' },
};

interface Props {
  source: string;
  plan: CodeExplanation | null;
  level: ExplainLevel;
  /** Line the program is on right now, if a run is being stepped through. */
  currentLine?: number | null;
  onLine: (line: number) => void;
  onClose: () => void;
}

export function ProgramExplainer({ source, plan, level, currentLine, onLine, onClose }: Props) {
  const close = useRef<HTMLButtonElement>(null);
  const lines = useMemo(() => source.replace(/\n$/, '').split('\n'), [source]);
  const warned = useMemo(() => new Set(plan?.warnings?.map((w) => w.line) ?? []), [plan]);
  const { title, subtitle } = TITLES[level];
  const big = level === 'kid';

  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const explained = plan ? Object.keys(plan.line_notes).length : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/70 p-3 backdrop-blur-sm sm:p-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="explainer-title"
        className="cl-appear flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl shadow-black/50"
      >
        <header className="flex items-start gap-4 border-b border-white/10 bg-slate-950/60 px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="explainer-title" className={`font-extrabold text-white ${big ? 'text-2xl' : 'text-xl'}`}>
              {title}
            </h2>
            <p className="mt-0.5 text-sm text-slate-400">{subtitle}</p>
          </div>
          <button ref={close} className="btn" onClick={onClose} aria-label="Close (Esc)">
            ✕ Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {!plan ? (
            <p className="text-slate-400">Reading the code…</p>
          ) : (
            <>
              <p className={`${big ? 'text-lg' : 'text-base'} leading-relaxed ${plan.ok ? 'text-slate-200' : 'text-orange-200'}`}>{plan.intro}</p>
              {plan.ok && (
                <p className="mt-1 text-xs text-slate-500">
                  {explained} line{explained === 1 ? '' : 's'} explained · {lines.length} lines in total · click a line to jump to it in the editor
                </p>
              )}

              {plan.warnings && plan.warnings.length > 0 && (
                <div className="mt-4 space-y-2" aria-label="Likely bugs">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-amber-300">⚠️ Spotted before running</h3>
                  {plan.warnings.map((w) => (
                    <button
                      key={`${w.line}-${w.text}`}
                      className="block w-full rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-100 hover:bg-amber-500/20"
                      onClick={() => onLine(w.line)}
                    >
                      {w.text}
                    </button>
                  ))}
                </div>
              )}

              {plan.ok && (
                <table className="mt-5 w-full border-separate border-spacing-0 text-sm" data-testid="explainer-table">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="w-12 border-b border-white/10 pb-2 pr-2 font-semibold">Line</th>
                      <th className="w-[45%] border-b border-white/10 pb-2 pr-4 font-semibold">Code</th>
                      <th className="border-b border-white/10 pb-2 font-semibold">{level === 'kid' ? 'What it means' : 'Explanation'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((code, i) => {
                      const line = i + 1;
                      const note = plan.line_notes[String(line)];
                      if (!code.trim() && !note) return null; // blank lines
                      const here = currentLine === line;
                      return (
                        <tr
                          key={line}
                          onClick={() => onLine(line)}
                          className={`cursor-pointer align-top transition-colors hover:bg-white/5 ${here ? 'bg-cyan-500/10' : ''} ${warned.has(line) ? 'bg-amber-500/5' : ''}`}
                        >
                          <td className={`border-b border-white/5 py-2 pr-2 font-mono text-xs ${here ? 'text-cyan-300' : 'text-slate-500'}`}>
                            {here ? '▶' : ''}
                            {line}
                          </td>
                          <td className="border-b border-white/5 py-2 pr-4">
                            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-sky-100">{code}</pre>
                          </td>
                          <td className={`border-b border-white/5 py-2 ${note ? 'text-slate-200' : 'text-slate-600'} ${big ? 'text-base' : ''}`}>
                            {warned.has(line) && <span className="mr-1">⚠️</span>}
                            {note ?? '…continues the line above'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
        <footer className="border-t border-white/10 bg-slate-950/40 px-6 py-2.5 text-xs text-slate-500">
          Explained from the code itself, without running it. Run the program to see the real values at every step.
        </footer>
      </section>
    </div>
  );
}
