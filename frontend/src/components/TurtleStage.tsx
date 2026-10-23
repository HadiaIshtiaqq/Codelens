import { useEffect, useMemo, useRef, useState } from 'react';
import type { TraceEvent } from '../api/types';
import { drawingBefore, drawingBounds, type Mark } from '../lib/turtle';

const ANIMATE_MS = 450;

/**
 * The turtle's picture just before step `upto` runs. Stepping forward by one animates that
 * step's new lines being drawn while the turtle glides along (the idea of Scratch's "glide").
 */
export function TurtleStage({ events, upto, compact }: { events: TraceEvent[]; upto: number; compact?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [progress, setProgress] = useState(1);
  const prevUpto = useRef(upto);
  const drawing = useMemo(() => drawingBefore(events, upto), [events, upto]);
  const bounds = useMemo(() => drawingBounds(events), [events]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Animate only a single step forward; jumps and steps back redraw at once.
  const animatedStep = upto - 1;
  useEffect(() => {
    const forwardOne = upto === prevUpto.current + 1;
    prevUpto.current = upto;
    if (!forwardOne || !drawing.marks.some((m) => m.step === animatedStep)) {
      setProgress(1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ANIMATE_MS);
      setProgress(p);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    setProgress(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [upto, drawing, animatedStep]);

  const view = useMemo(() => {
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const scale = size.w && size.h ? Math.min(size.w / bw, size.h / bh) : 1;
    const ox = (size.w - bw * scale) / 2;
    const oy = (size.h - bh * scale) / 2;
    // World: origin in the middle, y up. Canvas: origin top-left, y down.
    return { scale, px: (x: number) => ox + (x - bounds.minX) * scale, py: (y: number) => oy + (bounds.maxY - y) * scale };
  }, [bounds, size]);

  // Where the new step's marks have got to, so the turtle sprite can ride along the line being drawn.
  const fresh = drawing.marks.filter((m) => m.step === animatedStep);
  const drawnFresh = progress >= 1 ? fresh.length : progress * fresh.length;

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w || !size.h) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = drawing.background;
    g.fillRect(0, 0, size.w, size.h);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    let freshIndex = 0;
    for (const m of drawing.marks) {
      let part = 1;
      if (m.step === animatedStep && progress < 1) {
        part = Math.max(0, Math.min(1, drawnFresh - freshIndex));
        freshIndex++;
        if (part <= 0) continue;
      }
      paint(g, m, part, view);
    }
  }, [drawing, size, view, progress, animatedStep, drawnFresh]);

  const sprites = [...drawing.sprites.entries()].filter(([, s]) => s.visible);
  const main = drawing.sprites.get(0) ?? sprites[0]?.[1];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={host} className="relative min-h-0 flex-1 overflow-hidden rounded-xl border-2 border-emerald-500/40 bg-white shadow-inner" data-testid="turtle-stage">
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-label="The turtle's drawing" role="img" />
        {sprites.map(([id, s]) => (
          <span
            key={id}
            className="pointer-events-none absolute left-0 top-0 select-none text-2xl drop-shadow transition-transform ease-out"
            style={{
              transitionDuration: `${ANIMATE_MS}ms`,
              transform: `translate(${view.px(s.x) - 14}px, ${view.py(s.y) - 16}px) rotate(${-s.h}deg) scaleX(-1)`,
            }}
            aria-hidden
          >
            🐢
          </span>
        ))}
        {drawing.marks.length === 0 && (
          <p className="absolute inset-x-0 bottom-3 text-center text-sm text-slate-500">The turtle hasn't drawn anything yet. Keep stepping!</p>
        )}
      </div>
      {main && !compact && (
        <p className="mt-1 text-center font-mono text-xs text-slate-400">
          🐢 at ({Math.round(main.x)}, {Math.round(main.y)}) · facing {Math.round(main.h)}° · {drawing.marks.length} marks
        </p>
      )}
    </div>
  );
}

type View = { scale: number; px: (x: number) => number; py: (y: number) => number };

function paint(g: CanvasRenderingContext2D, m: Mark, part: number, v: View) {
  switch (m.kind) {
    case 'line': {
      g.strokeStyle = m.c;
      g.lineWidth = Math.max(1, m.w * v.scale);
      g.beginPath();
      g.moveTo(v.px(m.x1), v.py(m.y1));
      g.lineTo(v.px(m.x1 + (m.x2 - m.x1) * part), v.py(m.y1 + (m.y2 - m.y1) * part));
      g.stroke();
      break;
    }
    case 'fill': {
      g.globalAlpha = part;
      g.fillStyle = m.c;
      g.beginPath();
      m.pts.forEach(([x, y], i) => (i ? g.lineTo(v.px(x), v.py(y)) : g.moveTo(v.px(x), v.py(y))));
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
      break;
    }
    case 'dot':
      g.fillStyle = m.c;
      g.beginPath();
      g.arc(v.px(m.x), v.py(m.y), Math.max(1, (m.r / 2) * v.scale * part), 0, Math.PI * 2);
      g.fill();
      break;
    case 'stamp': {
      g.save();
      g.translate(v.px(m.x), v.py(m.y));
      g.rotate((-m.h * Math.PI) / 180);
      g.fillStyle = m.c;
      g.beginPath();
      g.moveTo(10, 0);
      g.lineTo(-6, 6);
      g.lineTo(-6, -6);
      g.closePath();
      g.fill();
      g.restore();
      break;
    }
    case 'text':
      g.fillStyle = m.c;
      g.font = `${Math.max(9, m.f * 1.4 * v.scale)}px ui-sans-serif, system-ui`;
      g.textAlign = m.a === 'center' ? 'center' : m.a === 'right' ? 'right' : 'left';
      g.fillText(m.s, v.px(m.x), v.py(m.y));
      break;
  }
}
