import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { registerHoverProvider, setHoverNotes } from '../lib/hover';
import { monaco } from '../lib/monaco';

interface Props {
  /** File name: each file gets its own editor model (and undo history). */
  path?: string;
  value: string;
  onChange: (v: string) => void;
  activeLine: number | null;
  failLine: number | null;
  citedLines: number[];
  onRun: () => void;
  revealRequest?: { line: number; nonce: number } | null;
  /** 'game' swaps the step/failure glyphs for a robot and an explosion. */
  variant?: 'classic' | 'game';
  /** When set, clicking a line reports it (Predict mode). */
  onLineClick?: ((line: number) => void) | null;
  /** One-line explanation shown after the active line. */
  inlineNote?: string | null;
  /** Static explanation for every line (the "explain every line" view). */
  lineNotes?: Record<string, string> | null;
  /** Lines with a breakpoint, and the handler for clicking the gutter to toggle one. */
  breakpoints?: Set<number>;
  onToggleBreakpoint?: (line: number) => void;
  fontSize?: number;
  /** Explanations shown when hovering a line (keywords always get a glossary hover). */
  hoverNotes?: Record<string, string> | null;
}

/** Monaco editor with step / failure line decorations (spec §4.1, FR-03). */
export function CodeEditor({ path = 'main.py', value, onChange, activeLine, failLine, citedLines, onRun, revealRequest, variant = 'classic', onLineClick, inlineNote, lineNotes, breakpoints, onToggleBreakpoint, fontSize = 14, hoverNotes }: Props) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const lineClickRef = useRef(onLineClick);
  lineClickRef.current = onLineClick;
  const toggleBpRef = useRef(onToggleBreakpoint);
  toggleBpRef.current = onToggleBreakpoint;
  const game = variant === 'game';

  useEffect(() => {
    registerHoverProvider();
    setHoverNotes(path, hoverNotes ?? null);
  }, [path, hoverNotes]);

  const onMount: OnMount = (editor) => {
    editorRef.current = editor as unknown as monaco.editor.IStandaloneCodeEditor;
    decorations.current = editor.createDecorationsCollection([]);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
    editor.onMouseDown((e) => {
      const line = e.target.position?.lineNumber;
      if (!line) return;
      if (lineClickRef.current) return lineClickRef.current(line);
      const T = monaco.editor.MouseTargetType;
      const inGutter = [T.GUTTER_GLYPH_MARGIN, T.GUTTER_LINE_NUMBERS, T.GUTTER_LINE_DECORATIONS].includes(e.target.type);
      if (inGutter && toggleBpRef.current) toggleBpRef.current(line);
    });
  };

  useEffect(() => {
    const editor = editorRef.current;
    const coll = decorations.current;
    if (!editor || !coll) return;
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    const range = (line: number) => new monaco.Range(line, 1, line, 1);
    const model = editor.getModel();
    const lineCount = model?.getLineCount() ?? 0;
    // Injected text must sit at a real position: the end of the line.
    const endOf = (line: number) => {
      const col = model!.getLineMaxColumn(line);
      return new monaco.Range(line, col, line, col);
    };
    for (const [key, text] of Object.entries(lineNotes ?? {})) {
      const line = Number(key);
      if (line > lineCount || line === activeLine) continue;
      decos.push({
        range: endOf(line),
        options: { showIfCollapsed: true, after: { content: `   # ${text}`, inlineClassName: 'cl-line-note' } },
      });
    }
    if (activeLine && inlineNote && activeLine <= lineCount) {
      decos.push({
        range: endOf(activeLine),
        // showIfCollapsed: Monaco drops injected text on empty ranges without it.
        options: { showIfCollapsed: true, after: { content: `   ◀ ${inlineNote}`, inlineClassName: 'cl-inline-note' } },
      });
    }
    for (const line of breakpoints ?? []) {
      if (line > lineCount) continue;
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'cl-bp', className: 'cl-bp-line', hoverMessage: { value: 'Breakpoint (click the gutter to remove)' } },
      });
    }
    for (const line of citedLines) {
      decos.push({ range: range(line), options: { isWholeLine: true, className: 'cl-cited-line' } });
    }
    if (failLine) {
      decos.push({
        range: range(failLine),
        options: {
          isWholeLine: true,
          className: 'cl-fail-line',
          glyphMarginClassName: game ? 'cl-boom-glyph' : failLine === activeLine ? 'cl-step-fail-glyph' : 'cl-fail-glyph',
          glyphMarginHoverMessage: { value: 'Exception raised here' },
          overviewRuler: { color: '#f97316', position: monaco.editor.OverviewRulerLane.Full },
        },
      });
    }
    if (activeLine && activeLine !== failLine) {
      decos.push({
        range: range(activeLine),
        options: {
          isWholeLine: true,
          className: 'cl-step-line',
          glyphMarginClassName: game ? 'cl-robot-glyph' : 'cl-step-glyph',
          glyphMarginHoverMessage: { value: 'Current step' },
          overviewRuler: { color: '#3b82f6', position: monaco.editor.OverviewRulerLane.Full },
        },
      });
    } else if (activeLine && activeLine === failLine) {
      decos.push({ range: range(activeLine), options: { isWholeLine: true, className: 'cl-step-line' } });
    }
    coll.set(decos);
    if (activeLine) editor.revealLineInCenterIfOutsideViewport(activeLine);
  }, [activeLine, failLine, citedLines, value, game, inlineNote, lineNotes, breakpoints]);

  useEffect(() => {
    if (revealRequest && editorRef.current) {
      editorRef.current.revealLineInCenter(revealRequest.line);
      editorRef.current.setPosition({ lineNumber: revealRequest.line, column: 1 });
      editorRef.current.focus();
    }
  }, [revealRequest]);

  return (
    <Editor
      height="100%"
      path={path}
      language="python"
      theme="codelens-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={onMount}
      options={{
        fontSize,
        glyphMargin: true,
        lineDecorationsWidth: 16, // room for the breakpoint dot
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
        automaticLayout: true,
        ariaLabel: 'Python source editor. Press Control+Enter to run.',
        renderLineHighlight: 'none',
        readOnly: !!onLineClick, // predict mode: clicks pick a line instead of editing
        hover: { delay: 250 },
      }}
    />
  );
}
