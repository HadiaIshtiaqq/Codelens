"""CodeLens AI trace worker.

Runs INSIDE the sandbox (Docker container or isolated subprocess), never in the
API process. Standard library only, so the worker image needs nothing but Python.

Protocol:
  stdin  <- one JSON payload: {execution_id, source, max_events, timeout_seconds,
            nonce, memory_limit_bytes?}
  stdout -> worker result as a single line: <nonce><json>\n
The nonce lets the parent find the real result even if user code writes to fd 1
directly (os.write) and bypasses the captured sys.stdout.
"""

import builtins
import collections
import importlib.abc
import importlib.util
import io
import json
import linecache
import os
import sys
import tempfile
import threading
import time
import traceback
import types

USER_FILE = "main.py"
TEST_FILE = "test_main.py"
# main.py plus any extra project files sent with the job (filled in by main()).
USER_FILES = {USER_FILE}
HEAD_FRACTION = 0.3  # share of the event cap kept from the start of the run; the rest is the most recent events
DEFAULT_TRACE_BUDGET = 20_000  # stop tracing (but keep running) after this many recorded events
OUTPUT_CAP_BYTES = 4 * 1024 * 1024  # FR-07: 4 MiB combined stdout + stderr
TRUNCATION_MARKER = "\n[STDOUT TRUNCATED AT 4 MiB]\n"
MAX_VALUE_CHARS = 1000  # hard ceiling on any single rendered variable
MAX_LOCALS_PER_EVENT = 50
TIMED_OUT_EXIT_CODE = 124


# --------------------------------------------------------------------------- #
# Serialization guard (spec §4.3.3)
# --------------------------------------------------------------------------- #

def safe_value(val, max_len=100, max_items=20, max_depth=2, _seen=None):
    """Render an arbitrary Python object as a bounded string.

    Never calls user-defined __repr__/__str__/__getattr__, so a hostile or
    broken object cannot crash or hang the tracer through serialization.
    """
    rendered = _render(val, max_len, max_items, max_depth, set() if _seen is None else _seen)
    if len(rendered) > MAX_VALUE_CHARS:
        rendered = rendered[: MAX_VALUE_CHARS - 3] + "..."
    return rendered


def _render(val, max_len, max_items, max_depth, seen):
    val_id = id(val)
    if val_id in seen:
        return "<CircularReference>"

    try:
        if val is None or isinstance(val, (bool, float)):
            return repr(val)
        if isinstance(val, int):
            if val.bit_length() > 256:
                return f"<int with {val.bit_length()} bits>"
            return repr(int(val))
        if isinstance(val, str):
            if len(val) > max_len:
                return repr(str(val[:max_len])) + f"... (+{len(val) - max_len} chars)"
            return repr(str(val))
        if isinstance(val, (bytes, bytearray)):
            head = bytes(val[:max_len])
            suffix = f"... (+{len(val) - max_len} bytes)" if len(val) > max_len else ""
            return repr(head) + suffix
        if isinstance(val, type):
            return f"<class {val.__name__}>"
        if isinstance(val, types.ModuleType):
            return f"<module {val.__name__}>"
        if isinstance(val, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
            return f"<function {getattr(val, '__qualname__', '?')}>"
        if isinstance(val, (types.GeneratorType, types.CoroutineType)):
            return f"<{type(val).__name__} {val.__qualname__}>"

        if max_depth <= 0:
            return f"<{type(val).__name__} instance>"

        seen.add(val_id)
        try:
            if isinstance(val, (list, tuple, set, frozenset)):
                if isinstance(val, list):
                    open_, close = "[", "]"
                elif isinstance(val, tuple):
                    open_, close = "(", ")"
                else:
                    if not val:
                        return f"{type(val).__name__}()"
                    open_, close = "{", "}"
                parts = []
                for i, item in enumerate(val):
                    if i >= max_items:
                        parts.append(f"... +{len(val) - max_items} more")
                        break
                    parts.append(_render(item, max_len, max_items, max_depth - 1, seen))
                if isinstance(val, tuple) and len(val) == 1:
                    parts[0] += ","
                return open_ + ", ".join(parts) + close

            if isinstance(val, dict):
                parts = []
                for i, (k, v) in enumerate(val.items()):
                    if i >= max_items:
                        parts.append(f"... +{len(val) - max_items} keys")
                        break
                    key = _render(k, 20, max_items, 1, seen)
                    parts.append(f"{key}: {_render(v, max_len, max_items, max_depth - 1, seen)}")
                return "{" + ", ".join(parts) + "}"

            # Well-known numeric libraries have trustworthy, bounded reprs (e.g. numpy arrays).
            module = getattr(type(val), "__module__", "") or ""
            if module.split(".")[0] in ("numpy", "pandas", "decimal", "fractions", "datetime", "collections", "codelens_turtle"):
                text = repr(val)
                return text if len(text) <= MAX_VALUE_CHARS else text[: MAX_VALUE_CHARS - 3] + "..."

            # Custom instance: read __dict__ without triggering user __getattr__.
            name = type(val).__name__
            try:
                attrs = object.__getattribute__(val, "__dict__")
            except Exception:
                attrs = None
            if isinstance(attrs, dict) and attrs:
                return f"<{name} {_render(attrs, max_len, max_items, max_depth - 1, seen)}>"
            return f"<{name} object>"
        finally:
            seen.discard(val_id)
    except Exception as err:  # noqa: BLE001 - serialization must never raise
        return f"<SerializationError: {type(err).__name__}>"


# --------------------------------------------------------------------------- #
# Recorder
# --------------------------------------------------------------------------- #

class Recorder:
    def __init__(self, execution_id, max_events, result_fd, nonce, trace_budget=DEFAULT_TRACE_BUDGET):
        self.execution_id = execution_id
        self.max_events = max_events
        self.result_fd = result_fd
        self.nonce = nonce
        # Long runs keep the first events and the most recent ones, so a crash at the end
        # of a long loop is still visible. Steps are renumbered when the result is emitted.
        self.head_size = max(1, int(max_events * HEAD_FRACTION))
        self.head = []
        self.tail = collections.deque(maxlen=max(1, max_events - self.head_size))
        self.omitted = 0
        self.recorded = 0
        self.trace_budget = trace_budget
        self.recording_stopped = False
        self._marked_untraced = False
        self._lock = threading.Lock()
        self.trace_truncated = False
        self.frozen = False
        self.stdout_parts = []
        self.stderr_parts = []
        self.output_bytes = 0
        self.output_truncated = False
        self.started = time.monotonic()
        self._emit_lock = threading.Lock()
        self._emitted = False
        self.extra = {}  # mode-specific result fields, also emitted on timeout

    # -- trace events ------------------------------------------------------- #

    def _base_event(self, frame, event):
        return {
            "execution_id": self.execution_id,
            "step": self.recorded,
            "event": event,
            "file": frame.f_code.co_filename if frame is not None else USER_FILE,
            # f_lineno is 0 on a module's initial "call" event in Python 3.12+.
            "line": (frame.f_lineno or frame.f_code.co_firstlineno) if frame is not None else 0,
            "function": frame.f_code.co_name if frame is not None else "<module>",
            "locals": {},
            "stack_depth": _user_stack_depth(frame),
        }

    def _has_room(self):
        if self.frozen or self.recording_stopped:
            return False
        if self.recorded >= self.trace_budget:
            self.recording_stopped = True
            self.trace_truncated = True
            return False
        return True

    def _append(self, ev):
        if self.recording_stopped and not self._marked_untraced:
            ev["untraced_before"] = True  # line tracing paused before this event; the program kept running
            self._marked_untraced = True
        with self._lock:
            if len(self.head) < self.head_size:
                self.head.append(ev)
            else:
                if len(self.tail) == self.tail.maxlen:
                    self.omitted += 1
                    self.trace_truncated = True
                self.tail.append(ev)
            self.recorded += 1

    def last(self):
        """Most recently recorded event, or None."""
        if self.tail:
            return self.tail[-1]
        return self.head[-1] if self.head else None

    def snapshot_events(self):
        """Head + tail, renumbered 0..n-1; the first tail event says how many steps were skipped."""
        events = list(self.head) + list(self.tail)
        for i, ev in enumerate(events):
            ev["step"] = i
        if self.omitted and self.tail:
            self.tail[0]["skipped_before"] = self.omitted
        return events

    def record_frame(self, frame, event, arg):
        """Record a call/line/return/exception event. Returns False once the cap is hit."""
        if not self._has_room():
            return False
        ev = self._base_event(frame, event)
        ev["locals"], ev["local_types"] = _snapshot_locals(frame)
        ev["viz"] = viz_snapshot(frame, arg if event == "return" else _NO_VALUE)
        if event == "call" and frame.f_code.co_argcount:
            ev["arg_names"] = list(frame.f_code.co_varnames[: frame.f_code.co_argcount])
        elif event == "return":
            ev["return_value"] = safe_value(arg)
        elif event == "exception":
            exc_type, exc_value, _tb = arg
            ev["exception"] = {
                "type": exc_type.__name__,
                "message": _exc_message(exc_value),
                "traceback_line": frame.f_lineno,
            }
        self._append(ev)
        return True

    def record_crash(self, exc):
        """After tracing stopped, rebuild the final exception event from the traceback,
        whose innermost user frame still holds the variables at the moment of the crash."""
        tb, frame = exc.__traceback__, None
        while tb is not None:
            if tb.tb_frame.f_code.co_filename in USER_FILES:
                frame, lineno = tb.tb_frame, tb.tb_lineno
            tb = tb.tb_next
        if frame is None or self.frozen:
            return
        ev = self._base_event(frame, "exception")
        ev["line"] = lineno
        ev["locals"], ev["local_types"] = _snapshot_locals(frame)
        ev["viz"] = viz_snapshot(frame)
        ev["exception"] = {"type": type(exc).__name__, "message": _exc_message(exc), "traceback_line": lineno}
        self._append(ev)

    def record_exit(self, exit_code, last_line):
        if self.frozen:
            return
        # The exit event is always recorded, even past the step cap.
        ev = self._base_event(None, "exit")
        ev["line"] = last_line
        ev["stack_depth"] = 0
        ev["exit_code"] = exit_code
        self._append(ev)

    # -- bounded output (FR-07) -------------------------------------------- #

    def write_output(self, stream, text):
        if self.frozen or not text:
            return
        if self.output_truncated:
            return
        data = text.encode("utf-8", "replace")
        remaining = OUTPUT_CAP_BYTES - self.output_bytes
        if len(data) > remaining:
            text = data[:remaining].decode("utf-8", "ignore")
            self.output_truncated = True
        self.output_bytes += len(text.encode("utf-8"))
        (self.stdout_parts if stream == "stdout" else self.stderr_parts).append(text)
        if self.output_truncated:
            self.stderr_parts.append(TRUNCATION_MARKER)

        if stream == "stdout" and text:
            frame = _innermost_user_frame()
            line = frame.f_lineno if frame is not None else 0
            last = self.last()
            if last and last["event"] == "stdout" and last["line"] == line:
                last["stdout_chunk"] += text  # print() writes text and "\n" separately
                return
            # Output is recorded even after line tracing stopped (it costs no tracing), so the
            # end of a long run stays visible.
            if self.frozen:
                return
            self._has_room()  # updates recording_stopped
            ev = self._base_event(frame, "stdout")
            ev["stdout_chunk"] = text
            self._append(ev)

    # -- result emission ---------------------------------------------------- #

    def emit(self, status, exit_code, error, **extra):
        """Write the result exactly once (main thread or deadline timer)."""
        with self._emit_lock:
            if self._emitted:
                return
            self._emitted = True
            self.frozen = True
            with self._lock:
                events = self.snapshot_events()
            result = {
                **extra,
                "status": status,
                "exit_code": exit_code,
                "stdout": "".join(self.stdout_parts),
                "stderr": "".join(self.stderr_parts),
                "output_truncated": self.output_truncated,
                "error": error,
                "events": events,
                "trace_truncated": self.trace_truncated,
                "omitted_steps": self.omitted,
                "recording_stopped": self.recording_stopped,
                "duration_ms": round((time.monotonic() - self.started) * 1000, 1),
            }
            line = (self.nonce + json.dumps(result, ensure_ascii=True) + "\n").encode("ascii")
            view = memoryview(line)
            while view:
                written = os.write(self.result_fd, view)
                view = view[written:]


class CapturedStream(io.TextIOBase):
    """sys.stdout / sys.stderr replacement that routes writes through the recorder."""

    def __init__(self, recorder, name):
        self._recorder = recorder
        self._name = name

    encoding = "utf-8"

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        self._recorder.write_output(self._name, s)
        return len(s)

    def flush(self):
        pass


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# Visual snapshot: frames + heap with object identity (Python Tutor style)
# --------------------------------------------------------------------------- #

VIZ_MAX_FRAMES = 12  # innermost frames shown; older ones are counted in hidden_frames
VIZ_MAX_HEAP_OBJECTS = 60
VIZ_MAX_ITEMS = 30
VIZ_MAX_DEPTH = 5
VIZ_MAX_STR = 60
_NO_VALUE = object()
_PRIMITIVES = (type(None), bool, int, float, complex)


def viz_snapshot(frame, return_value=_NO_VALUE):
    """Structured view of the user's stack and the objects it references.

    Values are either inline primitives {"p": text, "t": type} or references
    {"r": "o<id>"} into `heap`, so the UI can draw arrows and show aliasing
    (two names pointing at the same list). Never calls user __repr__.
    """
    heap = {}

    def enc(value, depth):
        if isinstance(value, _PRIMITIVES):
            if isinstance(value, int) and not isinstance(value, bool) and value.bit_length() > 256:
                return {"p": f"<int {value.bit_length()} bits>", "t": "int"}
            return {"p": repr(value) if not isinstance(value, int) or isinstance(value, bool) else str(int(value)),
                    "t": type(value).__name__}
        if isinstance(value, str):
            text = str(value)
            shown = repr(text[:VIZ_MAX_STR]) + ("…" if len(text) > VIZ_MAX_STR else "")
            return {"p": shown, "t": "str"}
        if isinstance(value, types.ModuleType):
            return {"p": f"module {value.__name__}", "t": "module"}
        rid = f"o{id(value)}"
        if rid in heap:
            return {"r": rid}
        if depth > VIZ_MAX_DEPTH or len(heap) >= VIZ_MAX_HEAP_OBJECTS:
            return {"p": f"<{type(value).__name__}…>", "t": type(value).__name__}
        obj = {"type": type(value).__name__}
        heap[rid] = obj  # register before recursing so cycles become references
        try:
            _fill_heap_object(obj, value, lambda v: enc(v, depth + 1))
        except Exception as err:  # noqa: BLE001
            obj.clear()
            obj.update({"kind": "other", "type": type(value).__name__, "label": f"<{type(err).__name__}>"})
        return {"r": rid}

    chain = []
    f = frame
    while f is not None:
        if f.f_code.co_filename in USER_FILES:
            chain.append(f)
        f = f.f_back
    hidden = max(0, len(chain) - VIZ_MAX_FRAMES)
    chain = chain[:VIZ_MAX_FRAMES][::-1]  # outermost shown frame first

    stack = []
    for f in chain:
        try:
            items = list(f.f_locals.items())
        except Exception:  # noqa: BLE001
            items = []
        locals_ = []
        for name, value in items:
            if not isinstance(name, str) or name.startswith("__"):
                continue
            if len(locals_) >= MAX_LOCALS_PER_EVENT:
                break
            locals_.append([name, enc(value, 0)])
        entry = {
            "id": f"f{id(f)}",
            "file": f.f_code.co_filename,
            "function": f.f_code.co_name,
            "line": f.f_lineno or f.f_code.co_firstlineno,
            "locals": locals_,
        }
        if f is frame and return_value is not _NO_VALUE:
            entry["return_value"] = enc(return_value, 0)
        stack.append(entry)
    return {"stack": stack, "heap": heap, "hidden_frames": hidden}


def _fill_heap_object(obj, value, enc):
    if isinstance(value, (list, tuple, set, frozenset)):
        kind = "list" if isinstance(value, list) else "tuple" if isinstance(value, tuple) else "set"
        seq = list(value) if kind != "set" else list(value)[: VIZ_MAX_ITEMS + 1]
        obj.update(kind=kind, items=[enc(v) for v in seq[:VIZ_MAX_ITEMS]], more=max(0, len(value) - VIZ_MAX_ITEMS))
    elif isinstance(value, dict):
        entries = []
        for i, (k, v) in enumerate(value.items()):
            if i >= VIZ_MAX_ITEMS:
                break
            entries.append([enc(k), enc(v)])
        obj.update(kind="dict", entries=entries, more=max(0, len(value) - VIZ_MAX_ITEMS))
    elif isinstance(value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):
        obj.update(kind="function", label=getattr(value, "__qualname__", "?"))
    elif isinstance(value, type):
        obj.update(kind="class", label=value.__name__)
    elif isinstance(value, (types.GeneratorType, types.CoroutineType)):
        obj.update(kind="other", label=f"{type(value).__name__} {value.__qualname__}")
    else:
        try:
            attrs = object.__getattribute__(value, "__dict__")
        except Exception:  # noqa: BLE001
            attrs = None
        if isinstance(attrs, dict):
            pairs = [[str(k), enc(v)] for k, v in list(attrs.items())[:VIZ_MAX_ITEMS] if isinstance(k, str)]
            obj.update(kind="instance", attrs=pairs, more=max(0, len(attrs) - VIZ_MAX_ITEMS))
        else:
            obj.update(kind="other", label=safe_value(value, max_depth=1))


def _user_stack_depth(frame):
    depth = 0
    while frame is not None:
        if frame.f_code.co_filename in USER_FILES:
            depth += 1
        frame = frame.f_back
    return depth


def _innermost_user_frame():
    frame = sys._getframe(1)
    while frame is not None and frame.f_code.co_filename not in USER_FILES:
        frame = frame.f_back
    return frame


def _snapshot_locals(frame):
    snapshot, types_ = {}, {}
    try:
        items = list(frame.f_locals.items())
    except Exception:  # noqa: BLE001
        return snapshot, types_
    for name, value in items:
        if not isinstance(name, str) or name.startswith("__"):
            continue
        if len(snapshot) >= MAX_LOCALS_PER_EVENT:
            snapshot["..."] = f"+{len(items) - MAX_LOCALS_PER_EVENT} more locals"
            break
        snapshot[name] = safe_value(value)
        types_[name] = type(value).__name__
    return snapshot, types_


def _exc_message(exc_value):
    try:
        msg = BaseException.__str__(exc_value)
    except Exception:  # noqa: BLE001
        msg = "<unprintable exception>"
    return msg if len(msg) <= 500 else msg[:497] + "..."


def _format_user_traceback(exc):
    """Traceback restricted to frames from the submitted program (and its tests)."""
    lines = []
    frames = [fs for fs in traceback.extract_tb(exc.__traceback__) if fs.filename in USER_FILES or fs.filename == TEST_FILE]
    if frames:
        lines.append("Traceback (most recent call last):\n")
        for fs in frames:
            lines.append(f'  File "{fs.filename}", line {fs.lineno}, in {fs.name}\n')
            if fs.line:
                lines.append(f"    {fs.line}\n")
    lines.extend(traceback.format_exception_only(type(exc), exc))
    return "".join(lines)


def _error_info(exc, filename=None):
    """Error type/message plus the innermost user line (in `filename`, or any user file)."""
    wanted = (lambda f: f == filename) if filename else (lambda f: f in USER_FILES)
    if isinstance(exc, SyntaxError):
        line = exc.lineno or 0
        file = exc.filename if exc.filename in USER_FILES or exc.filename == TEST_FILE else USER_FILE
    else:
        user_frames = [fs for fs in traceback.extract_tb(exc.__traceback__) if wanted(fs.filename)]
        line = user_frames[-1].lineno if user_frames else 0
        file = user_frames[-1].filename if user_frames else (filename or USER_FILE)
    return {"type": type(exc).__name__, "message": _exc_message(exc), "line": line, "file": file}


class _MemoryModules(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Makes the job's extra files importable (`import utils` -> utils.py) without touching disk."""

    def __init__(self, files):
        self.sources = {name[:-3]: (name, text) for name, text in files.items()}

    def find_spec(self, fullname, path=None, target=None):
        if fullname in self.sources:
            return importlib.util.spec_from_loader(fullname, self, origin=self.sources[fullname][0])
        return None

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        filename, text = self.sources[module.__name__]
        module.__file__ = filename
        exec(compile(text, filename, "exec"), module.__dict__)


def _install_input(rec, text):
    """input() reads lines from the job's stdin text and echoes them like a terminal would."""
    lines = io.StringIO(text)
    sys.stdin = lines

    def _input(prompt=""):
        if prompt:
            sys.stdout.write(str(prompt))
        line = lines.readline()
        if not line:
            raise EOFError("input() was called, but the Program input box has no more lines")
        value = line.rstrip("\r\n")
        rec.write_output("stdout", value + "\n")
        return value

    builtins.input = _input


# --------------------------------------------------------------------------- #
# turtle: drawing without a window
# --------------------------------------------------------------------------- #
#
# The sandbox has no display, so `import turtle` gets this stand-in. It follows the
# standard turtle rules (origin in the centre, y up, heading 0 = east, left() turns
# anticlockwise) and records every move as a small drawing op on the trace event of the
# line that made it, so the UI can replay the picture step by step.

MAX_DRAW_OPS = 20_000
_COLOR_NAMES_OK = frozenset("abcdefghijklmnopqrstuvwxyz0123456789 ")


def _css_color(args, colormode):
    """turtle colour arguments -> a CSS colour string (names, '#hex', (r, g, b))."""
    if len(args) == 1:
        args = args[0]
        if isinstance(args, str):
            text = args.strip().lower()
            if text.startswith("#") or set(text) <= _COLOR_NAMES_OK:
                return text.replace(" ", "")
            raise ValueError(f"bad color string: {args!r}")
    if isinstance(args, (tuple, list)) and len(args) == 3:
        parts = [float(v) for v in args]
        if colormode == 1.0:
            if not all(0 <= v <= 1 for v in parts):
                raise ValueError(f"bad color sequence: {tuple(args)!r} (colors go from 0 to 1; use colormode(255) for 0-255)")
            parts = [v * 255 for v in parts]
        elif not all(0 <= v <= 255 for v in parts):
            raise ValueError(f"bad color sequence: {tuple(args)!r}")
        return "rgb({},{},{})".format(*(round(v) for v in parts))
    raise ValueError(f"bad color arguments: {args!r}")


def _make_turtle_module(rec):
    import math

    mod = types.ModuleType("turtle")
    mod.__file__ = "<codelens turtle>"
    state = {"ops": 0, "colormode": 1.0, "next_id": 0}

    def record(op):
        if state["ops"] >= MAX_DRAW_OPS:
            rec.extra["drawing_truncated"] = True
            return
        ev = rec.last()
        if ev is None:
            return
        state["ops"] += 1
        ev.setdefault("draw", []).append(op)

    class Turtle:
        # No __dict__: the boxes show the short description below, not the turtle's insides.
        __slots__ = ("_id", "_x", "_y", "_heading", "_down", "_pencolor", "_fillcolor", "_width", "_visible", "_fill")

        def __repr__(self):
            return f"<turtle at ({self._x:.0f}, {self._y:.0f}) facing {self._heading:.0f}°{'' if self._down else ', pen up'}>"

        def __init__(self, shape="classic", visible=True):
            self._id = state["next_id"]
            state["next_id"] += 1
            self._x = self._y = 0.0
            self._heading = 0.0
            self._down = True
            self._pencolor = "black"
            self._fillcolor = "black"
            self._width = 1
            self._visible = visible
            self._fill = None
            record({"k": "new", "t": self._id})

        # -- movement --------------------------------------------------------
        def _move_to(self, x, y):
            x, y = float(x), float(y)
            if self._fill is not None:
                self._fill.append([round(x, 2), round(y, 2)])
            self._x, self._y = x, y
            record({"k": "mv", "t": self._id, "x": round(x, 2), "y": round(y, 2), "h": round(self._heading, 2),
                    "d": self._down, "c": self._pencolor, "w": self._width})

        def forward(self, distance):
            rad = math.radians(self._heading)
            self._move_to(self._x + float(distance) * math.cos(rad), self._y + float(distance) * math.sin(rad))

        def backward(self, distance):
            self.forward(-float(distance))

        def _turn(self, angle):
            self._heading = (self._heading + float(angle)) % 360
            record({"k": "mv", "t": self._id, "x": round(self._x, 2), "y": round(self._y, 2), "h": round(self._heading, 2), "d": False})

        def left(self, angle):
            self._turn(angle)

        def right(self, angle):
            self._turn(-float(angle))

        def goto(self, x, y=None):
            if y is None:
                x, y = x
            self._move_to(x, y)

        def setx(self, x):
            self._move_to(x, self._y)

        def sety(self, y):
            self._move_to(self._x, y)

        def setheading(self, angle):
            self._turn(float(angle) - self._heading)

        def home(self):
            self._move_to(0, 0)
            self.setheading(0)

        def circle(self, radius, extent=None, steps=None):
            radius = float(radius)
            extent = 360.0 if extent is None else float(extent)
            if steps is None:
                steps = max(4, min(120, int(abs(extent) / 6) + 1))
            step_angle = extent / steps
            chord = 2 * radius * math.sin(math.radians(step_angle / 2))
            self._turn(step_angle / 2 if radius >= 0 else -step_angle / 2)
            for i in range(int(steps)):
                rad = math.radians(self._heading)
                self._move_to(self._x + chord * math.cos(rad), self._y + chord * math.sin(rad))
                if i < steps - 1:
                    self._turn(step_angle if radius >= 0 else -step_angle)
            self._turn(step_angle / 2 if radius >= 0 else -step_angle / 2)

        def dot(self, size=None, *color):
            c = _css_color(color, state["colormode"]) if color else self._pencolor
            record({"k": "dot", "x": round(self._x, 2), "y": round(self._y, 2), "r": float(size or max(self._width + 4, self._width * 2)), "c": c})

        def stamp(self):
            record({"k": "stamp", "t": self._id, "x": round(self._x, 2), "y": round(self._y, 2), "h": round(self._heading, 2), "c": self._fillcolor})

        def write(self, arg, move=False, align="left", font=("Arial", 8, "normal")):
            size = font[1] if isinstance(font, (tuple, list)) and len(font) > 1 else 8
            record({"k": "text", "x": round(self._x, 2), "y": round(self._y, 2), "s": str(arg)[:200], "c": self._pencolor, "a": align, "f": size})

        # -- pen ---------------------------------------------------------------
        def penup(self):
            self._down = False

        def pendown(self):
            self._down = True

        def isdown(self):
            return self._down

        def pensize(self, width=None):
            if width is None:
                return self._width
            self._width = max(0.1, float(width))

        def pencolor(self, *args):
            if not args:
                return self._pencolor
            self._pencolor = _css_color(args, state["colormode"])

        def fillcolor(self, *args):
            if not args:
                return self._fillcolor
            self._fillcolor = _css_color(args, state["colormode"])

        def color(self, *args):
            if not args:
                return self._pencolor, self._fillcolor
            if len(args) == 2:
                self.pencolor(args[0])
                self.fillcolor(args[1])
            else:
                self.pencolor(*args)
                self.fillcolor(*args)

        def begin_fill(self):
            self._fill = [[round(self._x, 2), round(self._y, 2)]]

        def end_fill(self):
            if self._fill and len(self._fill) > 2:
                record({"k": "fill", "pts": self._fill[:2000], "c": self._fillcolor})
            self._fill = None

        def filling(self):
            return self._fill is not None

        # -- state -------------------------------------------------------------
        def position(self):
            return (round(self._x, 2), round(self._y, 2))

        def xcor(self):
            return round(self._x, 2)

        def ycor(self):
            return round(self._y, 2)

        def heading(self):
            return round(self._heading, 2)

        def distance(self, x, y=None):
            if y is None:
                x, y = x
            return math.hypot(float(x) - self._x, float(y) - self._y)

        def towards(self, x, y=None):
            if y is None:
                x, y = x
            return math.degrees(math.atan2(float(y) - self._y, float(x) - self._x)) % 360

        def hideturtle(self):
            self._visible = False
            record({"k": "vis", "t": self._id, "v": False})

        def showturtle(self):
            self._visible = True
            record({"k": "vis", "t": self._id, "v": True})

        def isvisible(self):
            return self._visible

        def clear(self):
            record({"k": "clear", "t": self._id})

        def reset(self):
            self.clear()
            self._down, self._pencolor, self._fillcolor, self._width = True, "black", "black", 1
            self.home()

        def speed(self, speed=None):
            return 3 if speed is None else None  # the replay controls the speed

        def shape(self, name=None):
            return "turtle" if name is None else None

        def shapesize(self, *args, **kwargs):
            return None

        def getscreen(self):
            return _screen

        # Short names, as in the standard module.
        fd, bk, back, lt, rt = forward, backward, backward, left, right
        setpos = setposition = goto
        seth = setheading
        pu = up = penup
        pd = down = pendown
        width = pensize
        pos = position
        ht, st = hideturtle, showturtle

    class _Screen:
        def bgcolor(self, *args):
            if args:
                record({"k": "bg", "c": _css_color(args, state["colormode"])})

        def colormode(self, mode=None):
            if mode is None:
                return state["colormode"]
            if mode not in (1, 1.0, 255):
                raise ValueError("colormode must be 1.0 or 255")
            state["colormode"] = 255 if mode == 255 else 1.0

        def _noop(self, *args, **kwargs):
            return None

        setup = title = tracer = update = mainloop = done = exitonclick = bye = listen = onkey = onclick = ontimer = delay = _noop

        def window_width(self):
            return 480

        def window_height(self):
            return 360

    _screen = _Screen()
    _default = []

    def _pen():
        if not _default:
            _default.append(Turtle())
        return _default[0]

    Turtle.__module__ = "codelens_turtle"  # safe_value trusts its short repr
    mod.Turtle = mod.Pen = mod.RawTurtle = Turtle
    mod.Screen = lambda: _screen
    mod.TurtleScreen = _Screen
    for name in ("bgcolor", "colormode", "setup", "title", "tracer", "update", "mainloop", "done", "exitonclick", "bye",
                 "listen", "onkey", "onclick", "ontimer", "delay", "window_width", "window_height"):
        setattr(mod, name, getattr(_screen, name))
    turtle_methods = [n for n in vars(Turtle) if not n.startswith("_")]
    for name in turtle_methods:
        setattr(mod, name, (lambda n: lambda *a, **k: getattr(_pen(), n)(*a, **k))(name))
    mod.__all__ = sorted(set(turtle_methods) | {"Turtle", "Pen", "RawTurtle", "Screen", "bgcolor", "colormode", "done", "mainloop", "exitonclick", "setup", "title", "tracer", "update"})
    return mod


def _install_turtle(rec):
    sys.modules["turtle"] = _make_turtle_module(rec)


def _apply_memory_limit(limit_bytes):
    if not limit_bytes:
        return
    try:
        import resource  # POSIX only; Docker mode relies on cgroups instead
    except ImportError:
        return
    try:
        resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))
    except (ValueError, OSError):
        pass


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main():
    payload = json.loads(sys.stdin.read())
    result_fd = os.dup(1)
    rec = Recorder(
        execution_id=payload["execution_id"],
        max_events=int(payload.get("max_events", 1000)),
        result_fd=result_fd,
        nonce=payload["nonce"],
        trace_budget=int(payload.get("trace_budget", DEFAULT_TRACE_BUDGET)),
    )
    _apply_memory_limit(payload.get("memory_limit_bytes"))
    files = payload.get("files") or {}
    USER_FILES.update(files)
    sys.meta_path.insert(0, _MemoryModules(files))

    # Let tracebacks show source lines without touching the filesystem.
    sources = {USER_FILE: payload["source"], TEST_FILE: payload.get("tests") or "", **files}
    for filename, text in sources.items():
        linecache.cache[filename] = (len(text), None, text.splitlines(True), filename)

    # Deadline watchdog inside the worker: returns partial results on timeout.
    # The parent process still hard-kills the sandbox if this never fires
    # (e.g. user code stuck in a C call that holds the GIL).
    def on_deadline():
        rec.emit("timed_out", TIMED_OUT_EXIT_CODE, {
            "type": "TimeoutError",
            "message": f"execution exceeded {payload['timeout_seconds']}s wall-clock limit",
            "line": rec.last()["line"] if rec.last() else 0,
            "file": rec.last()["file"] if rec.last() else USER_FILE,
        }, **rec.extra)
        os._exit(0)

    timer = threading.Timer(float(payload["timeout_seconds"]), on_deadline)
    timer.daemon = True

    sys.stdout = CapturedStream(rec, "stdout")
    sys.stderr = CapturedStream(rec, "stderr")
    _install_input(rec, payload.get("stdin") or "")  # never blocks: no more lines -> EOFError
    _install_turtle(rec)  # `import turtle` draws into the trace instead of opening a window
    timer.start()

    if payload.get("mode", "trace") == "test":
        if not _run_pytest(rec, payload["source"], payload.get("tests") or "", files):
            _run_tests(rec, payload["source"], payload.get("tests") or "")
    else:
        _run_traced(rec, payload["source"])

    timer.cancel()
    # Skip interpreter teardown: user atexit hooks / non-daemon threads must not run.
    os._exit(0)


def _exit_code_of(exc, rec):
    if exc.code is None:
        return 0
    if isinstance(exc.code, int):
        return exc.code
    rec.write_output("stderr", f"{exc.code}\n")
    return 1


def _run_traced(rec, source):
    try:
        code = compile(source, USER_FILE, "exec")
    except (SyntaxError, ValueError) as exc:
        rec.write_output("stderr", _format_user_traceback(exc))
        rec.emit("completed", 1, _error_info(exc))
        return

    def local_trace(frame, event, arg):
        if rec.frozen or not rec.record_frame(frame, event, arg):
            sys.settrace(None)
            return None
        return local_trace

    def global_trace(frame, event, arg):
        if frame.f_code.co_filename not in USER_FILES:
            return None
        return local_trace(frame, event, arg)

    exit_code, error = 0, None
    sys.settrace(global_trace)
    try:
        exec(code, {"__name__": "__main__", "__file__": USER_FILE, "__builtins__": __builtins__})
    except SystemExit as exc:
        exit_code = _exit_code_of(exc, rec)
    except BaseException as exc:  # noqa: BLE001 - report every user failure
        exit_code = 1
        error = _error_info(exc)
        if rec.recording_stopped:
            rec.record_crash(exc)  # the traced events end earlier; show the actual crash
        rec.write_output("stderr", _format_user_traceback(exc))
    finally:
        sys.settrace(None)

    last = rec.last()
    last_line = error["line"] if error else (last["line"] if last else 0)
    rec.record_exit(exit_code, last_line)
    rec.emit("completed", exit_code, error)


def _run_pytest(rec, source, tests, files):
    """Run the tests with real pytest (fixtures, parametrize, raises...). False if pytest is missing."""
    try:
        import pytest
    except ImportError:
        return False

    results = rec.extra["tests"] = []
    rec.extra["collection_error"] = False
    workdir = tempfile.mkdtemp(prefix="codelens-tests-")
    for name, text in {USER_FILE: source, TEST_FILE: tests, **files}.items():
        with open(os.path.join(workdir, name), "w", encoding="utf-8") as fh:
            fh.write(text)

    class Collector:
        def pytest_runtest_logreport(self, report):
            failed_setup = report.when in ("setup", "teardown") and report.failed
            if report.when != "call" and not failed_setup and not (report.when == "setup" and report.skipped):
                return
            if report.passed:
                outcome = "passed"
            elif report.skipped:
                outcome = "skipped"
            elif report.when == "call":
                outcome = "failed" if getattr(report, "longrepr", None) and "AssertionError" in str(report.longrepr) else "error"
            else:
                outcome = "error"
            message, line = "", None
            if not report.passed:
                crash = getattr(report.longrepr, "reprcrash", None)
                if crash is not None:
                    message = crash.message.split("\n")[0]
                    if message.startswith("AssertionError: "):
                        message = message[len("AssertionError: "):]
                    elif message == "AssertionError":
                        message = "assertion failed"
                    line = crash.lineno if os.path.basename(crash.path) == TEST_FILE else None
                elif isinstance(report.longrepr, tuple):  # skips: (path, lineno, reason)
                    message = str(report.longrepr[-1])
                else:
                    message = str(report.longrepr).strip().splitlines()[-1][:300] if report.longrepr else ""
            results.append({
                "name": report.nodeid.split("::", 1)[-1],
                "outcome": outcome,
                "message": message[:500],
                "line": line,
                "duration_ms": round(report.duration * 1000, 2),
            })

        def pytest_collectreport(self, report):
            if report.failed:
                rec.extra["collection_error"] = True

    previous_cwd = os.getcwd()
    os.chdir(workdir)
    sys.path.insert(0, workdir)
    try:
        code = pytest.main(
            [workdir, "-q", "-p", "no:cacheprovider", "--capture=sys", "--no-header", "-o", "console_output_style=classic"],
            plugins=[Collector()],
        )
    finally:
        os.chdir(previous_cwd)
    failed = sum(1 for r in results if r["outcome"] in ("failed", "error"))
    exit_code = 0 if int(code) == 0 else 1
    if int(code) == 5:  # pytest: no tests collected
        exit_code = 1
    rec.emit("completed", exit_code if not failed else 1, None, runner="pytest", **rec.extra)
    return True


def _run_tests(rec, source, tests):
    """Import the program as module `main`, then run every test_* function in the tests source.

    A minimal pytest-compatible runner (plain functions + assert), so the worker
    image needs nothing beyond the standard library.
    """
    results = rec.extra["tests"] = []
    rec.extra["collection_error"] = False

    module = types.ModuleType("main")
    module.__file__ = USER_FILE
    try:
        exec(compile(source, USER_FILE, "exec"), module.__dict__)
    except BaseException as exc:  # noqa: BLE001
        rec.write_output("stderr", "Error importing main.py:\n" + _format_user_traceback(exc))
        rec.extra["collection_error"] = True
        rec.emit("completed", 1, _error_info(exc), **rec.extra)
        return
    sys.modules["main"] = module

    namespace = {"__name__": "test_main", "__file__": TEST_FILE, "__builtins__": __builtins__}
    try:
        exec(compile(tests, TEST_FILE, "exec"), namespace)
    except BaseException as exc:  # noqa: BLE001
        rec.write_output("stderr", "Error collecting test_main.py:\n" + _format_user_traceback(exc))
        rec.extra["collection_error"] = True
        rec.emit("completed", 1, _error_info(exc, TEST_FILE), **rec.extra)
        return

    for name, fn in list(namespace.items()):
        if not (name.startswith("test") and isinstance(fn, types.FunctionType)):
            continue
        if fn.__code__.co_filename != TEST_FILE:
            continue  # imported helpers, not tests
        started = time.monotonic()
        entry = {"name": name, "outcome": "passed", "message": "", "line": None}
        try:
            fn()
        except AssertionError as exc:
            entry["outcome"] = "failed"
            entry["message"] = _exc_message(exc) or "assertion failed"
            entry["line"] = _error_info(exc, TEST_FILE)["line"] or None
            rec.write_output("stderr", f"FAILED {name}\n" + _format_user_traceback(exc))
        except BaseException as exc:  # noqa: BLE001
            entry["outcome"] = "error"
            entry["message"] = f"{type(exc).__name__}: {_exc_message(exc)}"
            entry["line"] = _error_info(exc, TEST_FILE)["line"] or None
            rec.write_output("stderr", f"ERROR {name}\n" + _format_user_traceback(exc))
        entry["duration_ms"] = round((time.monotonic() - started) * 1000, 2)
        results.append(entry)

    failed = sum(1 for r in results if r["outcome"] != "passed")
    rec.write_output("stdout", f"==== {len(results) - failed} passed, {failed} failed ====\n")
    rec.emit("completed", 1 if failed else 0, None, **rec.extra)


if __name__ == "__main__":
    main()
