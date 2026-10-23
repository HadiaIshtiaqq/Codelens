"""LLM adapter for Nebius Token Factory, Google Gemini and Ollama (spec §2.1, §2.3.2, §3.3).

All providers are called through their OpenAI-compatible Chat Completions
endpoints with JSON-object output. Responses are validated against a schema; any
transport, HTTP or schema failure raises LLMError so callers can degrade to the
offline engine.
"""

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.config import Settings

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    pass


@dataclass
class Provider:
    name: str  # "nebius" | "gemini" | "ollama" | "offline"
    model: Optional[str] = None
    base_url: Optional[str] = None
    api_key: Optional[str] = None


def select_provider(settings: Settings) -> Provider:
    choice = settings.llm_provider.lower()
    if choice == "auto":
        if settings.nebius_api_key:
            choice = "nebius"
        elif settings.gemini_api_key:
            choice = "gemini"
        elif settings.ollama_model:
            choice = "ollama"
        else:
            choice = "offline"
    if choice == "nebius":
        if not settings.nebius_api_key:
            raise ValueError("CODELENS_LLM_PROVIDER=nebius requires NEBIUS_API_KEY")
        # An empty NEBIUS_MODEL means: discover a Nemotron model from the live /models catalogue.
        return Provider("nebius", settings.nebius_model or None, settings.nebius_base_url.rstrip("/"),
                        settings.nebius_api_key)
    if choice == "gemini":
        if not settings.gemini_api_key:
            raise ValueError("CODELENS_LLM_PROVIDER=gemini requires GEMINI_API_KEY")
        return Provider("gemini", settings.gemini_model or None, settings.gemini_base_url.rstrip("/"), settings.gemini_api_key)
    if choice == "ollama":
        return Provider("ollama", settings.ollama_model or "qwen2.5-coder:7b", settings.ollama_base_url.rstrip("/") + "/v1")
    if choice == "offline":
        return Provider("offline")
    raise ValueError(f"unknown CODELENS_LLM_PROVIDER: {settings.llm_provider!r}")


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------

class ExplanationOut(BaseModel):
    summary: str = Field(min_length=1, max_length=2000)
    likely_cause: Optional[str] = Field(default=None, max_length=4000)
    suggested_next_step: Optional[str] = Field(default=None, max_length=4000)
    cited_lines: list[int] = Field(default_factory=list)


class PatchOut(BaseModel):
    patched_source: str = Field(min_length=1)
    rationale: str = Field(min_length=1, max_length=4000)


SYSTEM_PROMPT = """You are CodeLens, a debugging assistant for Python programs.
You are given an EVIDENCE package recorded by a deterministic tracer (sys.settrace) while the program ran in a sandbox.

Rules:
- Use ONLY the evidence. Never invent variable values, line numbers, outputs or errors that are not in the evidence.
- If the evidence does not support a conclusion, say what is unknown instead of guessing.
- Refer to code by its line numbers in `program.numbered_source`.
- Trace `step` fields are 0-based; when you mention a step to the user, add 1 (step 0 is "step 1").
- Write for a programming learner: short, concrete, friendly.
- Reply with a single JSON object and nothing else."""

EXPLAIN_INSTRUCTIONS = """Return JSON with exactly these keys:
{
  "summary": "one or two sentences describing what happened",
  "likely_cause": "the most likely root cause, grounded in the evidence (null if the program succeeded and nothing is wrong)",
  "suggested_next_step": "one concrete thing the user should check or change",
  "cited_lines": [line numbers from the program that your answer relies on]
}"""

PATCH_INSTRUCTIONS = """Fix the bug shown in the evidence with the smallest reasonable change.
Return JSON with exactly these keys:
{
  "patched_source": "the COMPLETE corrected contents of main.py",
  "rationale": "why this change fixes the failure, citing line numbers from the evidence"
}
Keep everything that is not part of the fix byte-for-byte identical (names, comments, formatting)."""


def choose_model(model_ids: list[str], provider: str = "nebius") -> Optional[str]:
    """Pick a model from a provider catalogue: a Nemotron text model on Nebius, the newest Flash on Gemini."""
    if provider == "gemini":
        def gemini_score(mid: str) -> tuple:
            low = mid.lower()
            version = re.search(r"gemini-(\d+(?:\.\d+)?)", low)
            return (
                "flash" in low,
                not any(t in low for t in ("lite", "image", "tts", "audio", "live", "embed", "thinking", "exp", "preview")),
                float(version.group(1)) if version else 0.0,
            )

        texts = [m.removeprefix("models/") for m in model_ids if "gemini" in m.lower()]
        ranked = sorted(texts, key=gemini_score, reverse=True)
        return ranked[0] if ranked else None

    def score(mid: str) -> tuple:
        low = mid.lower()
        return (
            "nemotron" in low,
            "nvidia" in low,
            not any(t in low for t in ("vl", "vision", "embed", "reward", "guard", "safety", "parse", "rerank")),
            "super" in low,
            "ultra" not in low,  # prefer the faster Super over the much larger Ultra
        )

    ranked = sorted(model_ids, key=score, reverse=True)
    return ranked[0] if ranked else None


ASK_SYSTEM_PROMPT = """You are Alexa, a friendly voice assistant that helps people understand their Python code.
You are given the user's code with line numbers, a plain-English note for each line, and, when available, what
happened when the code ran. Answer like a great teacher speaking out loud: clear, specific and correct.
Rules:
- Ground every claim in the code and run facts you were given. Never invent variables, lines, values or output.
- Refer to lines as "line N" using the numbers shown.
- If the question asks for something the code does not do (for example printing a value it never prints),
  say so plainly and say what line to add or change, with the exact code.
- If the question has nothing to do with the code, say briefly that you can only help with this code.
- Spoken style: 2 to 5 short sentences, no markdown, no bullet points, no code blocks (inline code is fine).
Respond with a single JSON object."""

ASK_INSTRUCTIONS = """Return JSON with exactly these keys:
{"speech": "the spoken answer", "line": the single most relevant line number in the code, or null}"""


class LLMClient:
    def __init__(self, provider: Provider, timeout: float, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.provider = provider
        self.timeout = timeout
        self.transport = transport  # injectable for tests

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.provider.api_key:
            headers["Authorization"] = f"Bearer {self.provider.api_key}"
        return headers

    async def list_models(self) -> list[str]:
        p = self.provider
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0), transport=self.transport) as client:
                resp = await client.get(f"{p.base_url}/models", headers=self._headers())
        except httpx.HTTPError as exc:
            raise LLMError(f"{p.name} model list failed: {type(exc).__name__}: {exc}") from exc
        if resp.status_code != 200:
            raise LLMError(f"{p.name} model list returned HTTP {resp.status_code}: {resp.text[:300]}")
        try:
            return [m["id"] for m in resp.json()["data"]]
        except (ValueError, KeyError, TypeError) as exc:
            raise LLMError(f"{p.name} returned an unexpected model list") from exc

    async def ensure_model(self) -> str:
        """Resolve the model once (shared Provider object, so /health shows it too)."""
        if not self.provider.model:
            chosen = choose_model(await self.list_models(), self.provider.name)
            if not chosen:
                raise LLMError(f"{self.provider.name} offers no models for this API key")
            self.provider.model = chosen
        return self.provider.model

    async def _chat_json(self, user_content: str, system: str = SYSTEM_PROMPT, max_tokens: int = 4096) -> dict[str, Any]:
        p = self.provider
        model = await self.ensure_model()
        body = {
            "model": model,
            "temperature": 0.1,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_content},
            ],
        }
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=10.0), transport=self.transport
            ) as client:
                resp = await client.post(f"{p.base_url}/chat/completions", headers=self._headers(), json=body)
        except httpx.HTTPError as exc:
            raise LLMError(f"{p.name} request failed: {type(exc).__name__}: {exc}") from exc
        if resp.status_code != 200:
            raise LLMError(f"{p.name} returned HTTP {resp.status_code}: {resp.text[:300]}")
        try:
            content = resp.json()["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"{p.name} returned an unexpected response shape") from exc
        return _extract_json(content)

    async def chat(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        """One step of a tool-using conversation: returns the assistant message (content and/or tool_calls)."""
        p = self.provider
        body = {"model": await self.ensure_model(), "temperature": 0.1, "max_tokens": 2048,
                "messages": messages, "tools": tools, "tool_choice": "auto"}
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(self.timeout, connect=10.0), transport=self.transport
            ) as client:
                resp = await client.post(f"{p.base_url}/chat/completions", headers=self._headers(), json=body)
        except httpx.HTTPError as exc:
            raise LLMError(f"{p.name} request failed: {type(exc).__name__}: {exc}") from exc
        if resp.status_code != 200:
            raise LLMError(f"{p.name} returned HTTP {resp.status_code}: {resp.text[:300]}")
        try:
            message = resp.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"{p.name} returned an unexpected response shape") from exc
        if isinstance(message.get("content"), str):
            message["content"] = _THINK_RE.sub("", message["content"]).strip()
        return message

    async def answer_question(self, context: str, question: str) -> dict[str, Any]:
        """A short spoken answer to a question about the user's code: {"speech": str, "line": int | None}."""
        prompt = f"{context}\n\nQUESTION (spoken to Alexa): {question}\n\n{ASK_INSTRUCTIONS}"
        data = await self._chat_json(prompt, system=ASK_SYSTEM_PROMPT, max_tokens=1024)
        speech = str(data.get("speech") or "").strip()
        if not speech:
            raise LLMError("answer had no speech")
        line = data.get("line")
        return {"speech": speech, "line": line if isinstance(line, int) else None}

    async def ping(self) -> dict[str, Any]:
        """Smallest possible round-trip, used to prove the provider is live."""
        return await self._chat_json('Reply with exactly this JSON object: {"ok": true}')

    async def explain(self, evidence: dict[str, Any], facts: list[str], question: Optional[str]) -> ExplanationOut:
        prompt = (
            f"EVIDENCE:\n{json.dumps(evidence, indent=1)}\n\n"
            f"OBSERVED FACTS (verified from the trace):\n- " + "\n- ".join(facts) + "\n\n"
            f"USER QUESTION: {question or 'Why did this program behave this way?'}\n\n{EXPLAIN_INSTRUCTIONS}"
        )
        data = await self._chat_json(prompt)
        try:
            return ExplanationOut.model_validate(data)
        except ValidationError as exc:
            raise LLMError(f"explanation failed schema validation: {exc.errors()[:2]}") from exc

    async def patch(self, evidence: dict[str, Any], source: str, explanation: Optional[dict[str, Any]]) -> PatchOut:
        prompt = (
            f"EVIDENCE:\n{json.dumps(evidence, indent=1)}\n\n"
            + (f"PRIOR DIAGNOSIS:\n{json.dumps(explanation, indent=1)}\n\n" if explanation else "")
            + f"CURRENT main.py:\n```python\n{source}\n```\n\n{PATCH_INSTRUCTIONS}"
        )
        data = await self._chat_json(prompt)
        try:
            return PatchOut.model_validate(data)
        except ValidationError as exc:
            raise LLMError(f"patch failed schema validation: {exc.errors()[:2]}") from exc


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)


def _extract_json(content: str) -> dict[str, Any]:
    """Parse a JSON object, tolerating reasoning preambles and ``` fences some models emit."""
    text = _THINK_RE.sub("", content).strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        data = json.loads(text)
    except ValueError as exc:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise LLMError("model response contained no JSON object") from exc
        try:
            data = json.loads(text[start : end + 1])
        except ValueError as exc:
            raise LLMError("model response was not valid JSON") from exc
    if not isinstance(data, dict):
        raise LLMError("model response JSON was not an object")
    return data


def grounding_warnings(out: ExplanationOut, line_count: int, known: "dict[str, set[str]] | set[str]") -> list[str]:
    """Checks that the model stayed within the evidence: real lines, real variables, recorded values.

    `known` maps each variable name to every value it was recorded with during the run.
    """
    if isinstance(known, set):
        known = {name: set() for name in known}
    warnings = []
    bad = [n for n in out.cited_lines if not 1 <= n <= line_count]
    if bad:
        warnings.append(f"cited line(s) {bad} do not exist in the program")
    text = " ".join(filter(None, [out.summary, out.likely_cause, out.suggested_next_step]))
    for m in re.finditer(r"\bline (\d+)", text):
        if not 1 <= int(m.group(1)) <= line_count:
            warnings.append(f"mentions line {m.group(1)}, which does not exist")
    for m in re.finditer(r"'(\w+)' (?:was|is|equals|had the value) ('[^']*'|\"[^\"]*\"|[^\s,;]+)", text):
        name, claimed = m.group(1), m.group(2).rstrip(".")
        if name not in known:
            warnings.append(f"states a value for '{name}', which never appears in the trace")
        elif known[name] and _normalise(claimed) not in {_normalise(v) for v in known[name]}:
            recorded = ", ".join(sorted(known[name])[:5])
            warnings.append(f"says '{name}' was {claimed}, but the trace only recorded {recorded}")
    return warnings


def _normalise(value: str) -> str:
    """Compare values loosely: quotes and a trailing '.0' don't matter."""
    v = value.strip().strip("'\"")
    return v[:-2] if v.endswith(".0") else v
