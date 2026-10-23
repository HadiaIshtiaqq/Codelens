import type { TraceEvent } from '../api/types';

// Replays the turtle drawing ops recorded on trace events (see backend/worker/tracer.py).

export type DrawOp =
  | { k: 'new'; t: number }
  | { k: 'mv'; t: number; x: number; y: number; h: number; d: boolean; c?: string; w?: number }
  | { k: 'dot'; x: number; y: number; r: number; c: string }
  | { k: 'stamp'; t: number; x: number; y: number; h: number; c: string }
  | { k: 'text'; x: number; y: number; s: string; c: string; a?: string; f?: number }
  | { k: 'fill'; pts: [number, number][]; c: string }
  | { k: 'bg'; c: string }
  | { k: 'vis'; t: number; v: boolean }
  | { k: 'clear'; t: number };

export interface Sprite {
  x: number;
  y: number;
  h: number;
  visible: boolean;
}

/** One thing to paint, tagged with the turtle that made it (so clear() can remove it) and the step it came from. */
export type Mark =
  | { kind: 'line'; t: number; step: number; x1: number; y1: number; x2: number; y2: number; c: string; w: number }
  | { kind: 'dot'; t: number; step: number; x: number; y: number; r: number; c: string }
  | { kind: 'stamp'; t: number; step: number; x: number; y: number; h: number; c: string }
  | { kind: 'text'; t: number; step: number; x: number; y: number; s: string; c: string; a: string; f: number }
  | { kind: 'fill'; t: number; step: number; pts: [number, number][]; c: string };

export interface Drawing {
  marks: Mark[];
  sprites: Map<number, Sprite>;
  background: string;
}

export const hasDrawing = (events: TraceEvent[]) => events.some((e) => e.draw?.length);

/** The picture after the ops of events[0 .. upto-1] (i.e. just before step `upto` runs). */
export function drawingBefore(events: TraceEvent[], upto: number): Drawing {
  const marks: Mark[] = [];
  const sprites = new Map<number, Sprite>();
  let background = 'white';
  let last = -1; // the turtle used most recently (dot/text ops don't name one)
  for (let i = 0; i < Math.min(upto, events.length); i++) {
    for (const op of events[i].draw ?? []) {
      switch (op.k) {
        case 'new':
          sprites.set(op.t, { x: 0, y: 0, h: 0, visible: true });
          last = op.t;
          break;
        case 'mv': {
          const s = sprites.get(op.t) ?? { x: 0, y: 0, h: 0, visible: true };
          if (op.d && (s.x !== op.x || s.y !== op.y)) {
            marks.push({ kind: 'line', t: op.t, step: i, x1: s.x, y1: s.y, x2: op.x, y2: op.y, c: op.c ?? 'black', w: op.w ?? 1 });
          }
          sprites.set(op.t, { ...s, x: op.x, y: op.y, h: op.h });
          last = op.t;
          break;
        }
        case 'dot':
          marks.push({ kind: 'dot', t: last, step: i, x: op.x, y: op.y, r: op.r, c: op.c });
          break;
        case 'stamp':
          marks.push({ kind: 'stamp', t: op.t, step: i, x: op.x, y: op.y, h: op.h, c: op.c });
          break;
        case 'text':
          marks.push({ kind: 'text', t: last, step: i, x: op.x, y: op.y, s: op.s, c: op.c, a: op.a ?? 'left', f: op.f ?? 8 });
          break;
        case 'fill':
          marks.push({ kind: 'fill', t: last, step: i, pts: op.pts, c: op.c });
          break;
        case 'bg':
          background = op.c;
          break;
        case 'vis': {
          const s = sprites.get(op.t);
          if (s) sprites.set(op.t, { ...s, visible: op.v });
          break;
        }
        case 'clear':
          for (let j = marks.length - 1; j >= 0; j--) if (marks[j].t === op.t) marks.splice(j, 1);
          break;
      }
    }
  }
  return { marks, sprites, background };
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The area the whole run draws in, at least Scratch's 480 × 360 stage, so the view doesn't jump between steps. */
export function drawingBounds(events: TraceEvent[]): Bounds {
  const b = { minX: -240, maxX: 240, minY: -180, maxY: 180 };
  const add = (x: number, y: number) => {
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
  };
  for (const e of events) {
    for (const op of e.draw ?? []) {
      if (op.k === 'mv' || op.k === 'dot' || op.k === 'text' || op.k === 'stamp') add(op.x, op.y);
      if (op.k === 'fill') op.pts.forEach(([x, y]) => add(x, y));
    }
  }
  const pad = 24;
  return { minX: b.minX - pad, maxX: b.maxX + pad, minY: b.minY - pad, maxY: b.maxY + pad };
}
