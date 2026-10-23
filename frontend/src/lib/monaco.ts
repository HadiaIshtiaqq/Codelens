// Bundle Monaco locally instead of loading it from a CDN (works offline / behind firewalls).
// Only Python is edited, so load the editor core, its features (hover, find, folding…) and the Python
// language alone, not the full bundle with every language service (TypeScript's alone is several MB).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

// Only Python is edited, so the basic editor worker is all Monaco needs.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

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
