import { useCallback, useEffect, useRef, useState } from 'react';
import type { TraceEvent } from '../api/types';
import { play, type Sfx } from '../lib/sound';
import type { Debugger } from './useDebugger';

export interface Achievement {
  id: string;
  icon: string;
  title: string;
  description: string;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-run', icon: '🚀', title: 'Lift-off', description: 'Run your first program' },
  { id: 'explorer', icon: '👣', title: 'Explorer', description: 'Take 25 steps through a trace' },
  { id: 'bug-hunter', icon: '🐞', title: 'Bug Hunter', description: 'Reach the exact step where a program crashes' },
  { id: 'deep-diver', icon: '🤿', title: 'Deep Diver', description: 'Reach a call stack 4 frames deep' },
  { id: 'loop-master', icon: '🔁', title: 'Loop Master', description: 'Watch the same line run 10 times' },
  { id: 'clean-run', icon: '🏁', title: 'Clean Run', description: 'Finish a program with exit code 0' },
  { id: 'oracle', icon: '🔮', title: 'Oracle', description: 'Predict 5 lines in a row correctly' },
  { id: 'squasher', icon: '🔨', title: 'Bug Squasher', description: 'Validate a fix with passing tests' },
  { id: 'alias-spotter', icon: '🔗', title: 'Alias Spotter', description: 'See two variables pointing at the same object' },
];

const XP_PER_LEVEL = 100;
const STORAGE_KEY = 'codelens.game.v1';

interface Saved {
  xp: number;
  bestStreak: number;
  unlocked: string[];
  sound: boolean;
}

function load(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { xp: 0, bestStreak: 0, unlocked: [], sound: false, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { xp: 0, bestStreak: 0, unlocked: [], sound: false };
}

export interface Toast {
  id: number;
  icon: string;
  text: string;
  tone: 'good' | 'bad' | 'info';
}

/** Next line the program will execute after `step` (skips print events, which stay on the same line). */
export function nextLine(events: TraceEvent[], step: number): { line: number; file: string } | null {
  for (let i = step + 1; i < events.length; i++) {
    const ev = events[i];
    if (ev.event === 'stdout' || ev.event === 'exit') continue;
    return { line: ev.line, file: ev.file ?? 'main.py' };
  }
  return null;
}

export function useGame(dbg: Debugger) {
  const [saved, setSaved] = useState<Saved>(load);
  const [streak, setStreak] = useState(0);
  const [predictMode, setPredictMode] = useState(false);
  const [awaitingGuess, setAwaitingGuess] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stepsTaken = useRef(0);
  const lineHits = useRef(new Map<number, number>());
  const lastRunId = useRef<string | null>(null);
  const toastId = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      /* ignore */
    }
  }, [saved]);

  const sfx = useCallback((s: Sfx) => saved.sound && play(s), [saved.sound]);

  const toast = useCallback((icon: string, text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, icon, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const addXp = useCallback((n: number) => setSaved((s) => ({ ...s, xp: s.xp + n })), []);

  // Synchronous view of unlocked achievements, so several unlocks in one pass don't double-award.
  const unlockedRef = useRef(new Set(saved.unlocked));
  const unlock = useCallback(
    (id: string) => {
      if (unlockedRef.current.has(id)) return;
      unlockedRef.current.add(id);
      const a = ACHIEVEMENTS.find((x) => x.id === id)!;
      setSaved((s) => (s.unlocked.includes(id) ? s : { ...s, xp: s.xp + 50, unlocked: [...s.unlocked, id] }));
      toast(a.icon, `Achievement: ${a.title} (+50 XP)`, 'good');
      sfx('achievement');
    },
    [toast, sfx],
  );

  // React to step changes: sound effects + achievements.
  const { run, step } = dbg;
  useEffect(() => {
    if (!run) return;
    const runId = run.summary.execution_id;
    if (lastRunId.current !== runId) {
      lastRunId.current = runId;
      lineHits.current = new Map();
      unlock('first-run');
      return;
    }
    const ev = run.events[step];
    if (!ev) return;
    stepsTaken.current += 1;
    if (stepsTaken.current >= 25) unlock('explorer');
    lineHits.current.set(ev.line, (lineHits.current.get(ev.line) ?? 0) + 1);
    if (ev.event === 'line' && (lineHits.current.get(ev.line) ?? 0) >= 10) unlock('loop-master');
    if (ev.stack_depth >= 4) unlock('deep-diver');
    if (ev.viz) {
      const seen = new Set<string>();
      for (const f of ev.viz.stack)
        for (const [, v] of f.locals)
          if ('r' in v) {
            const kind = ev.viz.heap[v.r]?.kind;
            if (kind && kind !== 'function' && kind !== 'class') {
              if (seen.has(v.r)) unlock('alias-spotter');
              seen.add(v.r);
            }
          }
    }
    switch (ev.event) {
      case 'exception':
        sfx('crash');
        if (run.summary.error && ev.line === run.summary.error.line) unlock('bug-hunter');
        break;
      case 'call':
        sfx('call');
        break;
      case 'return':
        sfx('return');
        break;
      case 'stdout':
        sfx('print');
        break;
      case 'exit':
        if (ev.exit_code === 0 && run.summary.status === 'completed') {
          sfx('win');
          unlock('clean-run');
          addXp(20);
        }
        break;
      default:
        sfx('step');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, step]);

  useEffect(() => {
    if (dbg.validation?.status === 'validated') {
      unlock('squasher');
      addXp(100);
      toast('🔨', 'Bug squashed! Fix validated (+100 XP)', 'good');
      sfx('win');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbg.validation]);

  /** Predict mode: Step Next asks for a guess instead of advancing. */
  const requestNext = useCallback(() => {
    if (!run) return;
    if (!predictMode || nextLine(run.events, step) === null) {
      setAwaitingGuess(false);
      dbg.next();
      return;
    }
    setAwaitingGuess(true);
  }, [predictMode, run, step, dbg]);

  const guess = useCallback(
    (line: number) => {
      if (!run || !awaitingGuess) return;
      const answer = nextLine(run.events, step);
      setAwaitingGuess(false);
      if (answer === null) return;
      const where = answer.file === 'main.py' ? `line ${answer.line}` : `line ${answer.line} of ${answer.file}`;
      if (line === answer.line && dbg.activeFile === answer.file) {
        const nextStreak = streak + 1;
        const gained = 10 * Math.min(nextStreak, 5);
        setStreak(nextStreak);
        setSaved((s) => ({ ...s, xp: s.xp + gained, bestStreak: Math.max(s.bestStreak, nextStreak) }));
        toast('✅', `Correct! ${where}  +${gained} XP  (streak ×${Math.min(nextStreak, 5)})`, 'good');
        sfx('correct');
        if (nextStreak >= 5) unlock('oracle');
      } else {
        setStreak(0);
        toast('❌', `Not quite: the robot went to ${where}`, 'bad');
        sfx('wrong');
      }
      // Advance to the event that runs the answered line.
      let target = step + 1;
      while (target < run.events.length - 1 && ['stdout', 'exit'].includes(run.events[target].event)) target++;
      dbg.goTo(target);
    },
    [run, awaitingGuess, step, streak, toast, sfx, unlock, dbg],
  );

  const level = Math.floor(saved.xp / XP_PER_LEVEL) + 1;
  return {
    xp: saved.xp,
    level,
    levelProgress: (saved.xp % XP_PER_LEVEL) / XP_PER_LEVEL,
    streak,
    bestStreak: saved.bestStreak,
    unlocked: saved.unlocked,
    sound: saved.sound,
    toggleSound: () => setSaved((s) => ({ ...s, sound: !s.sound })),
    predictMode,
    setPredictMode: (on: boolean) => {
      setPredictMode(on);
      setAwaitingGuess(false);
    },
    awaitingGuess,
    cancelGuess: () => setAwaitingGuess(false),
    requestNext,
    guess,
    toasts,
    toast,
    resetProgress: () => {
      unlockedRef.current = new Set();
      setSaved((s) => ({ ...s, xp: 0, bestStreak: 0, unlocked: [] }));
      setStreak(0);
    },
  };
}

export type Game = ReturnType<typeof useGame>;
