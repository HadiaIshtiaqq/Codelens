"""AI code conversion between programming languages.

Python output is checked by parsing it; on a syntax error the model gets one
retry with the exact error, so "convert then run in the debugger" works.
"""

import ast
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.services.llm import LLMClient, LLMError

router = APIRouter(prefix="/api/v1", tags=["Convert"])

LANGUAGES = [
    "Python", "JavaScript", "TypeScript", "Java", "C", "C++", "C#", "Go", "Rust", "Ruby", "PHP",
    "Kotlin", "Swift", "Dart", "Scala", "R", "Julia", "Lua", "Perl", "Haskell", "Elixir", "MATLAB",
    "Visual Basic", "Bash", "PowerShell", "SQL", "Pseudocode",
]


class ConvertRequest(BaseModel):
    source_code: str = Field(..., min_length=1)
    source_language: str = Field(default="auto", max_length=40)
    target_language: str = Field(default="Python", min_length=1, max_length=40)

    @field_validator("source_code")
    @classmethod
    def _size(cls, value: str) -> str:
        limit = get_settings().max_source_bytes
        if len(value.encode("utf-8")) > limit:
            raise ValueError(f"source_code exceeds {limit // 1024} KB limit")
        return value


class ConvertResponse(BaseModel):
    detected_language: str
    target_language: str
    converted_code: str
    notes: list[str]
    syntax_checked: bool = Field(description="True when the output was verified to parse (Python targets)")
    provider: str
    model: Optional[str]


@router.get("/convert/languages")
async def languages() -> dict[str, list[str]]:
    return {"languages": LANGUAGES}


def _python_error(code: str) -> Optional[str]:
    try:
        ast.parse(code)
    except SyntaxError as exc:
        return f"line {exc.lineno}: {exc.msg}"
    return None


@router.post("/convert", response_model=ConvertResponse)
async def convert(req: ConvertRequest, request: Request) -> ConvertResponse:
    provider = request.app.state.llm_provider
    if provider.name == "offline":
        raise HTTPException(
            status_code=503,
            detail="Code conversion needs the AI. Add NEBIUS_API_KEY to backend/.env and restart CodeLens.",
        )
    client = LLMClient(provider, get_settings().llm_timeout_seconds, getattr(request.app.state, "llm_transport", None))
    to_python = req.target_language.strip().lower() == "python"
    try:
        out = await client.convert(req.source_code, req.source_language, req.target_language)
        checked = False
        if to_python:
            error = _python_error(out.converted_code)
            if error:
                out = await client.convert(req.source_code, req.source_language, req.target_language,
                                           feedback=f"the Python does not parse ({error})")
                error = _python_error(out.converted_code)
                if error:
                    raise HTTPException(status_code=502, detail=f"The AI produced invalid Python twice ({error}). Try again.")
            checked = True
    except LLMError as exc:
        raise HTTPException(status_code=502, detail=f"AI provider failed: {exc}") from exc
    return ConvertResponse(
        detected_language=out.detected_language,
        target_language=req.target_language,
        converted_code=out.converted_code,
        notes=out.notes,
        syntax_checked=checked,
        provider=provider.name,
        model=provider.model,
    )
