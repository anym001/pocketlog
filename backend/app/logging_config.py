"""Central logging configuration for PocketLog.

One place that owns the ``pocketlog`` logger namespace, so logging behaves
identically under uvicorn, pytest and the operator CLI — instead of implicitly
borrowing uvicorn's handlers via ``getLogger("uvicorn.error")``.

Namespaces:
    pocketlog          app root (level + handler live here)
    pocketlog.api      request/endpoint layer (main.py)
    pocketlog.crud     data layer (crud.py)
    pocketlog.audit    security-relevant events (logins, lockouts, admin actions)

Env:
    LOG_LEVEL   default INFO   (any logging level name; invalid → INFO)
    LOG_FORMAT  default text   (text = human-readable key=value; json is reserved
                                for a future structured formatter — see below)

Output goes to stderr, ``propagate=False`` so records are not also emitted by
uvicorn's root handler (no duplicate lines).
"""
from __future__ import annotations

import logging
import logging.config
import os

# Bootstrap logger for problems found *while* configuring logging (before our
# own handler is attached). Uses the root config, which is fine for a warning.
_bootstrap = logging.getLogger(__name__)

_configured = False

# Human-readable default. Reads as: "2026-05-31 12:00:00 WARNING pocketlog.audit
# auth.login.failure username=… ip=…". Easier to scan in `docker logs` than JSON.
_TEXT_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def _resolve_level() -> int:
    raw = os.environ.get("LOG_LEVEL")
    if raw:
        level = getattr(logging, raw.strip().upper(), None)
        if isinstance(level, int):
            return level
        _bootstrap.warning("Invalid LOG_LEVEL=%r — using INFO", raw)
    return logging.INFO


def _resolve_format() -> str:
    """Pick the formatter name. ``json`` is reserved for a future structured
    formatter (would need a dependency such as python-json-logger); it is not
    implemented yet, so we warn and fall back to text. Wiring it in later is a
    pure dictConfig change — no audit call-site is affected."""
    raw = (os.environ.get("LOG_FORMAT") or "text").strip().lower()
    if raw == "text":
        return "text"
    if raw == "json":
        _bootstrap.warning("LOG_FORMAT=json is not implemented yet — using text")
        return "text"
    _bootstrap.warning("Invalid LOG_FORMAT=%r — using text", raw)
    return "text"


def configure_logging() -> None:
    """Attach our handler/formatter to the ``pocketlog`` logger. Idempotent —
    safe to call repeatedly (the test suite imports the app many times)."""
    global _configured
    if _configured:
        return

    level = _resolve_level()
    fmt = _resolve_format()

    logging.config.dictConfig({
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            # Future: add a "json" formatter here and select it via _resolve_format.
            "text": {"format": _TEXT_FORMAT},
        },
        "handlers": {
            "pocketlog_stderr": {
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stderr",
                "formatter": fmt,
            },
        },
        "loggers": {
            "pocketlog": {
                "handlers": ["pocketlog_stderr"],
                "level": level,
                # Own handler only — don't also bubble to uvicorn/root.
                "propagate": False,
            },
        },
    })
    _configured = True


def client_ip(request) -> str:
    """Best-effort client IP for audit context.

    PocketLog's documented topology is behind a reverse proxy that sets
    ``X-Real-IP`` (see README nginx example); ``request.client.host`` is then
    always the proxy. We therefore prefer the forwarded headers.

    SECURITY: these headers are client-controllable and only trustworthy behind
    a trusted proxy that overwrites them. Use this value for audit logging only
    — never for authorization or rate-limiting decisions.
    """
    xri = request.headers.get("x-real-ip")
    if xri:
        return xri.strip()
    xff = request.headers.get("x-forwarded-for")
    if xff:
        # First hop is the original client in a well-behaved proxy chain.
        return xff.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
