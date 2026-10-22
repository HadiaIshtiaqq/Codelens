import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, runStreaming } from '../api/client';
import type { ExecutionResponse, Explanation, Patch, TraceEvent, Validation } from '../api/types';
import { EXAMPLES } from '../lib/examples';
import { loadSharedProgram, sourceFromLocation } from '../lib/share';
import { failureStep, testTemplate } from '../lib/trace';

/** Toolbar state machine (spec §4.1: idle, running, steppable, completed). */
export type RunPhase = 'idle' | 'running' | 'steppable' | 'completed' | 'error';

export const MAIN_FILE = 'main.py';
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}\.py$/;

export interface RunData {
  summary: ExecutionResponse;
  events: TraceEvent[];
  // The exact inputs that produced this trace.
  source: string;
  files: Record<string, string>;
  stdin: string;
}

const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const bpKey = (file: string, line: number) => `${file}:${line}`;

export function useDebugger() {
  const [source, setSource] = useState(() => sourceFromLocation() ?? EXAMPLES[0].source);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [activeFile, setActiveFile] = useState(MAIN_FILE);
  const [stdin, setStdin] = useState('');
  const [timeoutSeconds, setTimeoutSeconds] = useState(5);
  const [run, setRun] = useState<RunData | null>(null);
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [tests, setTests] = useState('');
  const [busy, setBusy] = useState<null | 'explain' | 'patch' | 'validate'>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  /** Breakpoints as "file:line" keys. */
  const [breakpoints, setBreakpoints] = useState<Set<string>>(() => new Set());

  const abortRef = useRef<AbortController | null>(null);
  const generatedTests = useRef(''); // last auto-generated test text (replaced on new runs unless edited)

  // Compressed share links (#z=…) decode asynchronously.
  useEffect(() => {
    void loadSharedProgram().then((shared) => {
      if (!shared) return;
      setSource(shared.source);
      setFiles(shared.files);
      setStdin(shared.stdin);
    });
  }, []);

  const total = run?.events.length ?? 0;
  const stale =
    run !== null && (run.source !== source || run.stdin !== stdin || JSON.stringify(run.files) !== JSON.stringify(files));
  const failStep = useMemo(() => (run ? failureStep(run.events, run.summary.error) : null), [run]);

  // ---- files -------------------------------------------------------------------
  const editorValue = activeFile === MAIN_FILE ? source : files[activeFile] ?? '';
  const setEditorValue = useCallback(
    (value: string) => {
      if (activeFile === MAIN_FILE) setSource(value);
      else setFiles((prev) => ({ ...prev, [activeFile]: value }));
    },
    [activeFile],
  );
  /** Add a module; returns an error message, or null on success. */
  const addFile = useCallback(
    (raw: string): string | null => {
      const name = raw.trim().endsWith('.py') ? raw.trim() : `${raw.trim()}.py`;
      if (!MODULE_NAME.test(name)) return 'Use a module name like utils.py (letters, digits, _).';
      if (name === MAIN_FILE || name === 'test_main.py' || name in files) return `${name} already exists or is reserved.`;
      if (Object.keys(files).length >= 10) return 'At most 10 extra files.';
      const module = name.slice(0, -3);
      setFiles((prev) => ({ ...prev, [name]: `# ${name}: import it from main.py with  import ${module}\n\n` }));
      setActiveFile(name);
      return null;
    },
    [files],
  );
  const removeFile = useCallback((name: string) => {
    setFiles((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    setActiveFile((current) => (current === name ? MAIN_FILE : current));
    setBreakpoints((prev) => new Set([...prev].filter((k) => !k.startsWith(`${name}:`))));
  }, []);

  const resetAnalysis = () => {
    setExplanation(null);
    setPatch(null);
    setValidation(null);
    setAiError(null);
  };

  /** Run the project, or `override` (e.g. freshly converted code) as main.py, which also replaces the editor text. */
  const execute = useCallback(
    async (override?: unknown, opts?: { files?: Record<string, string>; stdin?: string }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const submitted = typeof override === 'string' ? override : source;
      if (submitted !== source) setSource(submitted);
      const submittedFiles = opts?.files ?? files;
      const submittedStdin = opts?.stdin ?? stdin;
      setPhase('running');
      setRunError(null);
      setProgress(null);
      resetAnalysis();
      try {
        const result = await runStreaming(
          { source: submitted, files: submittedFiles, stdin: submittedStdin },
          timeoutSeconds,
          (received, totalSteps) => setProgress({ received, total: totalSteps }),
          controller.signal,
        );
        setRun({ ...result, source: submitted, files: submittedFiles, stdin: submittedStdin });
        const fail = failureStep(result.events, result.summary.error);
        // Land on the failure when there is one, otherwise at the start of the trace.
        setStep(fail ?? 0);
        setPhase(result.events.length > 1 ? 'steppable' : 'completed');
        // Starter tests built from this run's real calls; never overwrite tests the user edited.
        const fallback = testTemplate(submitted);
        api
          .testTemplate(result.summary.execution_id)
          .catch(() => fallback)
          .then((generated) => {
            setTests((current) => {
              const untouched = !current.trim() || current === generatedTests.current;
              generatedTests.current = generated;
              return untouched ? generated : current;
            });
          });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setPhase(run ? 'steppable' : 'idle');
          return;
        }
        setRunError(errorText(err));
        setPhase('error');
      } finally {
        setProgress(null);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [source, files, stdin, timeoutSeconds, run],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const goTo = useCallback(
    (target: number) => {
      if (!total) return;
      const next = Math.max(0, Math.min(total - 1, target));
      setStep(next);
      setPhase(next === total - 1 ? 'completed' : 'steppable');
    },
    [total],
  );

  const next = useCallback(() => goTo(step + 1), [goTo, step]);
  const prev = useCallback(() => goTo(step - 1), [goTo, step]);
  const reset = useCallback(() => goTo(0), [goTo]);
  const last = useCallback(() => goTo(total - 1), [goTo, total]);
  const jumpToFailure = useCallback(() => failStep !== null && goTo(failStep), [goTo, failStep]);

  // ---- breakpoints ---------------------------------------------------------------
  const toggleBreakpoint = useCallback(
    (line: number, file?: string) => {
      const key = bpKey(file ?? activeFile, line);
      setBreakpoints((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [activeFile],
  );
  const clearBreakpoints = useCallback(() => setBreakpoints(new Set()), []);
  /** Breakpoint line numbers in one file (for the editor gutter). */
  const breakpointLines = useCallback(
    (file: string) => new Set([...breakpoints].filter((k) => k.startsWith(`${file}:`)).map((k) => Number(k.slice(file.length + 1)))),
    [breakpoints],
  );
  /** A step "hits" a breakpoint when the program is about to run (or crashes on) that line. */
  const hitsBreakpoint = useCallback(
    (i: number) => {
      const ev = run?.events[i];
      return !!ev && (ev.event === 'line' || ev.event === 'exception') && breakpoints.has(bpKey(ev.file ?? MAIN_FILE, ev.line));
    },
    [run, breakpoints],
  );
  /** Continue (F8): run forward to the next breakpoint hit, or to the end. */
  const continueToBreakpoint = useCallback(() => {
    for (let i = step + 1; i < total; i++) if (hitsBreakpoint(i)) return goTo(i);
    goTo(total - 1);
  }, [step, total, hitsBreakpoint, goTo]);
  /** Reverse continue (Shift+F8): back to the previous breakpoint hit, or to the start. */
  const backToBreakpoint = useCallback(() => {
    for (let i = step - 1; i >= 0; i--) if (hitsBreakpoint(i)) return goTo(i);
    goTo(0);
  }, [step, hitsBreakpoint, goTo]);

  const clearRun = useCallback(() => {
    abortRef.current?.abort();
    setRun(null);
    setStep(0);
    setPhase('idle');
    setRunError(null);
    resetAnalysis();
  }, []);

  /** Delete the run (code, trace, explanations, patches) from the server, then forget it locally. */
  const deleteRun = useCallback(async () => {
    if (!run) return;
    try {
      await api.deleteExecution(run.summary.execution_id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        setRunError(errorText(err));
        return;
      }
    }
    clearRun();
  }, [run, clearRun]);

  /** Replace the whole project (examples, converter, shared links). */
  const loadProject = useCallback(
    (main: string, extra: Record<string, string> = {}, input = '') => {
      setSource(main);
      setFiles(extra);
      setStdin(input);
      setActiveFile(MAIN_FILE);
      setBreakpoints(new Set());
      clearRun();
    },
    [clearRun],
  );

  const explain = useCallback(
    async (question: string | null, atStep: number | null) => {
      if (!run) return;
      setBusy('explain');
      setAiError(null);
      try {
        setExplanation(await api.explain(run.summary.execution_id, atStep, question || null));
      } catch (err) {
        setAiError(errorText(err));
      } finally {
        setBusy(null);
      }
    },
    [run],
  );

  const generatePatch = useCallback(async () => {
    if (!run) return;
    setBusy('patch');
    setAiError(null);
    setValidation(null);
    try {
      setPatch(await api.createPatch(run.summary.execution_id, explanation?.explanation_id ?? null));
    } catch (err) {
      setAiError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [run, explanation]);

  const validate = useCallback(async () => {
    if (!patch) return;
    setBusy('validate');
    setAiError(null);
    try {
      const result = await api.validatePatch(patch.patch_id, tests.trim() ? tests : null);
      setValidation(result);
      setPatch({ ...patch, status: result.status, requires_validation: result.status !== 'validated' });
    } catch (err) {
      setAiError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [patch, tests]);

  const applyPatch = useCallback(() => {
    if (patch) {
      setSource(patch.patched_source);
      setActiveFile(MAIN_FILE);
    }
  }, [patch]);

  return {
    source,
    setSource,
    files,
    activeFile,
    setActiveFile,
    editorValue,
    setEditorValue,
    addFile,
    removeFile,
    stdin,
    setStdin,
    loadProject,
    timeoutSeconds,
    setTimeoutSeconds,
    run,
    step,
    total,
    phase,
    progress,
    runError,
    stale,
    failStep,
    execute,
    cancel,
    goTo,
    next,
    prev,
    reset,
    last,
    jumpToFailure,
    breakpoints,
    breakpointLines,
    toggleBreakpoint,
    clearBreakpoints,
    hitsBreakpoint,
    continueToBreakpoint,
    backToBreakpoint,
    clearRun,
    deleteRun,
    explanation,
    patch,
    validation,
    tests,
    setTests,
    busy,
    aiError,
    explain,
    generatePatch,
    validate,
    applyPatch,
  };
}

export type Debugger = ReturnType<typeof useDebugger>;
