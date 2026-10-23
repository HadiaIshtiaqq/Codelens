import type { monaco } from './monaco';

// The code editors on the page, so Lexi can find "line 3" on screen and point at it.

type Editor = monaco.editor.IStandaloneCodeEditor;
const editors = new Set<Editor>();

export function registerEditor(editor: Editor): () => void {
  editors.add(editor);
  return () => editors.delete(editor);
}

function visibleEditor(): Editor | null {
  for (const editor of editors) {
    const node = editor.getDomNode();
    if (node && node.offsetParent !== null && node.getBoundingClientRect().width > 0) return editor;
  }
  return null;
}

/**
 * Scroll `line` into view in the visible editor, make it glow for a few seconds, and return where it
 * is on screen (or null if no editor is visible yet).
 */
export function focusLine(line: number): DOMRect | null {
  const editor = visibleEditor();
  const model = editor?.getModel();
  if (!editor || !model || line < 1 || line > model.getLineCount()) return null;
  editor.revealLineInCenterIfOutsideViewport(line);
  const glow = editor.createDecorationsCollection([
    { range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 }, options: { isWholeLine: true, className: 'cl-lexi-line' } },
  ]);
  window.setTimeout(() => glow.clear(), 4000);
  return lineRect(line);
}

/** Where `line` currently is on screen, in viewport coordinates. */
export function lineRect(line: number): DOMRect | null {
  const editor = visibleEditor();
  const node = editor?.getDomNode();
  const model = editor?.getModel();
  if (!editor || !node || !model || line > model.getLineCount()) return null;
  const end = editor.getScrolledVisiblePosition({ lineNumber: line, column: model.getLineMaxColumn(line) });
  if (!end) return null;
  const box = node.getBoundingClientRect();
  const layout = editor.getLayoutInfo();
  const left = box.left + layout.contentLeft;
  const top = box.top + end.top;
  if (top < box.top - 4 || top > box.bottom) return null; // scrolled out of view
  return new DOMRect(left, top, Math.max(0, box.left + end.left - left), end.height);
}
