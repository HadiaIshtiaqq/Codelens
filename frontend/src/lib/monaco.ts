// Bundle Monaco locally instead of loading it from a CDN (works offline / behind firewalls).
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { loader } from '@monaco-editor/react';

// Language services (used when the Code Converter shows JavaScript, TypeScript, JSON, …) need their own workers.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    if (label === 'json') return new JsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker();
    return new EditorWorker();
  },
};

loader.config({ monaco });
// Exposed for end-to-end tests and debugging in the browser console.
(window as unknown as { monaco: typeof monaco }).monaco = monaco;

monaco.editor.defineTheme('codelens-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0b1220',
    'editorGutter.background': '#0b1220',
    'editor.lineHighlightBackground': '#ffffff08',
  },
});

export { monaco };
