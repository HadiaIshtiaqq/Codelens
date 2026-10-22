import { Editor } from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Conversion } from '../api/types';

export const LANGUAGES = [
  'Python', 'JavaScript', 'TypeScript', 'Java', 'C', 'C++', 'C#', 'Go', 'Rust', 'Ruby', 'PHP', 'Kotlin', 'Swift',
  'Dart', 'Scala', 'R', 'Julia', 'Lua', 'Perl', 'Haskell', 'Elixir', 'MATLAB', 'Visual Basic', 'Bash', 'PowerShell',
  'SQL', 'Pseudocode',
];

/** Monaco syntax-highlighting id for a language name. */
const MONACO_ID: Record<string, string> = {
  Python: 'python', JavaScript: 'javascript', TypeScript: 'typescript', Java: 'java', C: 'c', 'C++': 'cpp',
  'C#': 'csharp', Go: 'go', Rust: 'rust', Ruby: 'ruby', PHP: 'php', Kotlin: 'kotlin', Swift: 'swift', Dart: 'dart',
  Scala: 'scala', R: 'r', Julia: 'julia', Lua: 'lua', Perl: 'perl', Elixir: 'elixir', 'Visual Basic': 'vb',
  Bash: 'shell', PowerShell: 'powershell', SQL: 'sql', MATLAB: 'plaintext', Haskell: 'plaintext', Pseudocode: 'plaintext',
};

const SAMPLE = `// Paste code in any language. Example: JavaScript
function average(scores) {
  let total = 0;
  for (let i = 0; i <= scores.length; i++) {
    total += scores[i];
  }
  return total / scores.length;
}

const grades = [90, 72, 85];
console.log("Average:", average(grades));
`;

export interface ConvertRequest {
  code: string;
  from: string;
  nonce: number;
}

interface Props {
  aiReady: boolean;
  request: ConvertRequest | null;
  onRunPython: (code: string) => void;
}

const message = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Translate code between languages with the AI; Python results can be run and visualised in the debugger. */
export function ConverterView({ aiReady, request, onRunPython }: Props) {
  const [source, setSource] = useState(SAMPLE);
  const [from, setFrom] = useState('auto');
  const [to, setTo] = useState('Python');
  const [result, setResult] = useState<Conversion | null>(null);
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const convert = useCallback(
    async (code = source, src = from, target = to) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setError(null);
      try {
        const res = await api.convert(code, src, target, controller.signal);
        setResult(res);
        setOutput(res.converted_code);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(message(e));
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
        }
      }
    },
    [source, from, to],
  );

  // A conversion requested from the debugger ("this looks like JavaScript, convert it?").
  useEffect(() => {
    if (!request) return;
    setSource(request.code);
    setFrom(LANGUAGES.includes(request.from) ? request.from : 'auto');
    setTo('Python');
    if (aiReady) void convert(request.code, LANGUAGES.includes(request.from) ? request.from : 'auto', 'Python');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  const swap = () => {
    if (!output) return;
    setSource(output);
    setOutput('');
    setResult(null);
    const detected = result?.detected_language;
    const previousSource = from !== 'auto' ? from : detected && LANGUAGES.includes(detected) ? detected : 'Python';
    setFrom(to);
    setTo(previousSource);
  };

  const sourceLang = from === 'auto' ? (result && LANGUAGES.includes(result.detected_language) ? result.detected_language : 'JavaScript') : from;
  const isPython = to === 'Python';

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {!aiReady && (
        <div role="alert" className="rounded-lg border border-yellow-700 bg-yellow-950/60 px-4 py-3 text-sm text-yellow-100">
          <strong>AI is offline.</strong> Code conversion needs the AI model. Add your key to <code>backend\.env</code> as{' '}
          <code className="rounded bg-slate-900 px-1">NEBIUS_API_KEY=…</code> (free key at tokenfactory.nebius.com), then restart CodeLens.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          From
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Source language">
            <option value="auto">✨ Auto-detect</option>
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <button className="btn px-2" onClick={swap} disabled={!output} title="Use the result as the new source" aria-label="Swap languages">
          ⇄
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          To
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Target language">
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" onClick={() => convert()} disabled={!aiReady || busy || !source.trim()}>
          {busy ? '⏳ Converting…' : '🔄 Convert'}
        </button>
        {busy && (
          <button className="btn" onClick={() => abortRef.current?.abort()}>
            Cancel
          </button>
        )}
        {result && (
          <span className="ml-auto flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-slate-800 px-2 py-0.5">detected: {result.detected_language}</span>
            {result.syntax_checked && <span className="rounded bg-emerald-900 px-2 py-0.5 text-emerald-100">✔ valid Python</span>}
            <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-400" title={result.model ?? ''}>
              by {result.provider}
              {result.model ? ` · ${result.model.split('/').pop()}` : ''}
            </span>
          </span>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-2">
        <section className="panel min-h-[300px] overflow-hidden" aria-label="Source code">
          <div className="panel-title">
            <h2>Your code{from === 'auto' ? '' : ` · ${from}`}</h2>
            <span className="font-normal normal-case text-slate-500">paste any language</span>
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              theme="codelens-dark"
              language={MONACO_ID[sourceLang] ?? 'plaintext'}
              value={source}
              onChange={(v) => setSource(v ?? '')}
              options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true, scrollBeyondLastLine: false, ariaLabel: 'Code to convert' }}
            />
          </div>
        </section>

        <section className="panel min-h-[300px] overflow-hidden" aria-label="Converted code">
          <div className="panel-title">
            <h2>{to}</h2>
            <div className="flex gap-2 normal-case tracking-normal">
              <button
                className="btn px-2 py-0.5 text-xs"
                disabled={!output}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(output);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  } catch {
                    /* clipboard unavailable */
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
              {isPython && (
                <button className="btn btn-primary px-2 py-0.5 text-xs" disabled={!output || busy} onClick={() => onRunPython(output)}>
                  🎮 Run &amp; visualize
                </button>
              )}
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
            {busy && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-slate-950/70 text-sm">
                <div className="cl-bob text-4xl">🤖</div>
                Translating to {to}…
              </div>
            )}
            {!output && !busy ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-slate-400">
                <div className="text-4xl">🔄</div>
                <p>Paste code in any language on the left, pick a target and press Convert.</p>
                <p className="text-xs text-slate-500">Convert to Python to watch it run step by step in the game view.</p>
              </div>
            ) : (
              <Editor
                height="100%"
                theme="codelens-dark"
                language={MONACO_ID[to] ?? 'plaintext'}
                value={output}
                onChange={(v) => setOutput(v ?? '')}
                options={{ minimap: { enabled: false }, fontSize: 14, automaticLayout: true, scrollBeyondLastLine: false, ariaLabel: 'Converted code' }}
              />
            )}
          </div>
          {result && result.notes.length > 0 && (
            <ul className="max-h-28 list-inside list-disc overflow-auto border-t border-slate-800 px-3 py-2 text-xs text-slate-300">
              {result.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
