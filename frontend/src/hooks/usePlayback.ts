import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Debugger } from './useDebugger';

// One player for all three views: Run plays the program, and switching views keeps playing from
// the same step. Views can hold the player on a step (while a sentence is read aloud, or while a
// new-idea card is up) and set their own tempo.

export type Pace = 'slow' | 'normal' | 'fast' | 'manual';

const PACE_KEY = 'codelens.kids.pace'; // shared by every view (the name predates the shared player)
const PACE_MS: Record<Exclude<Pace, 'manual'>, number> = { slow: 2000, normal: 1000, fast: 200 };
const AFTER_SPEECH_MS = 450;

function loadPace(): Pace {
  try {
    const saved = localStorage.getItem(PACE_KEY);
    return saved === 'slow' || saved === 'fast' || saved === 'manual' ? saved : 'normal';
  } catch {
    return 'normal';
  }
}

export interface Playback {
  playing: boolean;
  pace: Pace;
  setPace: (pace: Pace) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Run the program, then play it from the start (or stay put with "step by step"). */
  runAndPlay: (source?: string) => Promise<void>;
  /** Keep the player on this step while `on` (e.g. "speech" while reading aloud). */
  hold: (key: string, on: boolean) => void;
}

export function usePlayback(dbg: Debugger, opts: { tempo?: number; blocked?: boolean } = {}): Playback {
  const { tempo = 1, blocked = false } = opts;
  const [playing, setPlaying] = useState(false);
  const [pace, setPaceState] = useState<Pace>(loadPace);
  const [holds, setHolds] = useState<Set<string>>(() => new Set());
  const startedAt = useRef(0);
  const heldOn = useRef(-1); // the last step something held on (speech): move on quickly after it
  const stepRef = useRef(dbg.step);
  stepRef.current = dbg.step;
  const { run, step, total, stale } = dbg;

  const setPace = useCallback((next: Pace) => {
    setPaceState(next);
    try {
      localStorage.setItem(PACE_KEY, next);
    } catch {
      /* ignore */
    }
    if (next === 'manual') setPlaying(false);
  }, []);

  const hold = useCallback((key: string, on: boolean) => {
    if (on) heldOn.current = stepRef.current;
    setHolds((prev) => {
      if (prev.has(key) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const play = useCallback(() => {
    if (!run || stale) return;
    const from = step >= total - 1 ? 0 : step; // at the end: watch again from the top
    startedAt.current = from;
    if (from !== step) dbg.goTo(from);
    if (pace === 'manual') setPaceState('normal');
    setPlaying(true);
  }, [run, stale, step, total, dbg, pace]);

  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause]);

  const runAndPlay = useCallback(
    async (source?: string) => {
      setPlaying(false);
      await dbg.execute(source);
      if (pace === 'manual') return; // step by step: stay where the run landed (the crash, if any)
      startedAt.current = 0;
      dbg.goTo(0);
      setPlaying(true);
    },
    [dbg, pace],
  );

  // Editing the code (stale run) or losing the run stops the player.
  useEffect(() => {
    if (!run || stale) setPlaying(false);
  }, [run, stale]);

  useEffect(() => {
    if (!playing || !run || stale || blocked || holds.size > 0) return;
    if (step >= total - 1) {
      setPlaying(false);
      return;
    }
    if (step !== startedAt.current) {
      // Stop where something deserves a look: a breakpoint or the crash.
      if (dbg.hitsBreakpoint(step) || run.events[step]?.event === 'exception') {
        setPlaying(false);
        return;
      }
    }
    const base = pace === 'manual' ? PACE_MS.normal : PACE_MS[pace];
    const delay = heldOn.current === step ? AFTER_SPEECH_MS : base * tempo;
    const id = window.setTimeout(() => dbg.goTo(step + 1), delay);
    return () => window.clearTimeout(id);
  }, [playing, run, stale, blocked, holds, step, total, pace, tempo, dbg]);

  return useMemo(
    () => ({ playing, pace, setPace, play, pause, toggle, runAndPlay, hold }),
    [playing, pace, setPace, play, pause, toggle, runAndPlay, hold],
  );
}
