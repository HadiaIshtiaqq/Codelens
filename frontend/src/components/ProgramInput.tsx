import { useState } from 'react';
import type { Debugger } from '../hooks/useDebugger';

/** Text that input() reads, one line per call (shown in the output like a terminal). */
export function ProgramInput({ dbg }: { dbg: Debugger }) {
  const usesInput = /\binput\s*\(/.test(dbg.source) || Object.values(dbg.files).some((f) => /\binput\s*\(/.test(f));
  const [open, setOpen] = useState(false);
  const show = open || !!dbg.stdin || usesInput;
  const lines = dbg.stdin ? dbg.stdin.replace(/\n$/, '').split('\n').length : 0;

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/70" aria-labelledby="stdin-title">
      <button
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 hover:bg-slate-800"
        onClick={() => setOpen(!show)}
        aria-expanded={show}
      >
        <span id="stdin-title">
          ⌨ Program input {lines ? `· ${lines} line${lines > 1 ? 's' : ''}` : ''}
          {usesInput && !dbg.stdin && <span className="ml-2 normal-case text-yellow-300">your code calls input(): type the answers here</span>}
        </span>
        <span>{show ? '▼' : '▲'}</span>
      </button>
      {show && (
        <textarea
          className="input h-20 w-full resize-y rounded-none rounded-b-lg border-0 border-t border-slate-800 font-mono text-xs"
          placeholder={'One line per input() call, e.g.\nAda\n36'}
          value={dbg.stdin}
          onChange={(e) => dbg.setStdin(e.target.value)}
          aria-label="Program input: one line per input() call"
          spellCheck={false}
        />
      )}
    </section>
  );
}
