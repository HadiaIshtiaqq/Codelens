"""REA reverse-engineering endpoints (spec FR-02, §4.2.6, §4.3)."""

import asyncio
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.services.rea import ReaError, ReaService

router = APIRouter(prefix="/api/v1/rea", tags=["REA"])


class JsAnalysisRequest(BaseModel):
    path: str = Field(..., min_length=1, description="ASAR or extracted app path, absolute or relative to the REA workspace")
    artifact_format: Literal["auto", "asar", "directory"] = "auto"


class ToolCallRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    arguments: dict[str, Any] = Field(default_factory=dict)


def _service(request: Request) -> ReaService:
    return request.app.state.rea


async def _guard(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except ReaError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.get("/status")
async def rea_status(request: Request, refresh: bool = Query(False)) -> dict[str, Any]:
    """REA `doctor` report: which analysis engines (Ghidra, Hopper, IDA, JADX, ...) are ready."""
    return await _guard(_service(request).status, refresh)


@router.get("/workspace")
async def rea_workspace(request: Request) -> dict[str, Any]:
    svc = _service(request)
    return {"root": str(svc.settings.rea_workspace_root), "entries": await _guard(svc.workspace_listing)}


@router.post("/javascript")
async def analyze_javascript(req: JsAnalysisRequest, request: Request) -> dict[str, Any]:
    """Static JavaScript/Electron application reconstruction (`rea analyze-javascript-application`)."""
    svc = _service(request)
    result = await _guard(svc.analyze_javascript, req.path, req.artifact_format)
    result_id = f"rea_{uuid.uuid4().hex[:12]}"
    request.app.state.stores.rea_results.put(result_id, result["evidence"])
    return {"result_id": result_id, **result["projection"]}


@router.get("/results/{result_id}")
async def rea_result(result_id: str, request: Request) -> dict[str, Any]:
    """Full canonical REA Evidence document for a previous analysis."""
    evidence = request.app.state.stores.rea_results.get(result_id)
    if evidence is None:
        raise HTTPException(status_code=404, detail="result not found")
    return evidence


@router.get("/tools")
async def list_tools(request: Request, include_schema: bool = Query(False)) -> dict[str, Any]:
    """REA MCP tool catalogue with safety annotations."""
    tools = await _guard(_service(request).mcp.list_tools)
    if not include_schema:
        tools = [{k: v for k, v in t.items() if k != "input_schema"} for t in tools]
    return {"count": len(tools), "tools": tools}


@router.get("/tools/{name}")
async def get_tool(name: str, request: Request) -> dict[str, Any]:
    tools = await _guard(_service(request).mcp.list_tools)
    tool = next((t for t in tools if t["name"] == name), None)
    if tool is None:
        raise HTTPException(status_code=404, detail="unknown tool")
    return tool


@router.post("/tools/call")
async def call_tool(req: ToolCallRequest, request: Request) -> dict[str, Any]:
    """Invoke one REA MCP tool (JSON-RPC tools/call) and return its decoded content."""
    return await _guard(_service(request).mcp.call_tool, req.name, req.arguments)
