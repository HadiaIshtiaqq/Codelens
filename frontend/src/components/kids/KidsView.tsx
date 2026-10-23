import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Debugger } from '../../hooks/useDebugger';
import { CONCEPTS } from '../../lib/concepts';
import { KID_EXAMPLES } from '../../lib/kidExamples';
import { CHALLENGES, type Challenge, type ChallengeResult } from '../../lib/challenges';
import { exportProgress, importProgress, loadLearned, loadStars, saveLearned, saveStars } from '../../lib/progress';
import { chooseVoice, chosenVoiceName, englishVoices, onVoicesChanged, speak, speechSupported, stopSpeaking } from '../../lib/speech';
import { changedVariables, stdoutUpTo } from '../../lib/trace';
import { hasDrawing } from '../../lib/turtle';
import { vizAt } from '../../lib/viz';
import { useCodeExplanation } from '../../hooks/useCodeExplanation';
import { CodeEditor } from '../CodeEditor';
import { ProgramPlan } from '../ProgramPlan';
import { TurtleStage } from '../TurtleStage';
import { KidBoard } from './KidBoard';

// Blockly is large: load it only when a child switches to blocks.
const KidsBlocks = lazy(() => import('./KidsBlocks').then((m) => ({ default: m.KidsBlocks })));

// A new key: the old one was saved as "on" without anyone choosing it. Robo only talks once the speaker is switched on.
const READ_ALOUD_KEY = 'codelens.kids.speaker';
const PACE_KEY = 'codelens.kids.pace';

/** How Robo moves through the steps: on its own at some speed, or only when the child presses Next. */
type Pace = 'slow' | 'normal' | 'fast' | 'manual';
// Milliseconds to wait on each step: [when not reading aloud, after the sentence has been read aloud].
const PACE_DELAY: Record<Exclude<Pace, 'manual'>, [number, number]> = { slow: [4000, 1500], normal: [2500, 600], fast: [1100, 150] };

function loadPace(): Pace {
  try {
    const saved = localStorage.getItem(PACE_KEY);
    return saved === 'slow' || saved === 'fast' || saved === 'manual' ? saved : 'normal';
  } catch {
    return 'normal';
  }
}

function loadReadAloud(): boolean {
  try {
    return localStorage.getItem(READ_ALOUD_KEY) === 'on';
  } catch {
    return false;
  }
}

/** A calm, big-text view for young beginners: one plain-English sentence per step. */
export function KidsView({ dbg }: { dbg: Debugger }) {
  const { run, step, stale, total, phase } = dbg;
  const [readAloud, setReadAloud] = useState(loadReadAloud);
  const [pace, setPace] = useState(loadPace);
  const [playing, setPlaying] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [explainAll, setExplainAll] = useState(false);
  const [blocks, setBlocks] = useState(false);
  const [learned, setLearned] = useState(loadLearned);
  const [stars, setStars] = useState(loadStars);
  const [mission, setMission] = useState<Challenge | null>(null);
  const [missionResult, setMissionResult] = useState<ChallengeResult | null>(null);
  const [showChallenges, setShowChallenges] = useState(false);
  const [progressNote, setProgressNote] = useState<string | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voice, setVoice] = useState(chosenVoiceName);
  const [fixAsked, setFixAsked] = useState(false);
  const plan = useCodeExplanation(dbg.source, 'kid');

  useEffect(() => onVoicesChanged(() => setVoices(englishVoices())), []);
  const timer = useRef<number | null>(null);

  const events = run?.events ?? [];
  const event = !stale && run ? events[step] ?? null : null;
  // The robot's sentence describes what a line *does* ("Make a box called apples… now it holds 3"),
  // so the board shows the result: the next step in the same frame, if the line didn't jump into a trick.
  const boardStep = useMemo(() => {
    if (!event || event.event !== 'line') return step;
    for (let j = step + 1; j < events.length; j++) {
      const e = events[j];
      if (e.event === 'stdout') continue;
      return e.stack_depth === event.stack_depth && e.function === event.function ? j : step;
    }
    return step;
  }, [event, events, step]);
  const viz = useMemo(() => (run && !stale ? vizAt(events, boardStep) : null), [run, events, boardStep, stale]);
  const changed = useMemo(() => (run ? changedVariables(events, boardStep) : new Set<string>()), [run, events, boardStep]);
  const screen = useMemo(() => (run ? stdoutUpTo(events, step) : ''), [run, events, step]);
  const draws = useMemo(() => hasDrawing(events), [events]);
  const sentence = event?.kid_narration ?? event?.narration ?? '';
  const kidFile = event?.file && event.file !== 'main.py' && event.file in dbg.files ? event.file : 'main.py';
  const crashed = event?.event === 'exception';
  const finished = !!run && !stale && step === total - 1;
  const success = finished && run?.summary.exit_code === 0 && !run.summary.error;

  // A "new idea" card the first time each idea shows up in this run.
  const firstStepOf = useMemo(() => {
    const first = new Map<string, number>();
    events.forEach((e) => {
      if (e.concept && !first.has(e.concept)) first.set(e.concept, e.step);
    });
    return first;
  }, [events]);
  const concept =
    event?.concept && firstStepOf.get(event.concept) === step && !dismissed.has(event.concept) && !learned.has(event.concept)
      ? CONCEPTS[event.concept]
      : null;

  useEffect(() => {
    setDismissed(new Set());
    setFixAsked(false);
  }, [run]);

  const learnIdea = (id: string) => {
    const next = new Set([...learned, id]);
    setLearned(next);
    saveLearned(next);
    setDismissed((prev) => new Set([...prev, id]));
  };

  // Check the mission each time the program has been run.
  useEffect(() => {
    if (!mission || !run || stale) {
      setMissionResult(null);
      return;
    }
    const s = run.summary;
    const error = s.error ? s.error.type : s.status !== 'completed' ? s.status : null;
    const result = mission.check(run.source, s.stdout, error);
    setMissionResult(result);
    if (result.passed && !stars.has(mission.id)) {
      const next = new Set([...stars, mission.id]);
      setStars(next);
      saveStars(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, mission]);

  const startMission = (c: Challenge) => {
    setMission(c);
    setMissionResult(null);
    setShowChallenges(false);
    setBlocks(false);
    stopSpeaking();
    dbg.loadProject(c.starter);
  };

  useEffect(() => {
    try {
      localStorage.setItem(PACE_KEY, pace);
    } catch {
      /* ignore */
    }
    if (pace === 'manual') setPlaying(false);
  }, [pace]);

  const toggleReadAloud = (on: boolean) => {
    setReadAloud(on);
    try {
      localStorage.setItem(READ_ALOUD_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (!on) stopSpeaking();
    // Before a run there is no step to read, so say hello to show the speaker works.
    else if (!event) speak("Hi, I'm Robo! Press Start and I'll read each step to you.");
  };

  // Read each step aloud; while playing, move on when the sentence has been read.
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!event) return;
    const advance = () => {
      if (!playing) return;
      if (step >= total - 1) {
        setPlaying(false);
        return;
      }
      const [quiet, afterSpeech] = PACE_DELAY[pace === 'manual' ? 'normal' : pace];
      // Linger on a new idea card so there is time to read it.
      const linger = concept ? 2500 : 0;
      timer.current = window.setTimeout(() => dbg.goTo(step + 1), (readAloud && speechSupported ? afterSpeech : quiet) + linger);
    };
    if (readAloud && speechSupported) speak(sentence, advance);
    else advance();
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.step, run, playing, readAloud, pace]);

  useEffect(() => () => stopSpeaking(), []);

  const start = async () => {
    setPlaying(false);
    stopSpeaking();
    await dbg.execute();
    // Robo walks through the program by itself unless the child chose to press Next each time.
    setPlaying(pace !== 'manual');
  };

  // Taking a step by hand pauses the automatic walk-through.
  const stepBy = (move: () => void) => {
    setPlaying(false);
    move();
  };

  // Keyboard: Space plays or pauses, the arrow keys step (not while typing in the code or a box).
  const keys = useRef({ playing, setPlaying, stepBy, dbg, ready: false });
  keys.current = { playing, setPlaying, stepBy, dbg, ready: !!run && !stale };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      const target = e.target as HTMLElement | null;
      if (!k.ready || e.altKey || e.ctrlKey || e.metaKey) return;
      if (target?.closest('input, textarea, select, button, [contenteditable="true"], .monaco-editor, .blocklySvg, .blocklyWidgetDiv')) return;
      if (e.key === ' ') k.setPlaying(!k.playing);
      else if (e.key === 'ArrowRight') k.stepBy(k.dbg.next);
      else if (e.key === 'ArrowLeft') k.stepBy(k.dbg.prev);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const smallButton = 'rounded-lg border-2 px-2.5 py-1 text-sm font-bold transition';
  const bigButton = 'inline-flex items-center gap-1.5 rounded-xl border-2 px-3 py-1.5 text-base font-bold shadow-lg transition disabled:cursor-not-allowed disabled:opacity-40 2xl:px-4 2xl:py-2 2xl:text-lg';

  return (
    <div className="flex h-full min-h-0 flex-col bg-gradient-to-b from-indigo-950 via-slate-950 to-slate-950">
      {/* Controls: few, big, labelled with words and pictures */}
      <div className="flex flex-wrap items-center gap-2 border-b border-indigo-900 px-3 py-2" role="toolbar" aria-label="Kids controls">
        <label className="flex items-center gap-2 text-base font-semibold text-indigo-100">
          📚 <span className="hidden 2xl:inline">Pick a program:</span>
          <select
            className="input py-1.5 text-base"
            defaultValue=""
            aria-label="Pick a program"
            onChange={(e) => {
              const ex = KID_EXAMPLES.find((x) => x.id === e.target.value);
              if (ex) {
                setPlaying(false);
                stopSpeaking();
                setMission(null);
                setBlocks(false);
                dbg.loadProject(ex.source, {}, ex.stdin ?? '');
              }
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              choose…
            </option>
            {KID_EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.title}
              </option>
            ))}
          </select>
        </label>
        <button className={`${bigButton} border-emerald-400 bg-emerald-600 hover:bg-emerald-500`} onClick={start} disabled={phase === 'running'}>
          {phase === 'running' ? '⏳ Getting ready…' : '▶ Start'}
        </button>
        <button className={`${bigButton} border-slate-500 bg-slate-800 hover:bg-slate-700`} onClick={() => stepBy(dbg.prev)} disabled={!run || stale || step === 0} aria-keyshortcuts="Shift+F10">
          ⬅ Back
        </button>
        <button
          className={`${bigButton} border-sky-300 bg-sky-600 hover:bg-sky-500 2xl:text-xl`}
          onClick={() => stepBy(dbg.next)}
          disabled={!run || stale || step >= total - 1}
          aria-keyshortcuts="F10"
        >
          Next step ➡
        </button>
        <button
          className={`${bigButton} ${playing ? 'border-orange-400 bg-orange-600' : 'border-violet-400 bg-violet-700 hover:bg-violet-600'}`}
          onClick={() => {
            if (!playing && step >= total - 1) dbg.goTo(0);
            setPlaying(!playing);
          }}
          disabled={!run || stale || total < 2}
          aria-pressed={playing}
        >
          {playing ? '⏸ Pause' : '🎬 Play'}
        </button>
        <select
          className="input py-1.5 text-base"
          value={pace}
          onChange={(e) => setPace(e.target.value as Pace)}
          aria-label="How fast Robo goes"
          title="How fast Robo goes through the steps"
        >
          <option value="slow">🐢 Slow</option>
          <option value="normal">🚶 Normal</option>
          <option value="fast">🐇 Fast</option>
          <option value="manual">✋ I press Next</option>
        </select>
        <button className={`${bigButton} border-slate-500 bg-slate-800 hover:bg-slate-700`} onClick={() => stepBy(() => dbg.goTo(0))} disabled={!run || stale || step === 0}>
          🔁 From the start
        </button>
        <button
          className={`${bigButton} ml-auto border-amber-400 bg-amber-600 hover:bg-amber-500`}
          onClick={() => setShowChallenges(!showChallenges)}
          aria-expanded={showChallenges}
        >
          🏆 Challenges <span className="rounded-full bg-amber-900 px-2 text-sm">⭐ {stars.size}/{CHALLENGES.length}</span>
        </button>
      </div>

      {run && !stale && total > 1 && (
        <div className="flex items-center gap-3 border-b border-indigo-900/60 px-4 py-1.5">
          <span aria-hidden>🚩</span>
          <input
            type="range"
            min={0}
            max={total - 1}
            value={step}
            onChange={(e) => stepBy(() => dbg.goTo(Number(e.target.value)))}
            className="h-2 flex-1 cursor-pointer accent-sky-400"
            aria-label="Robo's place in the program"
            aria-valuetext={`Step ${step + 1} of ${total}`}
          />
          <span aria-hidden>🏁</span>
          <span className="hidden text-sm text-indigo-300 md:inline">
            Keys: <kbd className="rounded bg-slate-800 px-1">Space</kbd> play/pause · <kbd className="rounded bg-slate-800 px-1">←</kbd>{' '}
            <kbd className="rounded bg-slate-800 px-1">→</kbd> steps
          </span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-3 overflow-auto p-3 lg:auto-rows-auto lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        {/* Left: the code, big, with the robot on the current line */}
        <div className="flex flex-col gap-3 lg:min-h-0">
          <div className="panel flex h-[420px] flex-col overflow-hidden rounded-2xl lg:h-auto lg:min-h-[280px] lg:flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2">
              <span className="text-base font-bold text-indigo-200">
                {blocks ? '🧩 Snap blocks together (they turn into the code below)' : kidFile === 'main.py' ? "📜 The code (Robo's instructions)" : `📜 Robo is inside ${kidFile}`}
              </span>
              <span className="flex gap-2">
                <button
                  className={`${smallButton} ${explainAll ? 'border-yellow-300 bg-yellow-700' : 'border-yellow-500/60 hover:bg-slate-800'}`}
                  onClick={() => setExplainAll(!explainAll)}
                  aria-pressed={explainAll}
                  title="Write a short explanation next to every line"
                >
                  📖 {explainAll ? 'Hide line notes' : 'Explain every line'}
                </button>
                <button
                  className={`${smallButton} ${blocks ? 'border-pink-300 bg-pink-700' : 'border-pink-500/60 hover:bg-slate-800'}`}
                  onClick={() => setBlocks(!blocks)}
                  aria-pressed={blocks}
                  title="Build programs by snapping blocks together instead of typing"
                >
                  {blocks ? '⌨️ Type code' : '🧩 Use blocks'}
                </button>
              </span>
            </div>
            {blocks && (
              <div className="h-[380px] shrink-0 border-b border-slate-800">
                <Suspense fallback={<p className="p-4 text-lg text-slate-400">Getting the blocks ready…</p>}>
                  <KidsBlocks onCode={dbg.setSource} />
                </Suspense>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <CodeEditor
                path={`kids-${kidFile}`}
                value={kidFile === 'main.py' ? dbg.source : dbg.files[kidFile] ?? ''}
                onChange={kidFile === 'main.py' && !blocks ? dbg.setSource : () => {}}
                activeLine={event && (event.file ?? 'main.py') === kidFile ? event.line : null}
                failLine={run && !stale && run.summary.error && (run.summary.error.file ?? 'main.py') === kidFile ? run.summary.error.line || null : null}
                citedLines={[]}
                onRun={start}
                variant="game"
                fontSize={blocks ? 16 : 20}
                lineNotes={explainAll && kidFile === 'main.py' ? plan?.line_notes ?? null : null}
                hoverNotes={kidFile === 'main.py' ? plan?.line_notes ?? null : null}
              />
            </div>
          </div>
          {/\binput\s*\(/.test(dbg.source) && (
            <label className="block rounded-2xl border-2 border-indigo-700 bg-indigo-950/60 p-3 text-base font-semibold text-indigo-100">
              ✏️ Your answers for Robo's questions (one per line):
              <textarea
                className="input mt-2 h-20 w-full text-lg"
                value={dbg.stdin}
                onChange={(e) => dbg.setStdin(e.target.value)}
                placeholder="Mia"
                aria-label="Program input: one line per input() call"
              />
            </label>
          )}
          <section className="rounded-2xl border-2 border-slate-700 bg-black/60 p-3" aria-labelledby="screen-title">
            <h2 id="screen-title" className="mb-1 text-base font-bold text-emerald-200">
              📺 The screen
            </h2>
            <pre className="max-h-40 min-h-[40px] overflow-auto whitespace-pre-wrap font-mono text-lg text-emerald-300" role="log">
              {screen || <span className="text-base text-slate-500">Nothing on the screen yet.</span>}
            </pre>
          </section>
        </div>

        {/* Right: what is happening, in words and pictures */}
        <div className="flex flex-col gap-3 lg:min-h-0 lg:overflow-auto">
          {showChallenges && (
            <section className="rounded-3xl border-4 border-amber-400 bg-amber-950/60 p-4" aria-labelledby="challenges-title">
              <h2 id="challenges-title" className="mb-2 text-xl font-black text-amber-200">
                🏆 Pick a challenge
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {CHALLENGES.map((c) => (
                  <li key={c.id}>
                    <button
                      className="flex w-full items-center justify-between gap-2 rounded-xl border-2 border-amber-700 bg-slate-900/80 px-3 py-2 text-left text-base font-semibold hover:bg-slate-800"
                      onClick={() => startMission(c)}
                    >
                      <span>{c.title}</span>
                      <span aria-label={stars.has(c.id) ? 'done' : 'not done yet'}>{stars.has(c.id) ? '⭐' : '☆'}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-amber-800 pt-3 text-sm text-amber-100">
                <span>Using another computer?</span>
                <button
                  className="rounded-lg border border-amber-500 px-2 py-1 hover:bg-amber-900"
                  onClick={async () => {
                    const code = exportProgress();
                    try {
                      await navigator.clipboard.writeText(code);
                      setProgressNote('Progress code copied! Paste it on the other computer.');
                    } catch {
                      setProgressNote(code);
                    }
                  }}
                >
                  📋 Copy my progress code
                </button>
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = (e.currentTarget.elements.namedItem('progress') as HTMLInputElement).value;
                    try {
                      setProgressNote(importProgress(input));
                      setStars(loadStars());
                      setLearned(loadLearned());
                    } catch (err) {
                      setProgressNote((err as Error).message);
                    }
                  }}
                >
                  <input name="progress" className="input w-40 py-1 text-xs" placeholder="paste a progress code" aria-label="Progress code" />
                  <button className="rounded-lg border border-amber-500 px-2 py-1 hover:bg-amber-900">Load</button>
                </form>
                <button
                  className="rounded-lg border border-amber-700 px-2 py-1 text-amber-300 hover:bg-amber-900"
                  onClick={() => {
                    setLearned(new Set());
                    saveLearned(new Set());
                    setProgressNote('The idea cards will show again.');
                  }}
                >
                  💡 Show idea cards again
                </button>
                {progressNote && <span className="w-full break-all text-amber-200">{progressNote}</span>}
              </div>
            </section>
          )}

          {mission && (
            <section
              className={`rounded-3xl border-4 p-4 ${missionResult?.passed ? 'border-emerald-400 bg-emerald-950/60' : 'border-amber-400 bg-amber-950/40'}`}
              aria-live="polite"
              aria-labelledby="mission-title"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 id="mission-title" className="text-xl font-black text-amber-100">
                  🎯 Mission: {mission.title}
                </h2>
                <button className="text-sm text-amber-300 underline" onClick={() => setMission(null)}>
                  stop mission
                </button>
              </div>
              <p className="mt-1 text-lg text-white">{mission.task}</p>
              {missionResult ? (
                missionResult.passed ? (
                  <p className="cl-pop mt-2 text-xl font-bold text-emerald-200">⭐ Mission complete! Great coding!</p>
                ) : (
                  <p className="mt-2 text-lg text-amber-100">🤔 Not yet: {missionResult.message}</p>
                )
              ) : (
                <p className="mt-2 text-base text-amber-200">Change the code, then press ▶ Start to check it.</p>
              )}
              {missionResult && !missionResult.passed && (
                <details className="mt-1 text-base text-amber-200">
                  <summary className="cursor-pointer">💡 Need a hint?</summary>
                  <p className="mt-1">{mission.hint}</p>
                </details>
              )}
            </section>
          )}

          <section
            className={`rounded-3xl border-4 p-4 shadow-xl ${crashed ? 'border-orange-400 bg-orange-950/70' : success ? 'border-emerald-400 bg-emerald-950/60' : 'border-sky-400 bg-sky-950/60'}`}
            aria-live="polite"
            aria-labelledby="robot-says"
          >
            <div className="flex items-start gap-4">
              <div className={`text-5xl ${crashed ? 'cl-shake' : 'cl-bob'}`} aria-hidden>
                {crashed ? '😵' : success ? '🥳' : '🤖'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="robot-says" className="text-sm font-bold uppercase tracking-wider text-sky-300">
                    {run && !stale ? `Step ${step + 1} of ${total}` : 'Robo says'}
                  </h2>
                  {speechSupported && (
                    <div className="flex items-center gap-2">
                      <label className="flex cursor-pointer items-center gap-2 rounded-xl border-2 border-sky-700 px-2 py-1 text-sm font-semibold text-sky-100">
                        <input type="checkbox" className="h-4 w-4" checked={readAloud} onChange={(e) => toggleReadAloud(e.target.checked)} />
                        🔊 Read aloud
                      </label>
                      {readAloud && voices.length > 1 && (
                        <select
                          className="input max-w-[160px] py-1 text-xs"
                          aria-label="Voice"
                          value={voice}
                          onChange={(e) => {
                            setVoice(e.target.value);
                            chooseVoice(e.target.value);
                            speak("Hi, I'm Robo! This is how I sound.");
                          }}
                        >
                          <option value="">Default voice</option>
                          {voices.map((v) => (
                            <option key={v.name} value={v.name}>
                              {v.name.replace(/^(Microsoft|Google)\s*/, '')}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
                <p id="robo-sentence" key={event?.step ?? 'idle'} className="cl-float-up mt-1 text-xl font-semibold leading-snug text-white 2xl:text-2xl">
                  {run && !stale
                    ? sentence
                    : phase === 'running'
                      ? 'Getting ready…'
                      : run && stale
                        ? "You changed the code! Press ▶ Start and I'll follow the new version."
                        : 'Hi! I\'m Robo. Pick a program, then press ▶ Start. I\'ll follow the code one line at a time and tell you what happens.'}
                </p>
                {run && !stale && step === 0 && total > 1 && (
                  <p className="mt-2 text-base text-sky-200">
                    {playing ? 'Robo will move on by itself. Press ⏸ Pause any time to stop and look.' : 'Press the blue “Next step ➡” button to see what happens next.'}
                  </p>
                )}
                {success && (
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <p className="text-lg text-emerald-200">🎉 You followed the whole program! Pick another one, or change the code and press ▶ Start.</p>
                    <button
                      className="rounded-xl border-2 border-emerald-300 bg-emerald-700 px-3 py-1 text-base font-bold hover:bg-emerald-600"
                      onClick={() => {
                        dbg.goTo(0);
                        setPlaying(pace !== 'manual');
                      }}
                    >
                      🔁 Watch again
                    </button>
                  </div>
                )}
                {run && !stale && run.summary.error && (
                  <div className="mt-3 rounded-2xl border-2 border-orange-400/60 bg-slate-950/60 p-3">
                    {!fixAsked ? (
                      <button
                        className="rounded-xl border-2 border-orange-300 bg-orange-600 px-4 py-2 text-lg font-bold hover:bg-orange-500"
                        onClick={async () => {
                          setFixAsked(true);
                          await dbg.generatePatch();
                        }}
                      >
                        🔧 Help me fix it
                      </button>
                    ) : dbg.busy === 'patch' ? (
                      <p className="text-lg text-orange-100">🔍 Looking for the problem…</p>
                    ) : dbg.patch ? (
                      <div className="space-y-2">
                        <p className="text-lg text-orange-50">🔧 {dbg.patch.rationale}</p>
                        <button
                          className="rounded-xl border-2 border-emerald-300 bg-emerald-600 px-4 py-2 text-lg font-bold hover:bg-emerald-500"
                          onClick={async () => {
                            dbg.applyPatch();
                            setFixAsked(false);
                            await dbg.execute(dbg.patch!.patched_source);
                          }}
                        >
                          ✅ Use this fix and try again
                        </button>
                      </div>
                    ) : (
                      <p className="text-lg text-orange-100">
                        🤔 I can't fix this one by myself. Look at the line with 💥 and the Oops! message, and try changing it.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {draws && run && !stale && (
            <section className="cl-pop rounded-3xl border-4 border-emerald-400 bg-emerald-950/40 p-3" aria-labelledby="drawing-title">
              <h2 id="drawing-title" className="mb-2 text-xl font-black text-emerald-200">
                🎨 The turtle&apos;s drawing
              </h2>
              <div className="h-[340px]">
                <TurtleStage events={events} upto={boardStep} />
              </div>
            </section>
          )}

          {concept && event?.concept && (
            <section className="cl-pop rounded-3xl border-4 border-yellow-300 bg-yellow-950/60 p-4 shadow-xl" aria-labelledby="idea-title">
              <div className="flex items-start gap-3">
                <span className="text-5xl" aria-hidden>
                  {concept.emoji}
                </span>
                <div className="flex-1">
                  <h2 id="idea-title" className="text-xl font-black text-yellow-200">
                    💡 New idea: {concept.title}
                  </h2>
                  <p className="mt-1 text-lg text-yellow-50">{concept.text}</p>
                  <pre className="mt-2 inline-block rounded-lg bg-slate-950 px-3 py-1.5 font-mono text-lg text-sky-200">{concept.example}</pre>
                </div>
                <button
                  className="rounded-xl border-2 border-yellow-300 px-3 py-1 text-base font-bold text-yellow-100 hover:bg-yellow-800"
                  onClick={() => learnIdea(event.concept!)}
                >
                  Got it! 👍
                </button>
              </div>
            </section>
          )}

          <details
            open={!run || stale || step === 0}
            className="rounded-3xl border-2 border-emerald-700 bg-emerald-950/40 p-4"
            key={run && !stale ? 'running' : 'idle'}
          >
            <summary className="cursor-pointer text-xl font-black text-emerald-200">📖 What does this program do?</summary>
            <div className="mt-2">
              <ProgramPlan
                plan={plan}
                big
                currentLine={event && (event.file ?? 'main.py') === 'main.py' ? event.line : null}
                onLine={(line) => {
                  const target = events.findIndex((e, i) => i > step && e.event === 'line' && e.line === line);
                  if (target >= 0) dbg.goTo(target);
                }}
              />
              <p className="mt-2 text-sm text-emerald-200/80">Tip: point at any line or word in the code to see what it means.</p>
            </div>
          </details>

          <section className="rounded-3xl border-2 border-slate-700 bg-slate-900/60" aria-label="Robo's boxes">
            <KidBoard viz={viz} changed={changed} />
          </section>
        </div>
      </div>
    </div>
  );
}
