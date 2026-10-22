"""AI explanation, patch generation and sandboxed patch validation (spec §3.3, §4.2.3-5, §5.4)."""

import ast
import asyncio
import logging
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from app.config import get_settings
from app.schemas import (
    ExplanationRequest,
    ExplanationResponse,
    PatchRequest,
    PatchResponse,
    ValidateRequest,
    ValidateResponse,
)
from app.services import offline
from app.services.diffutil import DiffError, apply_unified_diff, make_diff
from app.services.evidence import build_evidence, observed_facts
from app.services.llm import LLMClient, LLMError, grounding_warnings
from app.services.sandbox import SandboxResult
from app.services.store import ExecutionRecord, ExplanationRecord, PatchRecord

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["Analysis"])


def _execution(request: Request, execution_id: str) -> ExecutionRecord:
    record = request.app.state.stores.executions.get(execution_id)
    if record is None:
        raise HTTPException(status_code=404, detail="execution not found")
    return record


def _client(request: Request) -> Optional[LLMClient]:
    provider = request.app.state.llm_provider
    if provider.name == "offline":
        return None
    return LLMClient(provider, get_settings().llm_timeout_seconds, getattr(request.app.state, "llm_transport", None))


def _known_values(record: ExecutionRecord) -> dict[str, set[str]]:
    """Every value each variable was recorded with during the run (for the grounding check)."""
    values: dict[str, set[str]] = {}
    for ev in record.result.events:
        for name, value in ev.get("locals", {}).items():
            values.setdefault(name, set()).add(value)
    return values


# ---------------------------------------------------------------------------
# Provider self-test
# ---------------------------------------------------------------------------

@router.post("/ai/selftest")
async def ai_selftest(request: Request) -> dict[str, Any]:
    """Make one real call to the configured provider (e.g. Nebius Token Factory) and report latency."""
    provider = request.app.state.llm_provider
    client = _client(request)
    base = {"provider": provider.name, "base_url": provider.base_url, "strict": get_settings().require_llm_provider}
    if client is None:
        return {**base, "model": None, "ok": False,
                "detail": "No AI provider configured (set NEBIUS_API_KEY); using offline rules."}
    started = time.monotonic()
    try:
        reply = await client.ping()
    except LLMError as exc:
        return {**base, "model": provider.model, "ok": False, "detail": str(exc),
                "latency_ms": round((time.monotonic() - started) * 1000)}
    return {**base, "model": provider.model, "ok": reply.get("ok") is True, "reply": reply,
            "latency_ms": round((time.monotonic() - started) * 1000)}


# ---------------------------------------------------------------------------
# Explanations
# ---------------------------------------------------------------------------

@router.post("/explanations", response_model=ExplanationResponse)
async def create_explanation(req: ExplanationRequest, request: Request) -> ExplanationResponse:
    record = _execution(request, req.execution_id)
    evidence = build_evidence(record, req.step)
    facts = observed_facts(evidence)
    client = _client(request)
    provider = request.app.state.llm_provider

    body: dict[str, Any]
    provider_error = None
    warnings: list[str] = []
    if client is not None:
        try:
            out = await client.explain(evidence, facts, req.question)
            warnings = grounding_warnings(out, evidence["program"]["line_count"], _known_values(record))
            body = out.model_dump()
        except LLMError as exc:
            if get_settings().require_llm_provider:
                raise HTTPException(status_code=502, detail=f"AI provider failed: {exc}") from exc
            log.warning("explanation degraded to offline engine: %s", exc)
            provider_error = str(exc)
            client = None
    if client is None:
        body = offline.explain(evidence, req.question)
        body["cited_lines"] = [evidence["outcome"]["error"]["line"]] if evidence["outcome"]["error"] else []

    response = ExplanationResponse(
        explanation_id=f"exp_{uuid.uuid4().hex[:12]}",
        execution_id=req.execution_id,
        step=evidence["focus_step"],
        observed_facts=facts,
        provider="offline" if client is None else provider.name,
        model=None if client is None else provider.model,
        degraded=provider_error is not None,
        provider_error=provider_error,
        grounding_warnings=warnings,
        **body,
    )
    request.app.state.stores.explanations.put(
        response.explanation_id,
        ExplanationRecord(req.execution_id, evidence["focus_step"] or 0, response.model_dump()),
    )
    return response


# ---------------------------------------------------------------------------
# Patches
# ---------------------------------------------------------------------------

def _check_candidate(original: str, patched: str) -> str:
    """Reject candidates that do not parse or change nothing; return the unified diff."""
    try:
        ast.parse(patched)
    except SyntaxError as exc:
        raise ValueError(f"candidate patch is not valid Python (line {exc.lineno}: {exc.msg})") from exc
    diff = make_diff(original, patched)
    if not diff:
        raise ValueError("candidate patch does not change the program")
    # Round-trip through the strict applier so stored diffs are always applicable.
    apply_unified_diff(original, diff)
    return diff


@router.post("/patches", response_model=PatchResponse)
async def create_patch(req: PatchRequest, request: Request) -> PatchResponse:
    record = _execution(request, req.execution_id)
    stores = request.app.state.stores
    provider = request.app.state.llm_provider
    original = record.source if record.source.endswith("\n") else record.source + "\n"

    patched: Optional[str] = None
    rationale = ""
    used = "offline"
    provider_error = None

    if req.diff is not None:
        # A caller-supplied patch (from the user, or an agent via MCP).
        try:
            patched = apply_unified_diff(original, req.diff)
            _check_candidate(original, patched)
        except (DiffError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=f"invalid diff: {exc}") from exc
        rationale = "User-supplied patch."
        used = "user"
    else:
        evidence = build_evidence(record)
        explanation = None
        if req.explanation_id:
            exp = stores.explanations.get(req.explanation_id)
            if exp is None or exp.execution_id != req.execution_id:
                raise HTTPException(status_code=404, detail="explanation not found for this execution")
            explanation = {k: exp.payload.get(k) for k in ("summary", "likely_cause", "suggested_next_step")}

        client = _client(request)
        if client is not None:
            try:
                out = await client.patch(evidence, original, explanation)
                candidate = out.patched_source if out.patched_source.endswith("\n") else out.patched_source + "\n"
                _check_candidate(original, candidate)
                patched, rationale, used = candidate, out.rationale, provider.name
            except (LLMError, ValueError, DiffError) as exc:
                if get_settings().require_llm_provider:
                    raise HTTPException(status_code=502, detail=f"AI provider failed: {exc}") from exc
                log.warning("patch generation degraded to offline engine: %s", exc)
                provider_error = str(exc)
        if patched is None:
            fix = offline.propose_fix(original, evidence)
            if fix is None:
                detail = "No automatic fix is available for this failure."
                if provider.name == "offline":
                    detail += " The offline engine handles common errors only; set NEBIUS_API_KEY or OLLAMA_MODEL to enable AI patches."
                elif provider_error:
                    detail += f" The AI provider failed: {provider_error}"
                raise HTTPException(status_code=422, detail=detail)
            patched, rationale = fix

    try:
        diff = _check_candidate(original, patched)
    except (ValueError, DiffError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    patch = PatchRecord(
        patch_id=f"patch_{uuid.uuid4().hex[:12]}",
        execution_id=req.execution_id,
        original=original,
        patched=patched,
        diff=diff,
        rationale=rationale,
        provider=used,
    )
    stores.patches.put(patch.patch_id, patch)
    return _patch_response(patch, degraded=provider_error is not None, provider_error=provider_error)


def _patch_response(patch: PatchRecord, degraded: bool = False, provider_error: Optional[str] = None) -> PatchResponse:
    return PatchResponse(
        patch_id=patch.patch_id,
        execution_id=patch.execution_id,
        status=patch.status,
        diff=patch.diff,
        patched_source=patch.patched,
        rationale=patch.rationale,
        provider=patch.provider,
        requires_validation=patch.status != "validated",
        degraded=degraded,
        provider_error=provider_error,
        validation=patch.validation,
    )


@router.get("/patches/{patch_id}", response_model=PatchResponse)
async def get_patch(patch_id: str, request: Request) -> PatchResponse:
    patch = request.app.state.stores.patches.get(patch_id)
    if patch is None:
        raise HTTPException(status_code=404, detail="patch not found")
    return _patch_response(patch)


# ---------------------------------------------------------------------------
# Validation (spec §5.4)
# ---------------------------------------------------------------------------

def _summarise_run(result: SandboxResult) -> dict[str, Any]:
    return {
        "status": result.status,
        "exit_code": result.exit_code,
        "error": result.error,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def _test_counts(result: SandboxResult) -> tuple[int, int]:
    passed = sum(1 for t in result.tests if t["outcome"] == "passed")
    failed = sum(1 for t in result.tests if t["outcome"] in ("failed", "error"))
    return passed, failed


@router.post("/patches/validate", response_model=ValidateResponse)
async def validate_patch(req: ValidateRequest, request: Request) -> ValidateResponse:
    state = request.app.state
    patch = state.stores.patches.get(req.patch_id)
    if patch is None:
        raise HTTPException(status_code=404, detail="patch not found")

    # Step 1-2: parse the stored diff and apply it to a transient copy of the original.
    try:
        patched = apply_unified_diff(patch.original, patch.diff)
    except DiffError as exc:
        patch.status = "failed"
        state.stores.patches.put(patch.patch_id, patch)
        raise HTTPException(status_code=422, detail=f"stored diff no longer applies: {exc}") from exc

    timeout = req.timeout_seconds
    tests = (req.tests or "").strip()
    run_id = uuid.uuid4().hex[:12]

    async def sandboxed(fn, *args, **kwargs) -> SandboxResult:
        async with state.execution_slots:
            return await asyncio.to_thread(fn, *args, **kwargs)

    # Step 3-4: fresh sandboxes. The patched program is always smoke-run; tests (if any)
    # run against both the patched and the original program for a before/after view.
    # The run's other files and program input travel with the patch, so imports and input() still work.
    record = state.stores.executions.get(patch.execution_id)
    files = record.files if record else {}
    stdin = record.stdin if record else ""
    jobs = [sandboxed(state.runner.run, f"val-{run_id}-smoke", patched, timeout=timeout, max_events=1,
                      files=files, stdin=stdin)]
    if tests:
        jobs.append(sandboxed(state.runner.run_tests, f"val-{run_id}-tests", patched, tests, timeout=timeout,
                              files=files, stdin=stdin))
        jobs.append(sandboxed(state.runner.run_tests, f"val-{run_id}-base", patch.original, tests, timeout=timeout,
                              files=files, stdin=stdin))
    results = await asyncio.gather(*jobs)
    smoke = results[0]

    baseline = None
    runner = "builtin"
    if not tests:
        status = "untested"
        passed = failed = 0
        output = "No tests supplied: the patched program was only smoke-run. Provide tests to validate the patch."
        test_cases: list[dict[str, Any]] = []
    else:
        test_run, base_run = results[1], results[2]
        passed, failed = _test_counts(test_run)
        test_cases = test_run.tests
        output = (test_run.stdout + test_run.stderr)[-8000:]
        if test_run.status == "failed":  # sandbox infrastructure error, not a verdict on the patch
            status = "untested"
            output = f"Sandbox error: {test_run.error['message'] if test_run.error else 'unknown'}"
        elif test_run.status == "timed_out" or test_run.collection_error or failed or not passed:
            status = "failed"
            if not test_run.tests and not test_run.collection_error and test_run.status == "completed":
                output = "No test_* functions were found in the supplied tests.\n" + output
        else:
            status = "validated"  # every collected test passed, exit code 0
        runner = test_run.runner
        b_passed, b_failed = _test_counts(base_run)
        baseline = {"status": base_run.status, "tests_passed": b_passed, "tests_failed": b_failed,
                    "collection_error": base_run.collection_error}

    patch.status = status
    patch.validation = {
        "status": status,
        "tests_passed": passed,
        "tests_failed": failed,
    }
    state.stores.patches.put(patch.patch_id, patch)  # persist the new status
    return ValidateResponse(
        patch_id=patch.patch_id,
        status=status,
        tests_passed=passed,
        tests_failed=failed,
        tests=test_cases,
        output=output,
        smoke=_summarise_run(smoke),
        baseline=baseline,
        runner=runner,
    )
