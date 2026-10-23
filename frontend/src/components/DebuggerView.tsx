import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { MAIN_FILE, type Debugger } from '../hooks/useDebugger';
import { useCodeExplanation } from '../hooks/useCodeExplanation';
import { useGame } from '../hooks/useGame';
import { ProgramPlan } from './ProgramPlan';
import { detectNonPython } from '../lib/detect';
import { callStackAt, changedVariables, stdoutUpTo } from '../lib/trace';
import { hasDrawing } from '../lib/turtle';
import { vizAt } from '../lib/viz';
import { CallStack } from './CallStack';
import { CodeEditor } from './CodeEditor';
import { ConsolePanel } from './ConsolePanel';
import { FileTabs } from './FileTabs';
import { GameHUD, Toasts } from './game/GameHUD';
import { Stage, type BoardView } from './game/Stage';
import { ProgramInput } from './ProgramInput';
import { Timeline } from './Timeline';
import { Toolbar } from './Toolbar';
import { VariableInspector } from './VariableInspector';
import { KidsView } from './kids/KidsView';

// The AI panel pulls in Monaco's diff editor; load it only when first opened.
const AIPanel = lazy(() => import('./AIPanel').then((m) => ({ default: m.AIPanel })));

type Mode = 'game' | 'classic' | 'kids';
const MODE_KEY = 'codelens.view-mode';
const BOARD_KEY = 'codelens.game.board';

function loadBoard(): BoardView {
  try {
    return localStorage.getItem(BOARD_KEY) === 'arrows' ? 'arrows' : 'cards';
  } catch {
    return 'cards';
  }
}

function loadMode(): Mode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === 'classic' || saved === 'game' ? saved : 'kids'; // beginners first
  } catch {
    return 'kids';
  }
}

interface Props {
  dbg: Debugger;
}

export function DebuggerView({ dbg }: Props) {
  const { run, step, stale, activeFile } = dbg;
  const [mode, setMode] = useState<Mode>(loadMode);
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [explainAll, setExplainAll] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [board, setBoard] = useState<BoardView>(loadBoard);
  const chooseBoard = (view: BoardView) => {
    setDrawingFirst(false);
    setBoard(view);
    try {
      localStorage.setItem(BOARD_KEY, view);
    } catch {
      /* ignore */
    }
  };
  // Plan + line notes for the file in the editor, built from the code itself (works before running).
  // Each view explains the program in its own voice (Robo Lab has its own plan in KidsView).
  const plan = useCodeExplanation(dbg.editorValue, mode === 'classic' ? 'classic' : 'game');
  const game = useGame(dbg);
  const revealLine = (line: number) => setReveal({ line, nonce: Date.now() });

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const events = run?.events ?? [];
  const event = !stale && run ? events[step] ?? null : null;
  const eventFile = event?.file ?? MAIN_FILE;
  const stack = useMemo(() => (run ? callStackAt(events, step) : []), [run, events, step]);
  const changed = useMemo(() => (run ? changedVariables(events, step) : new Set<string>()), [run, events, step]);
  const stdoutToStep = useMemo(() => (run ? stdoutUpTo(events, step) : ''), [run, events, step]);
  const viz = useMemo(() => (run && !stale ? vizAt(events, step) : null), [run, events, step, stale]);
  const draws = useMemo(() => hasDrawing(events), [events]);
  // A program that draws opens on the Drawing board (without changing the saved preference).
  const [drawingFirst, setDrawingFirst] = useState(false);
  useEffect(() => setDrawingFirst(draws), [run, draws]);
  const boardView: BoardView = drawingFirst && draws ? 'drawing' : board === 'drawing' && !draws ? 'cards' : board;

  // Follow the robot: when a step runs in another file, show that file.
  useEffect(() => {
    if (!event) return;
    if (eventFile !== activeFile && (eventFile === MAIN_FILE || eventFile in dbg.files)) dbg.setActiveFile(eventFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.step, run]);

  const error = !stale ? run?.summary.error ?? null : null;
  const failLine = error && (error.file ?? MAIN_FILE) === activeFile ? error.line || null : null;
  const activeLine = event && eventFile === activeFile ? event.line : null;
  const cited = !stale && activeFile === MAIN_FILE ? dbg.explanation?.cited_lines ?? [] : [];
  // Pasted JavaScript/Java/C++…? Say so plainly instead of only showing a SyntaxError.
  const foreign = useMemo(() => {
    const err = run?.summary.error;
    return run && !stale && err && ['SyntaxError', 'IndentationError'].includes(err.type) ? detectNonPython(run.source) : null;
  }, [run, stale]);
  // A narration explains the step; hide it while the user is guessing in Predict mode (it would give the answer away).
  const narration = event?.narration && !game.awaitingGuess ? event.narration : null;
  const notes = explainAll ? plan?.line_notes ?? null : null;
  const gapNote = event?.skipped_before
    ? `⋯ ${event.skipped_before.toLocaleString()} steps in the middle of this long run were skipped before this one`
    : event?.untraced_before
      ? '⏸ Line-by-line recording paused before this point (long run); the program kept running'
      : null;

  // In game mode, Step Next goes through Predict mode when it is on.
  const controls: Debugger = mode === 'game' ? { ...dbg, next: game.requestNext } : dbg;

  useEffect(() => {
    if (!game.awaitingGuess) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && game.cancelGuess();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [game]);

  const modeSwitch = (
    <div role="radiogroup" aria-label="View mode" className="flex overflow-hidden rounded-md border border-slate-700 text-xs">
      {(['kids', 'game', 'classic'] as Mode[]).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          onClick={() => setMode(m)}
          className={`px-2.5 py-1 font-semibold ${mode === m ? 'bg-cyan-500 text-slate-950' : 'bg-slate-900 text-slate-400 hover:text-slate-100'}`}
        >
          {m === 'kids' ? '🤖 Robo Lab' : m === 'game' ? '🎮 Game' : '📋 Classic'}
        </button>
      ))}
    </div>
  );

  const explainAllToggle = (
    <button
      className={`btn px-2 py-0.5 text-xs ${explainAll ? 'border-yellow-500 bg-yellow-700/40' : ''}`}
      aria-pressed={explainAll}
      onClick={() => setExplainAll(!explainAll)}
      title="Show a one-line explanation next to every line of code"
    >
      📖 Explain every line
    </button>
  );

  const planToggle = (
    <>
      <button
        className={`btn px-2 py-0.5 text-xs ${planOpen ? 'border-emerald-500 bg-emerald-800/50' : ''}`}
        aria-pressed={planOpen}
        onClick={() => setPlanOpen(!planOpen)}
        title="A short plan of the whole program, top to bottom"
      >
        🗺 What does this program do?
      </button>
    </>
  );

  const stepBanner = event && (
    <span className="min-w-0 truncate font-mono text-xs text-slate-300" aria-live="polite">
      <span className="text-blue-300">{mode === 'game' ? '🤖' : '▶'} step {step + 1}</span> · line {event.line}
      {eventFile !== MAIN_FILE && <span className="text-fuchsia-300"> of {eventFile}</span>} in{' '}
      <span className="text-sky-300">{event.function}</span>
      {mode === 'classic' && narration && <span className="font-sans text-yellow-100"> · 🗣 {narration}</span>}
    </span>
  );

  const editor = (variant: 'game' | 'classic') => (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileTabs dbg={dbg} runningFile={event ? eventFile : null} />
      {planOpen && (
        <div className="max-h-[40%] overflow-auto border-b border-slate-800 bg-emerald-950/30 px-3 py-2">
          <ProgramPlan plan={plan} currentLine={activeLine} onLine={revealLine} />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <CodeEditor
          path={activeFile}
          value={dbg.editorValue}
          onChange={dbg.setEditorValue}
          activeLine={activeLine}
          failLine={failLine}
          citedLines={cited}
          onRun={dbg.execute}
          revealRequest={reveal}
          variant={variant}
          onLineClick={variant === 'game' && game.awaitingGuess ? game.guess : null}
          inlineNote={activeLine && variant === 'classic' ? narration : null}
          lineNotes={notes}
          breakpoints={dbg.breakpointLines(activeFile)}
          onToggleBreakpoint={dbg.toggleBreakpoint}
          hoverNotes={plan?.line_notes ?? null}
        />
      </div>
    </div>
  );

  const consolePanel = (
    <ConsolePanel summary={run?.summary ?? null} stdoutToStep={stdoutToStep} runError={dbg.runError} onDelete={run ? dbg.deleteRun : null} />
  );

  const aiPanel = (
    <Suspense fallback={<p className="p-3 text-sm text-slate-500">Loading…</p>}>
      <AIPanel dbg={dbg} onRevealLine={revealLine} />
    </Suspense>
  );

  const foreignBanner = foreign && run && (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-fuchsia-800 bg-fuchsia-950/70 px-3 py-2 text-sm">
      <span>
        🌍 This looks like <strong>{foreign}</strong>, not Python. CodeLens runs Python programs, so write it in Python to watch it run.
      </span>
    </div>
  );

  if (mode === 'kids') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-900/40 px-3 py-1">
          {modeSwitch}
          <span className="text-xs text-slate-400">Robo Lab: big text, simple words and a robot guide, for first-time coders. Switch to Game or Classic for more tools.</span>
        </div>
        <div className="min-h-0 flex-1">
          <KidsView dbg={dbg} />
        </div>
      </div>
    );
  }

  if (mode === 'game') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-slate-800 bg-slate-900/80">
          <Toolbar dbg={controls} leading={modeSwitch} />
        </div>
        {foreignBanner}
        <Toasts game={game} />
        {/* Code on the left, the simulation on the right, side by side and the same size. Phones stack them. */}
        <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-2 overflow-auto p-2 md:auto-rows-auto md:grid-cols-2 md:overflow-hidden">
          <div className="flex flex-col gap-2 md:min-h-0">
            <div className={`panel relative h-[60vh] flex-none overflow-hidden md:h-auto md:min-h-0 md:flex-1 ${game.awaitingGuess ? 'ring-2 ring-fuchsia-500' : ''}`}>
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/60 px-2 py-1">
                <span className="mr-auto text-xs font-bold uppercase tracking-wide text-slate-400">📜 Code</span>
                {explainAllToggle}
                {planToggle}
              </div>
              {game.awaitingGuess && (
                <div className="cl-pop absolute inset-x-2 top-20 z-10 rounded-lg bg-fuchsia-700 px-3 py-2 text-center text-sm font-bold shadow-lg">
                  🎯 Where will the robot go next? Click a line! <span className="font-normal opacity-80">(Esc to cancel)</span>
                </div>
              )}
              {editor('game')}
            </div>
            <ProgramInput dbg={dbg} />
            <div className="h-[130px] shrink-0">{consolePanel}</div>
          </div>

          <div className="panel h-[85vh] overflow-hidden md:h-auto md:min-h-0">
            <GameHUD dbg={dbg} game={game} />
            <div className="min-h-[52px] shrink-0 border-b border-slate-800 bg-slate-950/80 px-3 py-2" aria-live="polite">
              {event ? (
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 rounded-md bg-cyan-500 px-2 py-0.5 font-mono text-xs font-bold text-slate-950">
                    LINE {event.line}
                    {eventFile !== MAIN_FILE && ` · ${eventFile}`}
                  </span>
                  <p key={event.step} className="cl-float-up text-base font-medium leading-snug text-yellow-100">
                    {game.awaitingGuess ? '🎯 Make your guess first…' : `🗣 ${narration ?? ''}`}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-slate-400">Press ▶ Run Code, then step through: the explanation for each line appears here.</p>
              )}
              {gapNote && <p className="mt-1 text-xs text-slate-400">{gapNote}</p>}
            </div>
            <div className="min-h-0 flex-1">
              <Stage
                viz={viz}
                event={event}
                summary={run && !stale ? run.summary : null}
                isLast={!!run && !stale && step === events.length - 1}
                onReplay={() => dbg.goTo(0)}
                onExplain={() => {
                  setAiOpen(true);
                  dbg.explain(null, null);
                }}
                onFix={async () => {
                  setAiOpen(true);
                  await dbg.generatePatch();
                }}
                view={boardView}
                onView={chooseBoard}
                changed={changed}
                drawingEvents={draws && !stale ? events : null}
                drawingUpto={step}
              />
            </div>
            <div className="shrink-0 border-t border-slate-800">
              <button
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 hover:bg-slate-800"
                onClick={() => setAiOpen(!aiOpen)}
                aria-expanded={aiOpen}
              >
                <span>🧠 AI coach: explain · fix · test {dbg.patch ? `· patch ${dbg.patch.status}` : ''}</span>
                <span>{aiOpen ? '▼' : '▲'}</span>
              </button>
              {aiOpen && <div className="h-[340px]">{aiPanel}</div>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-800 bg-slate-900/80">
        <Toolbar dbg={controls} />
      </div>
      {foreignBanner}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-900/40 px-3 py-1">
        {modeSwitch}
        {explainAllToggle}
        {planToggle}
        {stepBanner}
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-2 overflow-auto p-2 lg:auto-rows-auto lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)] lg:overflow-hidden">
        <div className="flex min-h-[340px] flex-col gap-2">
          <div className="panel min-h-0 flex-1 overflow-hidden">{editor('classic')}</div>
          <ProgramInput dbg={dbg} />
        </div>
        <div className="grid min-h-[300px] grid-rows-[minmax(0,1.3fr)_minmax(0,0.7fr)] gap-2">
          <VariableInspector event={event} changed={changed} />
          <CallStack frames={stale ? [] : stack} onSelectLine={revealLine} />
        </div>
        <div className="grid min-h-[260px] grid-cols-1 gap-2 md:grid-cols-2">
          <Timeline events={stale ? [] : events} step={step} onSelect={dbg.goTo} />
          {consolePanel}
        </div>
        <div className="min-h-[300px]">{aiPanel}</div>
      </div>
    </div>
  );
}
