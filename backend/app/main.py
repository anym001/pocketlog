import logging
import os
from pathlib import Path

from fastapi import (
    FastAPI,
    Request,
)
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from . import (
    exceptions,
    routers,
)
from .logging_config import configure_logging

# Configure the pocketlog logger namespace at import time, so it applies under
# uvicorn (which imports app.main:app) as well as under pytest and the CLI.
configure_logging()

logger = logging.getLogger("pocketlog.api")

# Swagger UI and the OpenAPI schema are off by default. Both leak the full
# API surface and Swagger's "Try it out" issues real requests against this
# backend. Opt in with ENABLE_DOCS=1 when debugging — never in production.
DOCS_ENABLED = os.environ.get("ENABLE_DOCS") == "1"

app = FastAPI(
    title="PocketLog API",
    docs_url="/api/docs" if DOCS_ENABLED else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if DOCS_ENABLED else None,
)


@app.exception_handler(exceptions.DomainError)
async def _domain_error_handler(
    request: Request, exc: exceptions.DomainError
) -> JSONResponse:
    """Map any domain-level business-rule violation to its HTTP response.

    Status and detail come straight off the exception, so the response is
    identical to the former per-endpoint ``HTTPException`` mapping — and the
    frontend's machine-readable error contract is unchanged.
    """
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(Exception)
async def _unhandled_exception_handler(
    request: Request, exc: Exception
) -> JSONResponse:
    """Catch-all for anything not already mapped to a response.

    Starlette's exception middleware picks the most specific registered
    handler for the raised type, so this only fires when neither FastAPI's
    built-ins (HTTPException, RequestValidationError) nor DomainError above
    matched — i.e. a genuine bug. Without it, such an error would still 500,
    but silently, with nothing in the pocketlog.* log namespace to find it by.
    The response stays a generic message: the real detail belongs in the log,
    not in a payload a client could see.
    """
    logger.error(
        "unhandled exception method=%s path=%s",
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(status_code=500, content={"detail": "internal_error"})


# Content-Security-Policy — set in the backend because SWAG's ssl.conf does
# not configure one. The remaining security headers (HSTS, X-Frame-Options,
# X-Content-Type-Options, Referrer-Policy, X-Download-Options) are already
# emitted by SWAG via /config/nginx/ssl.conf and are intentionally NOT set
# here to avoid duplicate response headers (nginx `add_header` appends to
# upstream headers, not replaces).
#
# CSP notes:
# - 'unsafe-inline' for script/style is required because index.html ships an
#   inline theme-bootstrap script and the app uses `onclick="..."` attributes
#   plus inline `style="--cat-color:..."`. A nonce-based policy would be
#   stricter but requires refactoring every inline handler.
# - frame-ancestors 'none' tightens SWAG's X-Frame-Options SAMEORIGIN for
#   PocketLog only and is the modern, authoritative anti-clickjacking
#   directive (browsers honour it over X-Frame-Options when both are present).
# - connect-src 'self' constrains fetch/XHR to same-origin; the configurable
#   "API-Basis-URL" feature works only inside the same origin, which matches
#   the supported same-origin deployment.
CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "manifest-src 'self'; "
    "worker-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'none'; "
    "form-action 'self'; "
    "object-src 'none'"
)


_SHELL_NO_CACHE_PATHS = frozenset(
    {
        "/",
        "/index.html",
        "/app.js",
        "/utils.js",
        "/reportsData.js",
        "/sw.js",
        "/db.js",
        "/styles.css",
        "/manifest.webmanifest",
    }
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", CSP_POLICY)
        path = request.url.path
        # Auth-Endpoints: niemals cachen. Defense-in-depth gegen SW-Caches,
        # Browser-HTTP-Cache, SWAG-Proxies oder zukünftige CDNs — eine
        # stale Antwort hier kann den Frontend in eine View setzen, zu
        # der die echte Session nicht passt.
        if path.startswith("/api/auth/"):
            response.headers["Cache-Control"] = "no-store"
        elif path in _SHELL_NO_CACHE_PATHS:
            # Shell-Files immer revalidieren. Vor allem /sw.js — iOS
            # Safari hält den alten Worker sonst tagelang fest, und ein
            # stale SW kann die /api/auth/me-Response cachen oder das
            # Frontend an einen eingefrorenen DOM-State binden, obwohl
            # die Session längst weg ist (genau das Symptom, das PR #80
            # zwar im SW-Code, aber nicht in der HTTP-Cache-Schicht
            # adressiert hat).
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


app.add_middleware(SecurityHeadersMiddleware)

app.include_router(routers.health.router)
app.include_router(routers.auth.router)
app.include_router(routers.categories.router)
app.include_router(routers.goals.router)
app.include_router(routers.budgets.router)
app.include_router(routers.tags.router)
app.include_router(routers.settings.router)
app.include_router(routers.recurring.router)
app.include_router(routers.transactions.router)
app.include_router(routers.imexport.router)
app.include_router(routers.api_keys.router)
app.include_router(routers.admin.router)


# ---------------------------------------------------------------------
# PWA Static Files
# ---------------------------------------------------------------------
# Located at /app/static in the image (see Dockerfile). Must be mounted last
# so that /api/* routes take precedence.
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
