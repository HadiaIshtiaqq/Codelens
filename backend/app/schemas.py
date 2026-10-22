import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.config import get_settings

ExecutionStatus = Literal["queued", "running", "completed", "timed_out", "failed", "cancelled"]
TraceEventType = Literal["call", "line", "return", "exception", "stdout", "exit"]


class ExecutionLimits(BaseModel):
    timeout_seconds: float = Field(default=5.0, gt=0, le=5.0)


MODULE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,40}\.py$")
RESERVED_FILES = {"main.py", "test_main.py"}
MAX_EXTRA_FILES = 10


def validate_files(files: dict[str, str]) -> dict[str, str]:
    """Extra project files: flat module names (utils.py), at most 10, within the size budget."""
    if len(files) > MAX_EXTRA_FILES:
        raise ValueError(f"at most {MAX_EXTRA_FILES} extra files")
    for name in files:
        if not MODULE_NAME.match(name) or name in RESERVED_FILES:
            raise ValueError(f"invalid file name {name!r}: use a module name like utils.py (not main.py)")
    return files


class ExecutionRequest(BaseModel):
    language: Literal["python"] = "python"
    source_code: str = Field(..., min_length=1, description="main.py")
    files: dict[str, str] = Field(default_factory=dict, description="Extra modules, e.g. {'utils.py': '...'}")
    stdin: str = Field(default="", max_length=64 * 1024, description="Text that input() reads, line by line")
    limits: ExecutionLimits = Field(default_factory=ExecutionLimits)
    max_steps: int = Field(default=1000, ge=1, le=1000, description="Trace event cap")

    @field_validator("source_code")
    @classmethod
    def _within_size_limit(cls, value: str) -> str:
        limit = get_settings().max_source_bytes
        if len(value.encode("utf-8")) > limit:
            raise ValueError(f"source_code exceeds {limit // 1024} KB limit")
        return value

    @field_validator("files")
    @classmethod
    def _valid_files(cls, value: dict[str, str]) -> dict[str, str]:
        validate_files(value)
        limit = get_settings().max_source_bytes
        if sum(len(v.encode("utf-8")) for v in value.values()) > limit:
            raise ValueError(f"extra files exceed {limit // 1024} KB in total")
        return value


class ErrorInfo(BaseModel):
    type: str
    message: str
    line: int
    file: str = "main.py"


class ExceptionDetail(BaseModel):
    type: str
    message: str
    traceback_line: int


class TraceEvent(BaseModel):
    """Normalized trace event (spec §3.2). Event-specific fields are omitted when absent."""

    execution_id: str
    step: int
    event: TraceEventType
    file: str
    line: int
    function: str
    locals: dict[str, str]
    stack_depth: int
    arg_names: Optional[list[str]] = None
    return_value: Optional[str] = None
    local_types: Optional[dict[str, str]] = None
    skipped_before: Optional[int] = Field(default=None, description="Steps omitted just before this one (long runs)")
    untraced_before: Optional[bool] = Field(default=None, description="Line tracing paused before this step (long runs)")
    narration: Optional[str] = Field(default=None, description="One-line plain-English explanation of this step")
    viz: Optional[dict[str, Any]] = Field(default=None, description="Frames + heap snapshot for the visual view")
    exception: Optional[ExceptionDetail] = None
    stdout_chunk: Optional[str] = None
    exit_code: Optional[int] = None


class ExecutionResponse(BaseModel):
    execution_id: str
    status: ExecutionStatus
    exit_code: Optional[int]
    stdout: str
    stderr: str
    error: Optional[ErrorInfo]
    trace_available: bool
    total_steps: int
    trace_truncated: bool
    output_truncated: bool
    duration_ms: float
    line_notes: dict[int, str] = Field(default_factory=dict, description="Static one-line explanation per source line")
    file_line_notes: dict[str, dict[int, str]] = Field(default_factory=dict, description="line_notes for every file")
    omitted_steps: int = Field(default=0, description="Steps dropped from the middle of a long run")
    recording_stopped: bool = Field(default=False, description="Tracing stopped early; the program kept running")


class ExplanationRequest(BaseModel):
    execution_id: str
    step: Optional[int] = Field(default=None, ge=0, description="Focus step; defaults to the failure step")
    question: Optional[str] = Field(default=None, max_length=2000)


class ExplanationResponse(BaseModel):
    explanation_id: str
    execution_id: str
    step: Optional[int]
    summary: str
    observed_facts: list[str] = Field(description="Derived deterministically from the trace, never by the model")
    likely_cause: Optional[str]
    suggested_next_step: Optional[str]
    cited_lines: list[int] = Field(default_factory=list)
    provider: str
    model: Optional[str] = None
    degraded: bool = False
    provider_error: Optional[str] = None
    grounding_warnings: list[str] = Field(default_factory=list)


class PatchRequest(BaseModel):
    execution_id: str
    explanation_id: Optional[str] = None
    diff: Optional[str] = Field(
        default=None, max_length=200_000, description="Supply your own unified diff instead of generating one"
    )


PatchStatus = Literal["proposed", "validated", "failed", "untested"]


class PatchResponse(BaseModel):
    patch_id: str
    execution_id: str
    status: PatchStatus
    diff: str
    patched_source: str
    rationale: str
    provider: str
    requires_validation: bool
    degraded: bool = False
    provider_error: Optional[str] = None
    validation: Optional[dict[str, Any]] = None


class ValidateRequest(BaseModel):
    patch_id: str
    tests: Optional[str] = Field(
        default=None,
        max_length=100 * 1024,
        description="Python test module: test_* functions using assert; `from main import ...` imports the patched program",
    )
    timeout_seconds: float = Field(default=5.0, gt=0, le=5.0)


class TestCaseResult(BaseModel):
    name: str
    outcome: Literal["passed", "failed", "error", "skipped"]
    message: str
    line: Optional[int] = None
    duration_ms: Optional[float] = None


class ValidateResponse(BaseModel):
    patch_id: str
    status: PatchStatus
    tests_passed: int
    tests_failed: int
    tests: list[TestCaseResult]
    output: str
    smoke: dict[str, Any] = Field(description="Result of running the patched program itself")
    baseline: Optional[dict[str, Any]] = Field(default=None, description="Same tests against the unpatched program")
    runner: str = Field(default="builtin", description="'pytest' when real pytest ran the tests")


class TracePage(BaseModel):
    execution_id: str
    total_steps: int
    next_start: Optional[int]
    events: list[dict[str, Any]]  # validated TraceEvent dumps with absent fields omitted
