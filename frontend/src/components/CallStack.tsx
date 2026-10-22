import type { StackFrame } from '../lib/trace';

export function CallStack({ frames, onSelectLine }: { frames: StackFrame[]; onSelectLine: (line: number) => void }) {
  const ordered = [...frames].reverse(); // innermost first
  return (
    <section className="panel" aria-labelledby="stack-title">
      <div className="panel-title">
        <h2 id="stack-title">Call stack</h2>
        <span className="font-normal normal-case text-slate-500">depth {frames.length}</span>
      </div>
      <ol className="min-h-0 flex-1 overflow-auto py-1 font-mono text-xs">
        {ordered.length === 0 && <li className="px-3 py-1 font-sans text-sm text-slate-500">—</li>}
        {ordered.map((f, i) => (
          <li key={`${i}-${f.function}`}>
            <button
              type="button"
              onClick={() => onSelectLine(f.line)}
              className={`flex w-full items-center justify-between px-3 py-0.5 text-left hover:bg-slate-800 ${i === 0 ? 'text-blue-300' : 'text-slate-300'}`}
            >
              <span>
                {i === 0 ? '▶ ' : '  '}
                {f.function}
              </span>
              <span className="text-slate-500">main.py:{f.line}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
