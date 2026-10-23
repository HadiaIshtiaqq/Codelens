import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { focusLine, lineRect } from '../lib/editorRegistry';
import { Lexi, type LexiMood } from './Lexi';

// Lexi, Alexa's character, lives above every page. It sits on the Alexa+ device, flies to the code
// to point at the line an answer is about, and waits in a corner on other pages.

interface Target {
  line: number;
  text: string;
}

interface Companion {
  target: Target | null;
  talking: boolean;
  mood: LexiMood;
  /** Fly to the code and point at `line`, with `text` in a speech bubble. */
  pointAt: (line: number, text: string) => void;
  dismiss: () => void;
  setTalking: (talking: boolean) => void;
  setMood: (mood: LexiMood) => void;
}

const CompanionContext = createContext<Companion | null>(null);

export function useCompanion(): Companion {
  const value = useContext(CompanionContext);
  if (!value) throw new Error('useCompanion needs a CompanionProvider');
  return value;
}

export function CompanionProvider({ children, onShowCode }: { children: ReactNode; onShowCode: () => void }) {
  const [target, setTarget] = useState<Target | null>(null);
  const [talking, setTalking] = useState(false);
  const [mood, setMood] = useState<LexiMood>('happy');
  const showCode = useRef(onShowCode);
  showCode.current = onShowCode;
  const pointAt = useCallback((line: number, text: string) => {
    setTarget({ line, text });
    showCode.current();
  }, []);
  const dismiss = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ target, talking, mood, pointAt, dismiss, setTalking, setMood }), [target, talking, mood, pointAt, dismiss]);
  return <CompanionContext.Provider value={value}>{children}</CompanionContext.Provider>;
}

interface Place {
  x: number;
  y: number;
  size: number;
  where: 'home' | 'line' | 'dock' | 'hidden';
}

/** The flying character. `view` is the open tab; Lexi appears once the Alexa+ tab has been opened. */
export function CompanionLayer({ view, enabled, onGoAlexa }: { view: string; enabled: boolean; onGoAlexa: () => void }) {
  const { target, talking, mood, dismiss } = useCompanion();
  const [place, setPlace] = useState<Place>({ x: 16, y: 16, size: 56, where: 'hidden' });
  const [flying, setFlying] = useState(false);
  const focusedFor = useRef<Target | null>(null);
  const last = useRef(place);

  // Leaving the code page ends the pointing, so Lexi doesn't point at an old line next time.
  const previousView = useRef(view);
  useEffect(() => {
    if (previousView.current === 'debugger' && view !== 'debugger' && target) dismiss();
    previousView.current = view;
  }, [view, target, dismiss]);

  useEffect(() => {
    if (!enabled) return;
    const measure = () => {
      let next: Place;
      if (target && view === 'debugger') {
        // First time: scroll the line into view and make it glow.
        const rect = focusedFor.current === target ? lineRect(target.line) : focusLine(target.line);
        if (rect) focusedFor.current = target;
        if (!rect) return; // the editor isn't on screen yet; try again shortly
        const size = 84;
        const x = Math.min(rect.right + 24, window.innerWidth - size - 16);
        next = { x, y: Math.max(8, rect.top + rect.height / 2 - size * 0.55), size, where: 'line' };
      } else if (view === 'alexa') {
        const home = document.querySelector('[data-lexi-home]')?.getBoundingClientRect();
        if (!home || home.width === 0) return;
        next = { x: home.left, y: home.top, size: home.width, where: 'home' };
      } else {
        next = { x: 16, y: window.innerHeight - 72, size: 56, where: 'dock' };
      }
      const prev = last.current;
      if (Math.abs(prev.x - next.x) < 1 && Math.abs(prev.y - next.y) < 1 && prev.size === next.size && prev.where === next.where) return;
      if (prev.where !== next.where && prev.where !== 'hidden') {
        setFlying(true);
        window.setTimeout(() => setFlying(false), 850);
      }
      last.current = next;
      setPlace(next);
    };
    measure();
    const id = window.setInterval(measure, 200);
    window.addEventListener('resize', measure);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, [enabled, target, view]);

  if (!enabled || place.where === 'hidden') return null;
  const pointing = place.where === 'line';
  const bubbleBelow = place.x + place.size + 320 > window.innerWidth;

  return (
    <div
      className={`pointer-events-none fixed z-40 ${flying ? 'lexi-flying' : ''}`}
      style={{
        left: place.x,
        top: place.y,
        transition: 'left 0.8s cubic-bezier(.45,-0.25,.3,1.3), top 0.8s cubic-bezier(.45,-0.25,.3,1.3)',
      }}
    >
      <button
        // On the Alexa+ screen, taps go through Lexi to the tap-to-talk button underneath.
        className={`block rounded-full focus-visible:outline-offset-4 ${place.where === 'home' ? 'pointer-events-none' : 'pointer-events-auto'}`}
        onClick={() => (place.where === 'home' ? undefined : target ? dismiss() : onGoAlexa())}
        aria-label={place.where === 'dock' ? 'Lexi: go to Alexa+' : 'Lexi'}
        title={place.where === 'dock' ? 'Ask Alexa about your code' : undefined}
        tabIndex={place.where === 'home' ? -1 : 0}
      >
        <Lexi size={place.size} talking={talking && !pointing} mood={pointing ? 'happy' : mood} pointing={pointing} />
      </button>
      {pointing && target && (
        <div
          className={`cl-pop pointer-events-auto absolute w-72 rounded-2xl border border-cyan-400/40 bg-slate-900/95 p-3 text-sm text-slate-100 shadow-2xl shadow-black/40 backdrop-blur ${
            bubbleBelow ? 'right-0 top-full mt-2' : 'left-full top-0 ml-2'
          }`}
          role="status"
          data-testid="lexi-bubble"
        >
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-cyan-300">Lexi · line {target.line}</p>
          <p className="leading-snug">{target.text}</p>
          <div className="mt-2 flex gap-2">
            <button
              className="btn btn-primary px-2.5 py-1 text-xs"
              onClick={() => {
                dismiss();
                onGoAlexa();
              }}
            >
              ← Back to Alexa
            </button>
            <button className="btn px-2.5 py-1 text-xs" onClick={dismiss}>
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
