"""Optional access code for hosted deployments.

When CODELENS_ACCESS_CODE is set, every /api/* request must send it in the
`X-CodeLens-Access` header, so strangers who find the URL cannot run code or
spend AI credits. /health stays public so the UI can ask for the code.
"""

import json
import secrets
from typing import Optional

HEADER = b"x-codelens-access"


class AccessCodeMiddleware:
    def __init__(self, app, code_getter):
        self.app = app
        self._code_getter = code_getter

    async def __call__(self, scope, receive, send):
        code: Optional[str] = self._code_getter()
        if code and scope["type"] == "http" and scope["path"].startswith("/api/") and scope["method"] != "OPTIONS":
            sent = dict(scope.get("headers") or []).get(HEADER, b"")
            if not secrets.compare_digest(sent, code.encode()):
                body = json.dumps({"detail": "access code required"}).encode()
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/json")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self.app(scope, receive, send)
