"""Explain code without running it (plan of the program + a note for every line)."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.services.explain_static import explain_program

router = APIRouter(prefix="/api/v1", tags=["Explain"])


class ExplainCodeRequest(BaseModel):
    source_code: str = Field(..., description="Python code to explain (it is parsed, never run)")
    level: Literal["kid", "standard"] = "kid"

    @field_validator("source_code")
    @classmethod
    def _size(cls, value: str) -> str:
        limit = get_settings().max_source_bytes
        if len(value.encode("utf-8")) > limit:
            raise ValueError(f"source_code exceeds {limit // 1024} KB limit")
        return value


@router.post("/explain-code")
async def explain_code(req: ExplainCodeRequest) -> dict:
    return explain_program(req.source_code, req.level)
