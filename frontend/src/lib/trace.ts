import type { ErrorInfo, TraceEvent } from '../api/types';

export interface StackFrame {
  function: string;
  line: number;
}

/** Call stack at `step`, reconstructed by replaying call/return events (matches backend evidence.call_stack_at). */
export function callStackAt(events: TraceEvent[], step: number): StackFrame[] {
  // Prefer the step's own snapshot: exact even after skipped steps in long runs.
  for (let i = Math.min(step, events.length - 1); i >= 0; i--) {
    const viz = events[i].viz;
    if (viz) return viz.stack.map((f) => ({ function: f.function, line: f.line }));
    if (events[i].event !== 'stdout' && events[i].event !== 'exit') break;
  }
  const stack: StackFrame[] = [];
  for (let i = 0; i <= step && i < events.length; i++) {
    const ev = events[i];
    if (ev.event === 'call') {
      stack.push({ function: ev.function, line: ev.line });
    } else if (ev.event === 'return' && i < step) {
      stack.pop(); // a frame is still on the stack at its own return step
      continue;
    }
    if (stack.length && ev.event !== 'exit') stack[stack.length - 1] = { ...stack[stack.length - 1], line: ev.line };
  }
  return stack;
}

/** Program output produced up to and including `step`. */
export function stdoutUpTo(events: TraceEvent[], step: number): string {
  let out = '';
  for (let i = 0; i <= step && i < events.length; i++) {
    const ev = events[i];
    if (ev.event === 'stdout') out += ev.stdout_chunk;
  }
  return out;
}

/** Step of the exception event where the error originated (innermost frame). */
export function failureStep(events: TraceEvent[], error: ErrorInfo | null): number | null {
  if (!error) return null;
  const candidates = events.filter((e) => e.event === 'exception' && e.exception.type === error.type);
  if (!candidates.length) return null;
  return (candidates.find((e) => e.line === error.line) ?? candidates[0]).step;
}

/** Variables whose rendered value changed relative to the previous event in the same frame. */
export function changedVariables(events: TraceEvent[], step: number): Set<string> {
  const changed = new Set<string>();
  const cur = events[step];
  if (!cur) return changed;
  for (let i = step - 1; i >= 0; i--) {
    const prev = events[i];
    if (prev.stack_depth === cur.stack_depth && prev.function === cur.function && prev.event !== 'stdout') {
      for (const [k, v] of Object.entries(cur.locals)) if (prev.locals[k] !== v) changed.add(k);
      return changed;
    }
    if (prev.event === 'call' && prev.stack_depth === cur.stack_depth) break;
  }
  return new Set(Object.keys(cur.locals));
}

export function eventLabel(ev: TraceEvent): string {
  switch (ev.event) {
    case 'call':
      return `call ${ev.function}()`;
    case 'line':
      return `line ${ev.line}`;
    case 'return':
      return `return ${ev.return_value}`;
    case 'exception':
      return `${ev.exception.type}: ${ev.exception.message}`;
    case 'stdout':
      return `print ${JSON.stringify(ev.stdout_chunk.length > 40 ? ev.stdout_chunk.slice(0, 40) + '…' : ev.stdout_chunk)}`;
    case 'exit':
      return `exit ${ev.exit_code}`;
  }
}

/** Starter test module for patch validation, built from the top-level functions in `source`. */
export function testTemplate(source: string): string {
  const fns = [...source.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)].map((m) => ({
    name: m[1],
    params: m[2]
      .split(',')
      .map((p) => p.trim().split(/[=:]/)[0].trim())
      .filter((p) => p && !p.startsWith('*') && p !== 'self'),
  }));
  if (!fns.length) {
    return '# Tests run after main.py is imported as the module `main`.\n# Write test_* functions using assert.\n\ndef test_program_imports():\n    import main  # noqa: F401\n';
  }
  const imports = `from main import ${fns.map((f) => f.name).join(', ')}\n`;
  const bodies = fns
    .map(
      (f) =>
        `\ndef test_${f.name}():\n    # TODO: replace with real expectations\n    result = ${f.name}(${f.params.map(() => '...').join(', ')})\n    assert result is not None\n`,
    )
    .join('');
  return `# Tests run in a fresh sandbox against the PATCHED program.\n# Each test_* function passes if it does not raise.\n${imports}${bodies}`;
}
