"""Per-client rate limiting for the expensive endpoints (sandbox runs and AI calls).

A token bucket per client IP: `per_minute` requests refill evenly over a minute,
with bursts up to the same size. Returns 429 with Retry-After when exhausted.
"""

import json
import math
import threading
import time
from typing import Optional

LIMITED_PREFIXES = (
    "/api/v1/executions",  # POST only: runs code in a sandbox
    "/api/v1/explanations",
    "/api/v1/ask",  # can call the AI
    "/api/v1/patches",
    "/api/v1/ai/selftest",
    "/api/v1/rea/javascript",
    "/api/v1/rea/tools/call",
)


class RateLimiter:
    def __init__(self, per_minute: int, max_clients: int = 10_000):
        self.per_minute = per_minute
        self._buckets: dict[str, tuple[float, float]] = {}  # client -> (tokens, last_refill)
        self._lock = threading.Lock()
        self._max_clients = max_clients

    def check(self, client: str, now: Optional[float] = None) -> float:
        """Consume one token; return 0 if allowed, else seconds to wait."""
        if self.per_minute <= 0:
            return 0.0
        now = time.monotonic() if now is None else now
        rate = self.per_minute / 60.0
        with self._lock:
            tokens, last = self._buckets.get(client, (float(self.per_minute), now))
            tokens = min(float(self.per_minute), tokens + (now - last) * rate)
            if tokens >= 1:
                self._buckets[client] = (tokens - 1, now)
                allowed = 0.0
            else:
                self._buckets[client] = (tokens, now)
                allowed = (1 - tokens) / rate
            if len(self._buckets) > self._max_clients:  # forget the stalest clients
                for key, _ in sorted(self._buckets.items(), key=lambda kv: kv[1][1])[: self._max_clients // 10]:
                    self._buckets.pop(key, None)
        return allowed


_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _client_ip(scope) -> str:
    """The visitor's address. Behind a local proxy or tunnel (Caddy, cloudflared) every request comes from
    loopback, so the proxy's forwarded address is used instead; it is only trusted from loopback."""
    peer = (scope.get("client") or ("unknown", 0))[0]
    if peer in _LOOPBACK or peer.startswith("172.") or peer.startswith("10."):  # host, or a proxy on the Docker network
        headers = dict(scope.get("headers") or [])
        forwarded = headers.get(b"cf-connecting-ip") or headers.get(b"x-forwarded-for", b"").split(b",")[0]
        if forwarded.strip():
            return forwarded.strip().decode("latin-1")
    return peer


class RateLimitMiddleware:
    """Pure ASGI middleware; reads the limiter from app.state so tests can swap it."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] == "POST" and scope["path"].startswith(LIMITED_PREFIXES):
            limiter: Optional[RateLimiter] = getattr(scope["app"].state, "rate_limiter", None)
            client = _client_ip(scope)
            wait = limiter.check(client) if limiter else 0.0
            if wait > 0:
                body = json.dumps({"detail": f"Too many requests: try again in {math.ceil(wait)} s"}).encode()
                await send({"type": "http.response.start", "status": 429, "headers": [
                    (b"content-type", b"application/json"), (b"retry-after", str(math.ceil(wait)).encode())]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
