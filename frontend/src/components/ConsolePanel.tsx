import { useEffect, useRef, useState } from 'react';
import type { ExecutionResponse } from '../api/types';

interface Props {
  summary: ExecutionResponse | null;
  stdoutToStep: string;
  runError: string | null;
  /** Delete this run (code, trace, explanations, patches) from the server. */
  onDelete?: (() => void) | null;
}

type Tab = 'step' | 'stdout' | 'stderr';

/** Console & output panel (spec §4.1). */
export function ConsolePanel({ summary, stdoutToStep, runError, onDelete }: Props) {
  const [tab, setTab] = useState<Tab>('step');
  const [scrollLock, setScrollLock] = useState(false);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // Each new run opens on stderr only when it failed without printing anything.
  useEffect(() => {
    if (summary) setTab(summary.error && !summary.stdout ? 'stderr' : 'step');
  }, [summary?.execution_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const text = runError
    ? runError
    : !summary
      ? ''
      : tab === 'step'
        ? stdoutToStep
        : tab === 'stdout'
          ? summary.stdout
          : summary.stderr;

  useEffect(() => {
    if (!scrollLock && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [text, scrollLock]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const tabs: [Tab, string][] = [
    ['step', 'Output to step'],
    ['stdout', 'Full stdout'],
    ['stderr', summary?.stderr ? 'stderr ●' : 'stderr'],
  ];

  return (
    <section className="panel" aria-labelledby="console-title">
      <div className="panel-title py-1">
        <h2 id="console-title" className="sr-only">
          Console
        </h2>
        <div role="tablist" aria-label="Console output" className="flex gap-1 normal-case tracking-normal">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab py-1 text-xs" onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 font-normal normal-case tracking-normal">
          <label className="flex items-center gap-1 text-[11px]">
            <input type="checkbox" checked={scrollLock} onChange={(e) => setScrollLock(e.target.checked)} />
            scroll lock
          </label>
          <button className="btn px-2 py-0.5 text-xs" onClick={copy} disabled={!text}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre
        ref={preRef}
        role="log"
        aria-live="off"
        className={`min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs ${
          runError || tab === 'stderr' ? 'text-orange-200' : 'text-slate-200'
        }`}
      >
        {text || <span className="text-slate-500">{summary ? '(no output)' : 'Program output appears here.'}</span>}
      </pre>
      {summary && (
        <div className="flex flex-wrap gap-3 border-t border-slate-800 px-3 py-1 font-mono text-[11px] text-slate-400">
          <span>exit code: {summary.exit_code ?? '—'}</span>
          <span>{summary.duration_ms} ms</span>
          <span>{summary.total_steps} steps</span>
          {summary.trace_truncated && (
            <span className="text-yellow-300" title="Long runs keep the first 300 and the most recent 700 steps">
              ⚠ long run: {summary.omitted_steps ? `${summary.omitted_steps.toLocaleString()} middle steps skipped` : 'trace shortened'}
              {summary.recording_stopped ? ', line recording paused near the end' : ''}
            </span>
          )}
          {summary.output_truncated && <span className="text-yellow-300">⚠ output capped at 4 MiB</span>}
          {onDelete && (
            <button className="ml-auto text-slate-500 hover:text-red-300" onClick={onDelete} title="Delete this run's code and trace from the server">
              🗑 delete run
            </button>
          )}
        </div>
      )}
    </section>
  );
}
