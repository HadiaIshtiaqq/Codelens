import { DiffEditor, Editor } from '@monaco-editor/react';
import { useState } from 'react';
import type { Debugger } from '../hooks/useDebugger';
import { PatchBadge } from './StatusBadge';

type Tab = 'explain' | 'diff' | 'tests';

/** AI Explanation & Patch Review view (spec §4.1, FR-05, FR-06). */
export function AIPanel({ dbg, onRevealLine }: { dbg: Debugger; onRevealLine: (line: number) => void }) {
  const [tab, setTab] = useState<Tab>('explain');
  const [question, setQuestion] = useState('');
  const { run, explanation, patch, validation, busy, aiError, step } = dbg;
  const disabled = !run || busy !== null || dbg.stale;

  const tabs: [Tab, string][] = [
    ['explain', 'Explanation'],
    ['diff', patch ? 'Diff Review ●' : 'Diff Review'],
    ['tests', validation ? `Test Results (${validation.status})` : 'Test Results'],
  ];

  return (
    <section className="panel h-full" aria-labelledby="ai-title">
      <div className="flex items-center justify-between border-b border-slate-800 px-2 pt-1.5">
        <h2 id="ai-title" className="sr-only">
          AI explanation and patch review
        </h2>
        <div role="tablist" className="flex gap-1">
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        {patch && <PatchBadge status={patch.status} />}
      </div>

      {aiError && (
        <div role="alert" className="mx-3 mt-2 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-200">
          {aiError}
        </div>
      )}
      {dbg.stale && run && (
        <p className="mx-3 mt-2 text-xs text-yellow-300">The code changed since the last run. Run again to analyse the current version.</p>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'explain' && (
          <div className="space-y-3">
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                dbg.explain(question, step);
              }}
            >
              <input
                className="input min-w-[200px] flex-1"
                placeholder={`Ask about step ${step + 1}… (optional)`}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                aria-label="Question about the execution"
                maxLength={2000}
              />
              <button type="submit" className="btn btn-primary" disabled={disabled}>
                {busy === 'explain' ? 'Thinking…' : `Explain step ${step + 1}`}
              </button>
              {dbg.failStep !== null && (
                <button type="button" className="btn" disabled={disabled} onClick={() => dbg.explain(question, null)}>
                  Explain failure
                </button>
              )}
            </form>

            {!explanation && !busy && (
              <p className="text-sm text-slate-500">
                {run
                  ? 'Explanations are grounded in the recorded trace: observed facts come straight from the tracer, never from the model.'
                  : 'Run the program first.'}
              </p>
            )}

            {explanation && (
              <article className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded bg-slate-800 px-2 py-0.5">
                    {explanation.provider}
                    {explanation.model ? ` · ${explanation.model}` : ''}
                  </span>
                  {explanation.step !== null && <span>about step {explanation.step + 1}</span>}
                  {explanation.degraded && (
                    <span className="rounded bg-yellow-900 px-2 py-0.5 text-yellow-100" title={explanation.provider_error ?? ''}>
                      ⚠ AI provider unavailable, used offline rules
                    </span>
                  )}
                </div>
                <p className="text-base font-medium text-slate-100">{explanation.summary}</p>

                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-300">✔ Observed in trace</h3>
                  <ul className="list-inside list-disc space-y-0.5 text-slate-300">
                    {explanation.observed_facts.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
                {explanation.likely_cause && (
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-orange-300">Likely cause</h3>
                    <p className="text-slate-200">{explanation.likely_cause}</p>
                  </div>
                )}
                {explanation.suggested_next_step && (
                  <div>
                    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-sky-300">Next step</h3>
                    <p className="text-slate-200">{explanation.suggested_next_step}</p>
                  </div>
                )}
                {explanation.cited_lines.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
                    Cited lines:
                    {explanation.cited_lines.map((l) => (
                      <button key={l} className="kbd hover:bg-slate-700" onClick={() => onRevealLine(l)}>
                        L{l}
                      </button>
                    ))}
                  </div>
                )}
                {explanation.grounding_warnings.length > 0 && (
                  <div className="rounded border border-yellow-800 bg-yellow-950/50 p-2 text-xs text-yellow-200">
                    <strong>Grounding check:</strong> the model said things the trace does not support:
                    <ul className="list-inside list-disc">
                      {explanation.grounding_warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  disabled={disabled || !run?.summary.error}
                  onClick={async () => {
                    await dbg.generatePatch();
                    setTab('diff');
                  }}
                >
                  {busy === 'patch' ? 'Generating…' : '🛠 Generate candidate patch'}
                </button>
              </article>
            )}
          </div>
        )}

        {tab === 'diff' && (
          <div className="flex h-full min-h-[260px] flex-col gap-2">
            {!patch ? (
              <div className="space-y-2 text-sm text-slate-500">
                <p>No candidate patch yet.</p>
                <button className="btn btn-primary" disabled={disabled || !run?.summary.error} onClick={() => dbg.generatePatch()}>
                  {busy === 'patch' ? 'Generating…' : '🛠 Generate candidate patch'}
                </button>
                {run && !run.summary.error && <p>The last run succeeded; patches are generated for failing runs.</p>}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded bg-slate-800 px-2 py-0.5">by {patch.provider}</span>
                  {patch.degraded && <span className="rounded bg-yellow-900 px-2 py-0.5 text-yellow-100">⚠ AI provider failed, offline rule used</span>}
                  <span className="text-slate-300">{patch.rationale}</span>
                </div>
                <div className="min-h-[220px] flex-1 overflow-hidden rounded border border-slate-800">
                  <DiffEditor
                    height="100%"
                    language="python"
                    theme="codelens-dark"
                    original={dbg.run?.source ?? ''}
                    modified={patch.patched_source}
                    // Avoid "TextModel got disposed before DiffEditorWidget model got reset" on unmount.
                    keepCurrentOriginalModel
                    keepCurrentModifiedModel
                    options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true, fontSize: 13 }}
                  />
                </div>
                <details className="text-xs">
                  <summary className="cursor-pointer text-slate-400">Unified diff</summary>
                  <pre className="mt-1 overflow-auto rounded bg-slate-950 p-2 font-mono">
                    {patch.diff.split('\n').map((l, i) => (
                      <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-emerald-300' : l.startsWith('-') && !l.startsWith('---') ? 'text-orange-300' : 'text-slate-400'}>
                        {l || ' '}
                      </div>
                    ))}
                  </pre>
                </details>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-primary" onClick={() => setTab('tests')}>
                    🧪 Validate fix against tests
                  </button>
                  <button
                    className="btn"
                    onClick={dbg.applyPatch}
                    title={patch.status !== 'validated' ? 'This patch has not been validated yet' : 'Replace the editor contents'}
                  >
                    {patch.status === 'validated' ? '✔ Apply patch to editor' : 'Apply unvalidated patch to editor'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 'tests' && (
          <div className="flex h-full min-h-[260px] flex-col gap-2">
            <p className="text-xs text-slate-400">
              Tests run with pytest in a fresh sandbox against the <strong>patched</strong> program (imported as <code>main</code>), and against the original for comparison.
              The starter tests come from your last run. A patch is <em>validated</em> only if every test passes.
            </p>
            <div className="min-h-[140px] flex-1 overflow-hidden rounded border border-slate-800">
              <Editor
                height="100%"
                language="python"
                theme="codelens-dark"
                value={dbg.tests}
                onChange={(v) => dbg.setTests(v ?? '')}
                options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false, ariaLabel: 'Test code' }}
              />
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-primary" disabled={!patch || busy !== null} onClick={dbg.validate}>
                {busy === 'validate' ? 'Running tests in sandbox…' : '🧪 Validate fix'}
              </button>
              {!patch && <span className="text-xs text-slate-500">Generate a patch first.</span>}
            </div>

            {validation && (
              <div className="space-y-2 text-sm" aria-live="polite">
                <div className="flex flex-wrap items-center gap-3">
                  <PatchBadge status={validation.status} />
                  <span className="text-emerald-300">✔ {validation.tests_passed} passed</span>
                  <span className="text-orange-300">✖ {validation.tests_failed} failed</span>
                  {validation.runner === 'pytest' && <span className="rounded bg-slate-800 px-1.5 text-xs text-slate-300">pytest</span>}
                  {validation.baseline && (
                    <span className="text-xs text-slate-400">
                      original program: {validation.baseline.collection_error ? 'crashed on import' : `${validation.baseline.tests_passed} passed / ${validation.baseline.tests_failed} failed`}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    patched program run: {validation.smoke.error ? `✖ ${validation.smoke.error.type}` : `✔ exit ${validation.smoke.exit_code}`}
                  </span>
                </div>
                {validation.tests.length > 0 && (
                  <table className="w-full text-left font-mono text-xs">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="py-1">Test</th>
                        <th>Outcome</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validation.tests.map((t) => (
                        <tr key={t.name} className="border-t border-slate-800">
                          <td className="py-1 pr-2">{t.name}</td>
                          <td className={t.outcome === 'passed' ? 'text-emerald-300' : t.outcome === 'skipped' ? 'text-slate-400' : 'text-orange-300'}>
                            {t.outcome === 'passed' ? '✔ passed' : t.outcome === 'failed' ? '✖ failed' : t.outcome === 'skipped' ? '↷ skipped' : '✖ error'}
                          </td>
                          <td className="text-slate-300">
                            {t.message}
                            {t.line ? ` (line ${t.line})` : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <pre className="max-h-48 overflow-auto rounded bg-slate-950 p-2 font-mono text-xs text-slate-300">{validation.output}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
