"""Explain code without running it (plan of the program + a note for every line)."""

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.services.code_answers import answer as rule_answer
from app.services.explain_static import explain_program
from app.services.llm import LLMClient, LLMError

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["Explain"])


class ExplainCodeRequest(BaseModel):
    source_code: str = Field(..., description="Python code to explain (it is parsed, never run)")
    level: Literal["kid", "game", "classic", "standard"] = "kid"

    @field_validator("source_code")
    @classmethod
    def _size(cls, value: str) -> str:
        limit = get_settings().max_source_bytes
        if len(value.encode("utf-8")) > limit:
            raise ValueError(f"source_code exceeds {limit // 1024} KB limit")
        return value


@router.get("/access")
async def access_check() -> dict:
    """Cheap request the access-code gate uses to test a code (the middleware does the checking)."""
    return {"ok": True}


@router.post("/explain-code")
async def explain_code(req: ExplainCodeRequest) -> dict:
    return explain_program(req.source_code, req.level)


class AskRequest(BaseModel):
    source_code: str = Field(..., description="The Python code the question is about")
    question: str = Field(..., min_length=1, max_length=1000)
    execution_id: Optional[str] = Field(default=None, description="A run of this code, for what actually happened")

    @field_validator("source_code")
    @classmethod
    def _size(cls, value: str) -> str:
        limit = get_settings().max_source_bytes
        if len(value.encode("utf-8")) > limit:
            raise ValueError(f"source_code exceeds {limit // 1024} KB limit")
        return value


def _context(req: AskRequest, request: Request) -> str:
    """What the model may rely on: numbered code, a note per line, likely bugs, and the run if there is one."""
    plan = explain_program(req.source_code, "classic")
    notes = {int(k): v for k, v in plan.get("line_notes", {}).items()}
    numbered = "\n".join(f"{i:>3} | {line}" + (f"    # {notes[i]}" if i in notes else "")
                         for i, line in enumerate(req.source_code.splitlines(), 1))
    parts = [f"CODE (main.py, with a note for each line):\n{numbered}"]
    if plan.get("warnings"):
        parts.append("LIKELY BUGS (found from the code):\n" + "\n".join(f"- {w['text']}" for w in plan["warnings"]))
    record = request.app.state.stores.executions.get(req.execution_id) if req.execution_id else None
    if record is not None and record.source == req.source_code:
        r = record.result
        facts = [f"status: {r.status}, exit code {r.exit_code}, {len(r.events)} recorded steps"]
        if r.error:
            facts.append(f"error: {r.error.get('type')} on line {r.error.get('line')}: {r.error.get('message')}")
        if r.stdout:
            facts.append("printed output:\n" + r.stdout[:1500])
        parts.append("WHAT HAPPENED WHEN IT RAN:\n" + "\n".join(facts))
    else:
        parts.append("The code has not been run for this question; do not claim any output or values.")
    return "\n\n".join(parts)


@router.post("/ask")
async def ask(req: AskRequest, request: Request) -> dict:
    """Answer a question about the code: with the AI when one is configured, else from the code's own structure."""
    provider = request.app.state.llm_provider
    fallback = rule_answer(req.source_code, req.question)
    if provider.name == "offline":
        return {**fallback, "source": "rules", "provider": "offline"}
    client = LLMClient(provider, get_settings().llm_timeout_seconds, getattr(request.app.state, "llm_transport", None))
    try:
        result = await client.answer_question(_context(req, request), req.question)
    except LLMError as exc:
        log.warning("ask: AI unavailable, answering from the code: %s", exc)
        return {**fallback, "source": "rules", "provider": provider.name, "provider_error": str(exc)}
    line_count = len(req.source_code.splitlines())
    line = result["line"] if result["line"] and 1 <= result["line"] <= line_count else None  # grounding check
    return {"speech": result["speech"], "line": line, "lines": [], "found": True, "source": "ai", "provider": provider.name}
