# Learning from Scratch with REA: the turtle drawing stage

Kids who start with Scratch expect to *see* their code draw. CodeLens now has a turtle
drawing stage, built from scratch. To design it, we first used REA, the reverse-engineering
toolkit bundled with this project, to study how Scratch's own engine does pen drawing and motion.

## What we analysed

Scratch's engine is open source (`scratch-vm`, BSD-3-Clause). We downloaded the published package
into the REA workspace and ran REA's JavaScript application analyser on the two parts that
matter for drawing:

```
cd rea-workspace
npm pack scratch-vm && mkdir scratch-vm-pkg && tar -xzf scratch-vm-*.tgz -C scratch-vm-pkg
../rea/node_modules/.bin/rea analyze-javascript-application scratch-vm-pkg/package/src/extensions/scratch3_pen
mkdir scratch-motion && cp scratch-vm-pkg/package/src/blocks/scratch3_motion.js scratch-motion/
../rea/node_modules/.bin/rea analyze-javascript-application scratch-motion
```

| Target | REA evidence id | Graph |
|---|---|---|
| `extensions/scratch3_pen` | `ev_a0b0891bfdb665ccd0f592edf80c894b43cc9b7a09be07fc25e3ca05d6e5a8e8` | 32 functions, 110 call sites |
| `blocks/scratch3_motion.js` | `ev_cd6e09e4336c466940e2ba3e6a6554ffc77f28c44515fcab87cf22c711d568cc` | 32 functions, 84 call sites |

(The whole 25 MB package was too large to analyse in one go, so we pointed REA at the two
folders that hold the drawing logic. The package itself is not committed; the commands above
fetch it again.)

## What REA showed us

From the property slots and call sites in REA's semantic graph:

- **Pen state lives on each sprite:** `penState`, `penDown`, `color`, `saturation`, `brightness`,
  `transparency` and `diameter`, with `DEFAULT_PEN_STATE`, `getCustomState`/`setCustomState`.
  Colour is handled in HSV (`rgbToHsv`, `hsvToRgb`) and hue wraps around (`wrapClamp`).
- **Drawing is driven by movement:** the pen extension listens for `EVENT_TARGET_MOVED`
  (`addListener`/`removeListener`) and draws a line from the old position to the new one only
  while the pen is down.
- **Motion:** `setXY`, `setDirection`, `degToRad`/`radToDeg`, glides that interpolate from
  `startX/startY` to `endX/endY` over a `duration` with a `timer`, and `keepInFence`
  (sprites stay on a 480 × 360 stage with (0, 0) in the middle).

## What we built (our own code, nothing copied)

| Scratch idea | CodeLens design |
|---|---|
| Pen state on each sprite; lines drawn when a moved sprite has its pen down | `backend/worker/tracer.py` ships a stand-in `turtle` module. Each `Turtle` keeps its own pen state, and every move records a small op (`mv` with position, heading, pen down, colour and width) |
| The "target moved" event | Ops are attached to the trace event of the line that made them, so the drawing replays step by step with the code |
| 480 × 360 stage, centre origin | `frontend/src/lib/turtle.ts` fits the whole run's drawing into at least a 480 × 360 view, so the picture doesn't jump between steps |
| Glide with a duration | `TurtleStage.tsx` animates the newest step: lines grow over 450 ms while the 🐢 glides to its new position |
| Per-sprite clear and stamp | `clear()`, `stamp()`, `dot()`, `write()`, `begin_fill()`/`end_fill()` and several turtles at once |

Python's own turtle rules win where the two differ: heading 0 points east and `left()` turns
anticlockwise, so programs behave exactly as they do in desktop Python.

Robo explains every drawing step in plain words ("🐢 Walk forward 150 steps.", "✋ Lift the pen:
now the turtle walks without drawing."), and Kids mode has three new starters: a square, a
star and a rainbow spiral. See `backend/tests/test_turtle.py` and the end-to-end check
"kids: the turtle draws step by step".
