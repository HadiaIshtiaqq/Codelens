import type { CodeExplanation } from '../api/types';

interface Props {
  plan: CodeExplanation | null;
  /** Line the program is on right now (highlighted in the plan). */
  currentLine?: number | null;
  onLine?: (line: number) => void;
  big?: boolean;
}

/** "What does this program do?": the whole program as a short plan, top to bottom. */
export function ProgramPlan({ plan, currentLine, onLine, big }: Props) {
  if (!plan) return <p className="text-sm text-slate-400">Reading the code…</p>;
  return (
    <div className={big ? 'space-y-2' : 'space-y-1.5'}>
      <p className={`${big ? 'text-lg' : 'text-sm'} ${plan.ok ? 'text-slate-200' : 'text-orange-200'}`}>{plan.intro}</p>
      {plan.warnings?.map((w) => (
        <button
          key={`${w.line}-${w.text}`}
          type="button"
          onClick={() => onLine?.(w.line)}
          className={`cl-pop block w-full rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-left text-amber-100 hover:bg-amber-500/20 ${big ? 'text-base' : 'text-sm'}`}
          data-testid="plan-warning"
        >
          {w.text}
        </button>
      ))}
      {plan.outline.length > 0 && (
        <ol className={`space-y-1 ${big ? 'text-base' : 'text-sm'}`}>
          {plan.outline.map((item, i) => {
            const here = currentLine === item.line;
            return (
              <li key={`${item.line}-${i}`} style={{ marginLeft: `${item.depth * (big ? 26 : 18)}px` }}>
                <button
                  type="button"
                  onClick={() => onLine?.(item.line)}
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1 text-left hover:bg-slate-800 ${here ? 'bg-sky-900/60 ring-1 ring-sky-400' : ''}`}
                  title={`Line ${item.line}`}
                >
                  <span className={`shrink-0 rounded font-mono font-bold ${big ? 'w-9 text-sm' : 'w-8 text-xs'} ${here ? 'text-sky-200' : 'text-slate-500'}`}>
                    {here ? '🤖' : `L${item.line}`}
                  </span>
                  <span className={here ? 'text-white' : 'text-slate-200'}>
                    {item.depth > 0 && <span className="text-slate-500">↳ </span>}
                    {item.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
