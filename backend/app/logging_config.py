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
    LOG_FORMAT  default text   (text = human-readable line; json = one structured
                                JSON object per line for log aggregators — see
                                _JsonFormatter; invalid → text)
    LOG_FILE              unset → file logging off. A path → ALSO write logs
                          there (in addition to stderr), via a rotating handler.
                          Mount a volume at its directory to persist logs across
                          container updates (docker logs survives restarts but
                          not `docker rm`).
    LOG_FILE_MAX_BYTES    default 10485760 (10 MB) — rotate when the file hits this.
    LOG_FILE_BACKUPS      default 5 — number of rotated files to keep.

Output always goes to stderr (12-factor; `docker logs` keeps working), plus the
optional file. ``propagate=False`` so records are not also emitted by uvicorn's
root handler (no duplicate lines).
"""

from __future__ import annotations

import ipaddress
import json
import logging
import logging.config
import logging.handlers
import os

# Bootstrap logger for problems found *while* configuring logging (before our
# own handler is attached). Uses the root config, which is fine for a warning.
_bootstrap = logging.getLogger(__name__)

_configured = False

# Human-readable default. Reads as: "2026-05-31 12:00:00 WARNING pocketlog.audit
# auth.login.failure username=… ip=…". Easier to scan in `docker logs` than JSON.
# Second precision only — no milliseconds (kept out of alembic.ini too).
_TEXT_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"
_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class _JsonFormatter(logging.Formatter):
    """One structured JSON object per line (``LOG_FORMAT=json``).

    Dependency-free — emits the handful of fields a log aggregator (Loki, ELK,
    …) needs, named conventionally so ingestion needs no remapping:

        {"time", "level", "logger", "message"[, "exc_info"][, "stack_info"]}

    The timestamp matches text mode exactly (``_DATE_FORMAT``, second
    precision). The short-name filter has already mutated ``record.name``, so
    framework loggers read ``uvicorn``/``alembic`` here too, while our own
    ``pocketlog.*`` namespaces stay intact (audit remains filterable on
    ``logger == "pocketlog.audit"``). ``ensure_ascii=False`` keeps unicode
    audit fields (e.g. a username with umlauts) readable; control characters
    are still JSON-escaped, and audit call sites additionally run client input
    through ``safe()``.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "time": self.formatTime(record, _DATE_FORMAT),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack_info"] = self.formatStack(record.stack_info)
        return json.dumps(payload, ensure_ascii=False)


class _ShortLoggerNameFilter(logging.Filter):
    """Display third-party logger names by their top-level package only, so
    docker logs read ``INFO uvicorn …`` / ``INFO alembic …`` instead of
    ``uvicorn.error`` (uvicorn routes even INFO lifecycle logs through it — the
    name implies an error where there is none) or ``alembic.runtime.migration``.
    Severity stays in the level word. Our own ``pocketlog.*`` names are kept
    intact — the sub-namespace (audit/api/crud) is meaningful."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not record.name.startswith("pocketlog"):
            record.name = record.name.split(".", 1)[0]
        return True


def install_short_logger_names(*handlers: logging.Handler) -> None:
    """Attach the short-name filter to the given handlers. Used by the alembic
    migration process, which configures logging separately via alembic.ini and
    so never runs through configure_logging()'s dictConfig."""
    name_filter = _ShortLoggerNameFilter()
    for handler in handlers:
        handler.addFilter(name_filter)


def _resolve_level() -> int:
    raw = os.environ.get("LOG_LEVEL")
    if raw:
        level = getattr(logging, raw.strip().upper(), None)
        if isinstance(level, int):
            return level
        _bootstrap.warning("Invalid LOG_LEVEL=%r — using INFO", raw)
    return logging.INFO


def _resolve_format() -> str:
    """Pick the formatter name: ``text`` (default) or ``json``. An unknown
    value warns and falls back to text. The choice drives both the stderr
    handler (via dictConfig) and the optional file handler — no call site is
    affected, audit events log the same message either way."""
    raw = (os.environ.get("LOG_FORMAT") or "text").strip().lower()
    if raw in ("text", "json"):
        return raw
    _bootstrap.warning("Invalid LOG_FORMAT=%r — using text", raw)
    return "text"


def _build_formatter(fmt: str) -> logging.Formatter:
    """The Formatter instance for the chosen format, used for handlers built
    programmatically (the file handler). The stderr handler is built by
    dictConfig from the matching named formatter."""
    if fmt == "json":
        return _JsonFormatter()
    return logging.Formatter(_TEXT_FORMAT, datefmt=_DATE_FORMAT)


def _resolve_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return value
        except ValueError:
            pass
        _bootstrap.warning("Invalid %s=%r — using %d", name, raw, default)
    return default


def _attach_file_handler(level: int, fmt: str = "text") -> None:
    """If LOG_FILE is set, ALSO write to a rotating file in the chosen format.
    Best-effort: a bad path / permissions must never crash the app — we warn
    and keep stderr. Done programmatically (not in dictConfig) so a file open
    error is catchable."""
    path = (os.environ.get("LOG_FILE") or "").strip()
    if not path:
        return
    try:
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            path,
            maxBytes=_resolve_int("LOG_FILE_MAX_BYTES", 10 * 1024 * 1024),
            backupCount=_resolve_int("LOG_FILE_BACKUPS", 5),
            encoding="utf-8",
        )
        handler.setFormatter(_build_formatter(fmt))
        logging.getLogger("pocketlog").addHandler(handler)
        _bootstrap.info("File logging enabled at %s", path)
    except OSError as exc:
        # Permissions, missing mount, read-only fs … log to stderr and move on.
        _bootstrap.warning(
            "Could not open LOG_FILE=%r (%s) — file logging off", path, exc
        )


def configure_logging() -> None:
    """Attach our handler/formatter to the ``pocketlog`` logger. Idempotent —
    safe to call repeatedly (the test suite imports the app many times)."""
    global _configured
    if _configured:
        return

    level = _resolve_level()
    fmt = _resolve_format()

    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "text": {"format": _TEXT_FORMAT, "datefmt": _DATE_FORMAT},
                # Structured one-object-per-line output; selected by LOG_FORMAT=json.
                "json": {"()": _JsonFormatter},
            },
            "filters": {
                # Shorten framework logger names (uvicorn.error → uvicorn, …).
                "short_names": {"()": _ShortLoggerNameFilter},
            },
            "handlers": {
                "pocketlog_stderr": {
                    "class": "logging.StreamHandler",
                    "stream": "ext://sys.stderr",
                    "formatter": fmt,
                    "filters": ["short_names"],
                },
            },
            "loggers": {
                "pocketlog": {
                    "handlers": ["pocketlog_stderr"],
                    "level": level,
                    # Own handler only — don't also bubble to uvicorn/root.
                    "propagate": False,
                },
                # Reformat uvicorn's own loggers to our format so docker logs are
                # consistent (uvicorn defaults to "INFO:     msg" without timestamp;
                # the access logger renders the request line via record args, which
                # our %(message)s picks up). Our dictConfig runs at app import, i.e.
                # after uvicorn set up its defaults, so ours wins. propagate=False
                # keeps each line single-emitted.
                "uvicorn": {
                    "handlers": ["pocketlog_stderr"],
                    "level": level,
                    "propagate": False,
                },
                "uvicorn.error": {
                    "handlers": ["pocketlog_stderr"],
                    "level": level,
                    "propagate": False,
                },
                # Access log pinned to WARNING: the per-request "GET /… 200" lines
                # are noise that drowns out the audit events. Errors still surface
                # via uvicorn.error and the app's own logs. (Independent of
                # LOG_LEVEL on purpose — set this logger lower if you want them back.)
                "uvicorn.access": {
                    "handlers": ["pocketlog_stderr"],
                    "level": logging.WARNING,
                    "propagate": False,
                },
            },
        }
    )
    _attach_file_handler(level, fmt)
    _configured = True


def safe(value, *, max_len: int = 256) -> str:
    """Sanitise a client-controlled string for plain-text logging.

    Strips CR/LF (and other control chars) so a crafted username or
    User-Agent can't forge extra log lines, and truncates to bound length.
    Audit fields like username/user-agent run through this before logging.
    """
    s = "" if value is None else str(value)
    s = "".join(" " if (c == "\n" or c == "\r" or ord(c) < 32) else c for c in s)
    if len(s) > max_len:
        s = s[:max_len] + "…"
    return s


# ---------------------------------------------------------------------------
# Trusted-proxy list for client IP resolution.
#
# TRUSTED_PROXIES accepts a comma-separated list of IPs or CIDR ranges, or
# the special value "*" to trust all proxies (simple single-proxy setups).
# Default: empty — forwarded headers are ignored; the peer IP is used directly.
#
# Example: TRUSTED_PROXIES=172.16.0.0/12,192.168.1.1
# ---------------------------------------------------------------------------
def _parse_trusted_proxies(
    env: str,
) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network] | None:
    """Return None for wildcard (*), a list of networks otherwise."""
    raw = env.strip()
    if not raw:
        return []
    if raw == "*":
        return None  # None == trust all
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            networks.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            logging.getLogger("pocketlog").warning(
                "TRUSTED_PROXIES: invalid entry %r ignored", part
            )
    return networks


_TRUSTED_PROXY_NETWORKS = _parse_trusted_proxies(os.environ.get("TRUSTED_PROXIES", ""))


def _is_trusted_proxy(peer: str) -> bool:
    if _TRUSTED_PROXY_NETWORKS is None:
        return True  # wildcard
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in net for net in _TRUSTED_PROXY_NETWORKS)


def client_ip(request) -> str:
    """Best-effort client IP for audit context.

    Forwarded headers (X-Real-IP, X-Forwarded-For) are only trusted when the
    immediate peer (request.client.host) is listed in TRUSTED_PROXIES.  This
    prevents clients from spoofing their IP when the container port is directly
    reachable without a proxy in front.

    Set TRUSTED_PROXIES to the IP/CIDR of your reverse proxy, or "*" to trust
    all peers (equivalent to the legacy behaviour, fine for single-proxy setups
    where the container port is not directly exposed).

    Use this value for audit logging only — never for authorization or
    rate-limiting decisions.
    """
    peer = request.client.host if request.client else None
    if peer and _is_trusted_proxy(peer):
        xri = request.headers.get("x-real-ip")
        if xri:
            return xri.strip()
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    if peer:
        return peer
    return "unknown"
