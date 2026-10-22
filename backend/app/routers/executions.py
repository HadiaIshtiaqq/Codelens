import asyncio
import json
import uuid
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.schemas import ExecutionRequest, ExecutionResponse, TraceEvent, TracePage
from app.services.evidence import call_stack_at
from app.services.narrate import annotate, line_notes
from app.services.store import ExecutionRecord
from app.services.testgen import test_template

router = APIRouter(prefix="/api/v1/executions", tags=["Executions"])


def _to_response(execution_id: str, record: ExecutionRecord) -> ExecutionResponse:
    result = record.result
    notes = {name: line_notes(text) for name, text in record.sources().items()}
    return ExecutionResponse(
        execution_id=execution_id,
        status=result.status,
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        error=result.error,
        trace_available=bool(result.events),
        total_steps=len(result.events),
        trace_truncated=result.trace_truncated,
        output_truncated=result.output_truncated,
        duration_ms=result.duration_ms,
        line_notes=notes["main.py"],
        file_line_notes=notes,
        omitted_steps=result.omitted_steps,
        recording_stopped=result.recording_stopped,
    )


async def _execute(request: Request, req: ExecutionRequest) -> tuple[str, ExecutionRecord]:
    state = request.app.state
    execution_id = f"exec_{uuid.uuid4()}"
    async with state.execution_slots:
        # The runner blocks on the worker process; keep it off the event loop.
        result = await asyncio.to_thread(
            state.runner.run,
            execution_id,
            req.source_code,
            timeout=req.limits.timeout_seconds,
            max_events=req.max_steps,
            files=req.files,
            stdin=req.stdin,
        )
    record = ExecutionRecord(source=req.source_code, result=result, files=req.files, stdin=req.stdin)
    annotate(record.sources(), result.events)  # AST + trace narration; parses, never executes
    state.stores.executions.put(execution_id, record)
    return execution_id, record


def _record_or_404(request: Request, execution_id: str) -> ExecutionRecord:
    record = request.app.state.stores.executions.get(execution_id)
    if record is None:
        raise HTTPException(status_code=404, detail="execution not found")
    return record


@router.get("/{execution_id}/source")
async def get_source(execution_id: str, request: Request) -> dict:
    record = _record_or_404(request, execution_id)
    return {"execution_id": execution_id, "source_code": record.source, "files": record.files, "stdin": record.stdin}


@router.post("", response_model=ExecutionResponse)
async def create_execution(req: ExecutionRequest, request: Request) -> ExecutionResponse:
    """Run code in the sandbox and return the summary; fetch steps via /trace."""
    execution_id, record = await _execute(request, req)
    return _to_response(execution_id, record)


@router.get("/{execution_id}", response_model=ExecutionResponse)
async def get_execution(execution_id: str, request: Request) -> ExecutionResponse:
    return _to_response(execution_id, _record_or_404(request, execution_id))


@router.delete("/{execution_id}")
async def delete_execution(execution_id: str, request: Request) -> dict:
    """Forget a run: its code, trace, and any explanations and patches made from it."""
    deleted = request.app.state.stores.delete_execution(execution_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="execution not found")
    return {"execution_id": execution_id, "deleted": True}


@router.get("/{execution_id}/trace", response_model=TracePage)
async def get_trace(
    execution_id: str,
    request: Request,
    start: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=500),
    include_viz: bool = Query(True, description="Include the frames/heap snapshot used by the visual view"),
) -> TracePage:
    events_all = _record_or_404(request, execution_id).result.events
    events = events_all[start : start + limit]
    end = start + len(events)
    return TracePage(
        execution_id=execution_id,
        total_steps=len(events_all),
        next_start=end if end < len(events_all) else None,
        events=[
            TraceEvent.model_validate(ev).model_dump(exclude_none=True, exclude=None if include_viz else {"viz"})
            for ev in events
        ],
    )


@router.get("/{execution_id}/steps/{step}")
async def get_step_state(execution_id: str, step: int, request: Request) -> dict:
    """Full debugger state at one step: the event, its variables and the reconstructed call stack."""
    events = _record_or_404(request, execution_id).result.events
    if not 0 <= step < len(events):
        raise HTTPException(status_code=404, detail=f"step must be between 0 and {len(events) - 1}")
    event = TraceEvent.model_validate(events[step]).model_dump(exclude_none=True)
    stdout_so_far = "".join(e.get("stdout_chunk", "") for e in events[: step + 1])
    return {
        "execution_id": execution_id,
        "total_steps": len(events),
        "event": event,
        "call_stack": call_stack_at(events, step),
        "stdout_so_far": stdout_so_far[-8000:],
    }


@router.get("/{execution_id}/test-template")
async def get_test_template(execution_id: str, request: Request) -> dict:
    """Starter tests built from what actually happened in this run (real arguments and results)."""
    record = _record_or_404(request, execution_id)
    return {"execution_id": execution_id, "tests": test_template(record)}


def _sse(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


@router.post("/stream")
async def stream_execution(req: ExecutionRequest, request: Request) -> StreamingResponse:
    """Run code, then stream the trace as Server-Sent Events: init, step*, complete."""
    execution_id, record = await _execute(request, req)
    events_all = record.result.events

    async def events() -> AsyncIterator[str]:
        yield _sse("init", json.dumps({"execution_id": execution_id, "total_steps": len(events_all)}))
        for ev in events_all:
            yield _sse("step", TraceEvent.model_validate(ev).model_dump_json(exclude_none=True))
        yield _sse("complete", _to_response(execution_id, record).model_dump_json())

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
