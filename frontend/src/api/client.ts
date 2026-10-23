import type {
  ExecutionResponse,
  Explanation,
  CodeExplanation,
  ExplainLevel,
  Health,
  JsAnalysis,
  Patch,
  ReaStatus,
  ReaTool,
  ReaToolResult,
  ReaWorkspace,
  TraceEvent,
  Validation,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join('.') || 'request'}: ${d.msg}`)
      .join('; ');
  }
  return JSON.stringify(detail);
}

// ---- access code (hosted deployments) ---------------------------------------
const ACCESS_KEY = 'codelens.access-code';

export function getAccessCode(): string {
  try {
    return localStorage.getItem(ACCESS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAccessCode(code: string) {
  try {
    localStorage.setItem(ACCESS_KEY, code);
  } catch {
    /* storage unavailable: the code lasts for this page only */
  }
  memoryCode = code;
}

let memoryCode = '';
/** Fired when the server rejects the access code, so the app can ask for it. */
export const ACCESS_DENIED_EVENT = 'codelens:access-denied';

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const code = getAccessCode() || memoryCode;
  if (code) h['X-CodeLens-Access'] = code;
  return h;
}

function checkAccess(resp: Response) {
  if (resp.status === 401) window.dispatchEvent(new Event(ACCESS_DENIED_EVENT));
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      method,
      headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the CodeLens backend. Is it running on port 8000?', 0);
  }
  if (!resp.ok) {
    checkAccess(resp);
    let message = `${resp.status} ${resp.statusText}`;
    try {
      const data = await resp.json();
      if (data?.detail !== undefined) message = formatDetail(data.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, resp.status);
  }
  return resp.json() as Promise<T>;
}

export interface StreamedExecution {
  summary: ExecutionResponse;
  events: TraceEvent[];
}

/** Run code via the SSE endpoint (spec §1.4: REST API / JSON / SSE). */
export interface RunInput {
  source: string;
  files: Record<string, string>;
  stdin: string;
}

export async function runStreaming(
  input: RunInput,
  timeoutSeconds: number,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<StreamedExecution> {
  let resp: Response;
  try {
    resp = await fetch('/api/v1/executions/stream', {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({
        source_code: input.source,
        files: input.files,
        stdin: input.stdin,
        limits: { timeout_seconds: timeoutSeconds },
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the CodeLens backend. Is it running on port 8000?', 0);
  }
  if (!resp.ok || !resp.body) {
    checkAccess(resp);
    let message = `${resp.status} ${resp.statusText}`;
    try {
      message = formatDetail((await resp.json()).detail);
    } catch {
      /* ignore */
    }
    throw new ApiError(message, resp.status);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const events: TraceEvent[] = [];
  let total = 0;
  let summary: ExecutionResponse | null = null;
  let buffer = '';

  const handle = (block: string) => {
    let name = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n'));
    if (name === 'init') total = payload.total_steps;
    else if (name === 'step') {
      events.push(payload as TraceEvent);
      if (events.length % 50 === 0) onProgress?.(events.length, total);
    } else if (name === 'complete') summary = payload as ExecutionResponse;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      handle(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  if (buffer.trim()) handle(buffer);
  if (!summary) throw new ApiError('Execution stream ended unexpectedly', 0);
  onProgress?.(events.length, total);
  return { summary, events };
}

export const api = {
  health: () => request<Health>('GET', '/health'),
  explainCode: (sourceCode: string, level: ExplainLevel) =>
    request<CodeExplanation>('POST', '/api/v1/explain-code', { source_code: sourceCode, level }),
  testTemplate: (executionId: string) =>
    request<{ tests: string }>('GET', `/api/v1/executions/${executionId}/test-template`).then((r) => r.tests),
  deleteExecution: (executionId: string) => request<{ deleted: boolean }>('DELETE', `/api/v1/executions/${executionId}`),
  checkAccess: () => request<{ ok: boolean }>('GET', '/api/v1/access'),
  explain: (executionId: string, step: number | null, question: string | null) =>
    request<Explanation>('POST', '/api/v1/explanations', { execution_id: executionId, step, question }),
  createPatch: (executionId: string, explanationId: string | null, diff?: string) =>
    request<Patch>('POST', '/api/v1/patches', { execution_id: executionId, explanation_id: explanationId, diff }),
  validatePatch: (patchId: string, tests: string | null) =>
    request<Validation>('POST', '/api/v1/patches/validate', { patch_id: patchId, tests }),

  reaStatus: (refresh = false) => request<ReaStatus>('GET', `/api/v1/rea/status${refresh ? '?refresh=true' : ''}`),
  reaWorkspace: () => request<ReaWorkspace>('GET', '/api/v1/rea/workspace'),
  reaAnalyzeJs: (path: string, artifactFormat: string) =>
    request<JsAnalysis>('POST', '/api/v1/rea/javascript', { path, artifact_format: artifactFormat }),
  reaTools: () => request<{ count: number; tools: ReaTool[] }>('GET', '/api/v1/rea/tools'),
  reaTool: (name: string) => request<ReaTool>('GET', `/api/v1/rea/tools/${encodeURIComponent(name)}`),
  reaCallTool: (name: string, args: Record<string, unknown>) =>
    request<ReaToolResult>('POST', '/api/v1/rea/tools/call', { name, arguments: args }),
};
