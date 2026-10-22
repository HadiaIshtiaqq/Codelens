import { describe, expect, it } from 'vitest';
import type { TraceEvent } from '../api/types';
import { callStackAt, changedVariables, failureStep, stdoutUpTo, testTemplate } from './trace';

const base = { execution_id: 'e', file: 'main.py', locals: {} as Record<string, string> };
// def f(a, b): return a / b ; f(1, 0)
const events: TraceEvent[] = [
  { ...base, step: 0, event: 'call', line: 1, function: '<module>', stack_depth: 1 },
  { ...base, step: 1, event: 'line', line: 3, function: '<module>', stack_depth: 1 },
  { ...base, step: 2, event: 'stdout', line: 3, function: '<module>', stack_depth: 1, stdout_chunk: 'hi\n' },
  { ...base, step: 3, event: 'call', line: 1, function: 'f', stack_depth: 2, locals: { a: '1', b: '0' } },
  { ...base, step: 4, event: 'line', line: 2, function: 'f', stack_depth: 2, locals: { a: '1', b: '0' } },
  {
    ...base,
    step: 5,
    event: 'exception',
    line: 2,
    function: 'f',
    stack_depth: 2,
    locals: { a: '1', b: '0' },
    exception: { type: 'ZeroDivisionError', message: 'division by zero', traceback_line: 2 },
  },
  { ...base, step: 6, event: 'return', line: 2, function: 'f', stack_depth: 2, return_value: 'None' },
  {
    ...base,
    step: 7,
    event: 'exception',
    line: 3,
    function: '<module>',
    stack_depth: 1,
    exception: { type: 'ZeroDivisionError', message: 'division by zero', traceback_line: 3 },
  },
  { ...base, step: 8, event: 'return', line: 3, function: '<module>', stack_depth: 1, return_value: 'None' },
  { ...base, step: 9, event: 'exit', line: 2, function: '<module>', stack_depth: 0, exit_code: 1 },
];

describe('trace helpers', () => {
  it('reconstructs the call stack, keeping a frame at its own return step', () => {
    expect(callStackAt(events, 4)).toEqual([
      { function: '<module>', line: 3 },
      { function: 'f', line: 2 },
    ]);
    expect(callStackAt(events, 6).map((f) => f.function)).toEqual(['<module>', 'f']);
    expect(callStackAt(events, 7)).toEqual([{ function: '<module>', line: 3 }]);
  });

  it('accumulates stdout up to a step', () => {
    expect(stdoutUpTo(events, 1)).toBe('');
    expect(stdoutUpTo(events, 9)).toBe('hi\n');
  });

  it('finds the innermost failure step', () => {
    expect(failureStep(events, { type: 'ZeroDivisionError', message: 'division by zero', line: 2 })).toBe(5);
    expect(failureStep(events, null)).toBeNull();
  });

  it('reports variables new in a frame as changed', () => {
    expect([...changedVariables(events, 3)].sort()).toEqual(['a', 'b']);
    expect(changedVariables(events, 4).size).toBe(0);
  });

  it('builds a test template importing top-level functions', () => {
    const t = testTemplate('def add(a, b=2):\n    return a + b\n\nclass X:\n    def m(self):\n        pass\n');
    expect(t).toContain('from main import add\n');
    expect(t).toContain('def test_add():');
    expect(t).toContain('add(..., ...)');
    expect(t).not.toContain('import m');
  });
});

describe('viz description for screen readers', () => {
  it('describes frames, values and aliasing', async () => {
    const { describeViz } = await import('./viz');
    const viz = {
      stack: [
        { id: 'f1', function: '<module>', line: 9, locals: [['scores', { r: 'o1' }], ['alias', { r: 'o1' }]] as [string, { r: string }][] },
        { id: 'f2', function: 'average', line: 4, locals: [['xs', { r: 'o1' }], ['total', { p: '90', t: 'int' }]] as [string, never][] },
      ],
      heap: { o1: { kind: 'list' as const, type: 'list', items: [{ p: '90', t: 'int' }, { p: '72', t: 'int' }] } },
      hidden_frames: 0,
    };
    const text = describeViz(viz as never);
    expect(text).toContain('<module> (line 9) then average (line 4)');
    expect(text).toContain('xs is list of 2: 90, 72, the same object as scores and alias');
    expect(text).toContain('total is 90');
  });
});
