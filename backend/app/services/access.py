"""Optional access code for hosted deployments.

When CODELENS_ACCESS_CODE is set, every /api/* request must send it in the
`X-CodeLens-Access` header, so strangers who find the URL cannot run code or
spend AI credits. /health stays public so the UI can ask for the code.
"""

import json
import secrets
from typing import Optional

HEADER = b"x-codelens-access"


def parse_codes(raw: Optional[str]) -> dict[str, str]:
    """`"judges:abc123, team:xyz"` -> {"judges": "abc123", "team": "xyz"}; a bare code is labelled "default".

    Give each group its own code, so one can be revoked (removed) without changing the others.
    """
    codes: dict[str, str] = {}
    for i, item in enumerate(p.strip() for p in (raw or "").split(",")):
        if not item:
            continue
        label, sep, code = item.partition(":")
        if sep and code:
            codes[label.strip()] = code.strip()
        else:
            codes["default" if i == 0 else f"code{i}"] = item
    return codes


class AccessCodeMiddleware:
    def __init__(self, app, code_getter):
        self.app = app
        self._code_getter = code_getter

    async def __call__(self, scope, receive, send):
        codes = parse_codes(self._code_getter())
        if codes and scope["type"] == "http" and scope["path"].startswith("/api/") and scope["method"] != "OPTIONS":
            sent = dict(scope.get("headers") or []).get(HEADER, b"")
            if not any(secrets.compare_digest(sent, c.encode()) for c in codes.values()):
                body = json.dumps({"detail": "access code required"}).encode()
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
