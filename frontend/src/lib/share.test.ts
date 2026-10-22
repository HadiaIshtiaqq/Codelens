import { describe, expect, it } from 'vitest';
import { decodeSource, encodeSource } from './share';

describe('share links', () => {
  it('round-trips unicode source', () => {
    const src = 'print("héllo 🤖")\nx = [1, 2]\n';
    expect(decodeSource(encodeSource(src))).toBe(src);
    expect(encodeSource(src)).not.toMatch(/[+/=]/);
  });
  it('rejects garbage', () => {
    expect(decodeSource('%%%')).toBeNull();
  });
});

describe('compressed share links', () => {
  it('round-trips a project with files and input, and is shorter than plain base64', async () => {
    const { decodeProgram, encodeProgram, encodeSource } = await import('./share');
    const source = 'def average(xs):\n    return sum(xs) / len(xs)\n'.repeat(20);
    const program = { source, files: { 'utils.py': 'X = 1\n' }, stdin: 'Ada\n36\n' };
    const packed = await encodeProgram(program);
    expect(await decodeProgram(packed)).toEqual(program);
    expect(packed.length).toBeLessThan(encodeSource(source).length / 3);
    expect(await decodeProgram('not-valid')).toBeNull();
  });
});
