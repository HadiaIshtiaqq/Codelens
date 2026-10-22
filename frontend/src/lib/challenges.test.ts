import { describe, expect, it } from 'vitest';
import { CHALLENGES } from './challenges';
import { exportProgress, importProgress, loadStars, saveStars } from './progress';

const byId = (id: string) => CHALLENGES.find((c) => c.id === id)!;

describe('kids challenges', () => {
  it('passes correct solutions and explains wrong ones kindly', () => {
    const count = byId('count');
    expect(count.check('for n in range(1, 11):\n    print(n)\n', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', null).passed).toBe(true);
    const wrong = count.check('for n in range(1, 5):\n    print(n)\n', '1\n2\n3\n4\n', null);
    expect(wrong.passed).toBe(false);
    expect(wrong.message).toContain('needs 10 line(s), but only 4');
  });
  it('requires the idea the mission is about', () => {
    const cheers = byId('cheers');
    const cheat = cheers.check('print("Hooray!")\nprint("Hooray!")\nprint("Hooray!")\n', 'Hooray!\nHooray!\nHooray!\n', null);
    expect(cheat.passed).toBe(false);
    expect(cheers.check('for i in range(3):\n    print("Hooray!")\n', 'Hooray!\nHooray!\nHooray!\n', null).passed).toBe(true);
  });
  it('the bug challenge fails while the program crashes', () => {
    expect(byId('bug').check('', '', 'ZeroDivisionError').passed).toBe(false);
    expect(byId('bug').check('friends = 3', '4\n', null).passed).toBe(true);
  });
  it('every starter program is not already a solution', () => {
    for (const c of CHALLENGES) expect(c.check(c.starter, '', null).passed, c.id).toBe(false);
  });
});

describe('progress codes', () => {
  it('round-trips stars through a progress code', () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
    saveStars(new Set(['hello', 'count']));
    const code = exportProgress();
    store.clear();
    expect(importProgress(code)).toBe('Loaded 2 star(s) and 0 learned idea(s).');
    expect([...loadStars()].sort()).toEqual(['count', 'hello']);
    expect(() => importProgress('nope')).toThrow();
  });
});
