"""Shared-secret auth between the web app and this service (SPEC-075).

The service sits on a private Docker network, but it still requires `Authorization: Bearer <ANALYTICS_TOKEN>` on every
route except `/healthz`, so a mis-published port or a compromised neighbour container cannot use it. The token is read
per request (rotation = restart with a new value). Unset means local dev and tests; infra/docker-compose.prod.yml
refuses to start the service without it, and the web app refuses production without it.
"""
from __future__ import annotations

import hmac
import os

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

OPEN_PATHS = frozenset({"/healthz"})
MIN_TOKEN_LEN = 32


class SharedSecretAuth(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        token = os.environ.get("ANALYTICS_TOKEN", "")
        if not token or request.url.path in OPEN_PATHS:
            return await call_next(request)
        if len(token) < MIN_TOKEN_LEN:
            # Misconfiguration: fail closed rather than accept a guessable secret.
            return JSONResponse({"detail": "analytics auth misconfigured"}, status_code=500)
        scheme, _, given = request.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not hmac.compare_digest(given.encode(), token.encode()):
            return JSONResponse({"detail": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        return await call_next(request)
