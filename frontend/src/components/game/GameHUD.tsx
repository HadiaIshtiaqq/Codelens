import { useEffect, useRef, useState } from 'react';
import type { Debugger } from '../../hooks/useDebugger';
import { ACHIEVEMENTS, type Game } from '../../hooks/useGame';
import { speak, speechSupported, stopSpeaking } from '../../lib/speech';

const READ_ALOUD_KEY = 'codelens.game.read-aloud';

function loadReadAloud(): boolean {
  try {
    return localStorage.getItem(READ_ALOUD_KEY) === 'on';
  } catch {
    return false;
  }
}

const SPEEDS: [string, number][] = [
  ['🐢 0.5×', 1100],
  ['1×', 600],
  ['2×', 300],
  ['⚡ 4×', 120],
];

/** Level/XP, streak, autoplay controls, predict mode, sound and achievements. */
export function GameHUD({ dbg, game }: { dbg: Debugger; game: Game }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(600);
  const [pauseOnCrash, setPauseOnCrash] = useState(true);
  const [showTrophies, setShowTrophies] = useState(false);
  const [readAloud, setReadAloud] = useState(loadReadAloud);
  const { run, step, total } = dbg;
  const startedAt = useRef(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speaking = readAloud && speechSupported;

  // Autoplay: advance one step per tick; stop at the end or (optionally) on a crash.
  useEffect(() => {
    if (!playing || !run) return;
    if (step >= total - 1) {
      setPlaying(false);
      return;
    }
    if (step !== startedAt.current && dbg.hitsBreakpoint(step)) {
      setPlaying(false); // autoplay stops at breakpoints
      return;
    }
    if (pauseOnCrash && run.events[step]?.event === 'exception' && step !== startedAt.current) {
      setPlaying(false);
      return;
    }
    if (speaking) return; // with read-aloud on, the next step starts when the sentence has been spoken
    const id = setTimeout(() => dbg.goTo(step + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, total, run, speed, pauseOnCrash, dbg, speaking]);

  // Read each step's explanation aloud (not during a Predict-mode guess: it would give the answer away).
  useEffect(() => {
    try {
      localStorage.setItem(READ_ALOUD_KEY, readAloud ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (!speaking || !run || dbg.stale) {
      stopSpeaking();
      return;
    }
    const ev = run.events[step];
    if (!ev || game.awaitingGuess) {
      stopSpeaking();
      return;
    }
    let pending: number | undefined;
    speak(ev.narration ?? '', () => {
      if (playingRef.current && step < total - 1) pending = window.setTimeout(() => dbg.goTo(step + 1), 250);
    });
    return () => window.clearTimeout(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, run, speaking, game.awaitingGuess, playing]);

  useEffect(() => () => stopSpeaking(), []);

  useEffect(() => setPlaying(false), [run]);

  const canPlay = !!run && !dbg.stale && total > 1 && !game.predictMode;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 px-3 py-2">
      {/* Playback */}
      <div className="flex items-center gap-1.5">
        <button
          className={`btn ${playing ? 'btn-warn' : 'btn-primary'} min-w-[96px] justify-center`}
          disabled={!canPlay}
          onClick={() => {
            if (!playing) {
              const from = step >= total - 1 ? 0 : step;
              startedAt.current = from;
              if (from !== step) dbg.goTo(from);
            }
            setPlaying(!playing);
          }}
          aria-pressed={playing}
          title={game.predictMode ? 'Autoplay is off in Predict mode' : 'Watch the program play out'}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <select className="input py-1 text-xs" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
          {SPEEDS.map(([label, ms]) => (
            <option key={ms} value={ms}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-[11px] text-slate-400">
          <input type="checkbox" checked={pauseOnCrash} onChange={(e) => setPauseOnCrash(e.target.checked)} />
          pause on 💥
        </label>
      </div>

      <div className="h-6 w-px bg-slate-700" aria-hidden />

      {/* Predict mode */}
      <button
        className={`btn ${game.predictMode ? 'border-fuchsia-400 bg-fuchsia-700 hover:bg-fuchsia-600' : ''}`}
        aria-pressed={game.predictMode}
        onClick={() => {
          setPlaying(false);
          game.setPredictMode(!game.predictMode);
        }}
        title="Guess which line runs next before each step to earn XP"
      >
        🎯 Predict mode {game.predictMode ? 'ON' : 'OFF'}
      </button>
      {game.streak > 0 && (
        <span className="cl-pop rounded-full bg-orange-600/80 px-2 py-0.5 text-xs font-bold" key={game.streak}>
          🔥 {game.streak} streak
        </span>
      )}

      {/* Level & XP */}
      <div className="ml-auto flex items-center gap-2" aria-label={`Level ${game.level}, ${game.xp} XP`}>
        <span className="rounded-md bg-yellow-500 px-2 py-0.5 text-xs font-black text-slate-900">LV {game.level}</span>
        <div className="h-2.5 w-28 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={Math.round(game.levelProgress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-gradient-to-r from-yellow-400 to-orange-500 transition-all duration-500" style={{ width: `${game.levelProgress * 100}%` }} />
        </div>
        <span className="font-mono text-xs text-yellow-200">{game.xp} XP</span>
      </div>

      <div className="relative">
        <button className="btn px-2" onClick={() => setShowTrophies(!showTrophies)} aria-expanded={showTrophies} title="Achievements">
          🏆 {game.unlocked.length}/{ACHIEVEMENTS.length}
        </button>
        {showTrophies && (
          <div className="absolute right-0 z-40 mt-1 w-72 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
            <h3 className="mb-2 text-sm font-bold">Achievements</h3>
            <ul className="space-y-1.5">
              {ACHIEVEMENTS.map((a) => {
                const got = game.unlocked.includes(a.id);
                return (
                  <li key={a.id} className={`flex items-center gap-2 text-xs ${got ? '' : 'opacity-40 grayscale'}`}>
                    <span className="text-lg">{got ? a.icon : '🔒'}</span>
                    <span>
                      <strong className="text-slate-100">{a.title}</strong>
                      <span className="block text-slate-400">{a.description}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[11px] text-slate-500">Best streak: {game.bestStreak}</p>
            <button className="mt-2 text-[11px] text-slate-500 underline" onClick={game.resetProgress}>
              Reset progress
            </button>
          </div>
        )}
      </div>
      {speechSupported && (
        <button
          className={`btn px-2 ${readAloud ? 'border-sky-400 bg-sky-800' : ''}`}
          onClick={() => setReadAloud(!readAloud)}
          aria-pressed={readAloud}
          title={readAloud ? 'Reading each step aloud (click to stop)' : 'Read each step aloud'}
        >
          🗣 {readAloud ? 'Reading aloud' : 'Read aloud'}
        </button>
      )}
      <button className="btn px-2" onClick={game.toggleSound} aria-pressed={game.sound} title={game.sound ? 'Sound effects on' : 'Sound effects off'}>
        {game.sound ? '🔊' : '🔇'}
      </button>
    </div>
  );
}

export function Toasts({ game }: { game: Game }) {
  return (
    <div className="pointer-events-none fixed bottom-14 right-4 z-50 flex flex-col gap-2" aria-live="polite">
      {game.toasts.map((t) => (
        <div
          key={t.id}
          className={`cl-toast rounded-xl border px-3 py-2 text-sm font-semibold shadow-xl ${
            t.tone === 'good'
              ? 'border-emerald-500 bg-emerald-950 text-emerald-100'
              : t.tone === 'bad'
                ? 'border-orange-500 bg-orange-950 text-orange-100'
                : 'border-slate-600 bg-slate-900 text-slate-100'
          }`}
        >
          {t.icon} {t.text}
        </div>
      ))}
    </div>
  );
}
