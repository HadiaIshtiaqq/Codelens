// Mirrors backend/app/schemas.py (spec §3.2, §4.2).
import type { DrawOp } from '../lib/turtle';

export type TraceEventType = 'call' | 'line' | 'return' | 'exception' | 'stdout' | 'exit';
export type ExecutionStatus = 'queued' | 'running' | 'completed' | 'timed_out' | 'failed' | 'cancelled';
export type PatchStatus = 'proposed' | 'validated' | 'failed' | 'untested';

export interface BaseTraceEvent {
  execution_id: string;
  step: number;
  event: TraceEventType;
  file: string;
  line: number;
  function: string;
  locals: Record<string, string>;
  local_types?: Record<string, string>;
  stack_depth: number;
  /** Long runs: number of steps omitted just before this one. */
  skipped_before?: number;
  /** Long runs: line tracing paused before this step (the program kept running). */
  untraced_before?: boolean;
  /** One-line plain-English explanation of this step (AST + recorded values). */
  narration?: string;
  /** The same step explained for a young beginner (Kids mode). */
  kid_narration?: string;
  /** The programming idea this step shows, e.g. 'variable', 'for-loop' (Kids mode idea cards). */
  concept?: string;
  viz?: VizSnapshot;
  /** turtle drawing ops made while this line ran (see lib/turtle.ts). */
  draw?: DrawOp[];
}

// ---- Visual snapshot (frames + heap with object identity) -----------------

export type VizValue = { p: string; t: string } | { r: string };

export interface VizFrame {
  id: string;
  file?: string;
  function: string;
  line: number;
  locals: [string, VizValue][];
  return_value?: VizValue;
}

export interface HeapObject {
  kind: 'list' | 'tuple' | 'set' | 'dict' | 'instance' | 'function' | 'class' | 'other';
  type: string;
  items?: VizValue[];
  entries?: [VizValue, VizValue][];
  attrs?: [string, VizValue][];
  label?: string;
  more?: number;
}

export interface VizSnapshot {
  stack: VizFrame[];
  heap: Record<string, HeapObject>;
  hidden_frames: number;
}

export interface CallTraceEvent extends BaseTraceEvent {
  event: 'call';
  arg_names?: string[];
}
export interface LineTraceEvent extends BaseTraceEvent {
  event: 'line';
}
export interface ReturnTraceEvent extends BaseTraceEvent {
  event: 'return';
  return_value: string;
}
export interface ExceptionTraceEvent extends BaseTraceEvent {
  event: 'exception';
  exception: { type: string; message: string; traceback_line: number };
}
export interface StdoutTraceEvent extends BaseTraceEvent {
  event: 'stdout';
  stdout_chunk: string;
}
export interface ExitTraceEvent extends BaseTraceEvent {
  event: 'exit';
  exit_code: number;
}

export type TraceEvent =
  | CallTraceEvent
  | LineTraceEvent
  | ReturnTraceEvent
  | ExceptionTraceEvent
  | StdoutTraceEvent
  | ExitTraceEvent;

export interface ErrorInfo {
  type: string;
  message: string;
  line: number;
  file?: string;
}

export interface ExecutionResponse {
  execution_id: string;
  status: ExecutionStatus;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error: ErrorInfo | null;
  trace_available: boolean;
  total_steps: number;
  trace_truncated: boolean;
  output_truncated: boolean;
  duration_ms: number;
  /** Static one-line explanation per source line (keys are line numbers). */
  line_notes: Record<string, string>;
  /** line_notes for every file in the project. */
  file_line_notes?: Record<string, Record<string, string>>;
  /** Long runs: steps dropped from the middle, and whether tracing stopped early. */
  omitted_steps?: number;
  recording_stopped?: boolean;
}

export interface Explanation {
  explanation_id: string;
  execution_id: string;
  step: number | null;
  summary: string;
  observed_facts: string[];
  likely_cause: string | null;
  suggested_next_step: string | null;
  cited_lines: number[];
  provider: string;
  model: string | null;
  degraded: boolean;
  provider_error: string | null;
  grounding_warnings: string[];
}

export interface Patch {
  patch_id: string;
  execution_id: string;
  status: PatchStatus;
  diff: string;
  patched_source: string;
  rationale: string;
  provider: string;
  requires_validation: boolean;
  degraded: boolean;
  provider_error: string | null;
}

export interface TestCaseResult {
  name: string;
  outcome: 'passed' | 'failed' | 'error' | 'skipped';
  message: string;
  line: number | null;
  duration_ms: number | null;
}

export interface RunSummary {
  status: ExecutionStatus;
  exit_code: number | null;
  error: ErrorInfo | null;
  stdout: string;
  stderr: string;
}

export interface Validation {
  patch_id: string;
  status: PatchStatus;
  tests_passed: number;
  tests_failed: number;
  tests: TestCaseResult[];
  output: string;
  smoke: RunSummary;
  baseline: { status: string; tests_passed: number; tests_failed: number; collection_error: boolean } | null;
  runner?: string;
}

export interface Health {
  status: string;
  sandbox: string;
  llm_provider: string;
  llm_model: string;
  features?: { rea_ui: boolean; convert: boolean; access_code_required?: boolean };
}

export interface CodeExplanation {
  ok: boolean;
  intro: string;
  outline: { line: number; depth: number; text: string }[];
  /** Plain explanation for each line that has code (keys are line numbers). */
  line_notes: Record<string, string>;
}

export interface Conversion {
  detected_language: string;
  target_language: string;
  converted_code: string;
  notes: string[];
  syntax_checked: boolean;
  provider: string;
  model: string | null;
}

// ---- REA ----------------------------------------------------------------

export interface ReaCheck {
  name: string;
  ok: boolean;
  classification: string | null;
  detail: string | null;
  remediation: string | null;
}

export interface ReaStatus {
  command: string[];
  workspace_root: string;
  allow_any_path: boolean;
  allow_destructive: boolean;
  healthy: boolean | null;
  checks: ReaCheck[];
}

export interface ReaWorkspace {
  root: string;
  entries: { path: string; is_dir: boolean; size: number | null }[];
}

export interface JsAnalysis {
  result_id: string;
  evidence_id: string;
  application: { name?: string; version?: string; main?: string };
  confidence: string | null;
  authority: string | null;
  summary: Record<string, unknown> | null;
  statistics: Record<string, number> | null;
  entrypoints: { type: string; path: string; mechanism: string | null }[];
  modules: { path: string; format: string | null }[];
  external_modules: string[];
  ipc_channels: { channel: string; kind: string; side: string | null; operation: string | null; location: string | null }[];
  context_bridge_apis: { api: string; world: string | null; location: string | null }[];
  native_addons: { kind: string; label: string; location: string | null }[];
  node_kinds: Record<string, number>;
  nodes: { kind: string; label: string | null; source: string | null; line: number | null }[];
  coverage: Record<string, unknown> | null;
  limitations: string[];
}

export interface ReaTool {
  name: string;
  description: string;
  read_only: boolean;
  destructive: boolean;
  open_world: boolean;
  allowed: boolean;
  input_schema?: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema & { description?: string; default?: unknown; enum?: unknown[] }>;
  required?: string[];
  [key: string]: unknown;
}

export interface ReaToolResult {
  tool: string;
  is_error: boolean;
  structured: unknown;
  content: { type: string; value: unknown }[];
  duration_ms: number;
}
