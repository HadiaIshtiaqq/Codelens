import type { ExecutionResponse, PatchStatus } from '../api/types';
import type { RunPhase } from '../hooks/useDebugger';

export function StatusBadge({
  phase,
  summary,
  progress,
}: {
  phase: RunPhase;
  summary: ExecutionResponse | null;
  progress: { received: number; total: number } | null;
}) {
  let text = 'IDLE';
  let cls = 'bg-slate-800 text-slate-300';
  if (phase === 'running') {
    text = progress ? `RUNNING ${progress.received}/${progress.total}` : 'RUNNING…';
    cls = 'bg-blue-900 text-blue-100 animate-pulse';
  } else if (phase === 'error') {
    text = 'REQUEST FAILED';
    cls = 'bg-red-900 text-red-100';
  } else if (summary) {
    if (summary.status === 'timed_out') {
      text = '⏱ TIMED OUT';
      cls = 'bg-orange-900 text-orange-100';
    } else if (summary.status === 'failed') {
      text = '✖ SANDBOX ERROR';
      cls = 'bg-red-900 text-red-100';
    } else if (summary.error) {
      text = `✖ ${summary.error.type}`;
      cls = 'bg-orange-900 text-orange-100';
    } else {
      text = `✔ EXIT ${summary.exit_code}`;
      cls = 'bg-emerald-900 text-emerald-100';
    }
    if (phase === 'steppable') text = `STEPPING · ${text}`;
  }
  return (
    <span role="status" aria-live="polite" className={`rounded px-2 py-1 font-mono text-xs font-semibold ${cls}`}>
      Status: {text}
    </span>
  );
}

const PATCH_STYLES: Record<PatchStatus, string> = {
  proposed: 'bg-slate-700 text-slate-100',
  validated: 'bg-emerald-800 text-emerald-100',
  failed: 'bg-orange-800 text-orange-100',
  untested: 'bg-yellow-800 text-yellow-100',
};
const PATCH_GLYPH: Record<PatchStatus, string> = { proposed: '◌', validated: '✔', failed: '✖', untested: '?' };

export function PatchBadge({ status }: { status: PatchStatus }) {
  return (
    <span className={`rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase ${PATCH_STYLES[status]}`}>
      {PATCH_GLYPH[status]} {status}
    </span>
  );
}
