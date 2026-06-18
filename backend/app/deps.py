"""Shared FastAPI auth plumbing: session-cookie I/O and the dependency chain.

Extracted from ``main.py`` so the per-domain routers (``app.routers.*``) can
share the auth dependencies and cookie handling without importing the app
module — that would create an import cycle (``main`` imports the routers, a
router importing ``main`` back would not resolve).

This is the *HTTP-layer* auth wiring (cookies, CSRF header check, the
``Depends`` chain). The session/CSRF/brute-force *logic* lives in ``auth.py``;
this module only adapts it to FastAPI request/response objects.
"""

import hashlib
import json
import os
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from . import auth, crud, models
from .database import get_db

# Sliding-window damper for api_key.last_used_at updates — avoids a DB
# write on every authenticated request when the same key is used in rapid
# succession (mirrors auth.REFRESH_GRACE_SECONDS for sessions).
_API_KEY_LAST_USED_GRACE = 5 * 60  # seconds


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# Cookie attributes. SESSION_COOKIE_SECURE controls the Secure flag:
#   auto (default) — set Secure when the effective transport to the browser
#                    is HTTPS, detected via X-Forwarded-Proto or the request
#                    scheme. Correct for direct HTTPS and most reverse-proxy
#                    setups; plain-HTTP access (LAN / first-run) works without
#                    any configuration change.
#   1              — always set Secure; use when your proxy does not forward
#                    X-Forwarded-Proto but you know HTTPS is in use.
#   0              — never set Secure; use only in fully isolated environments
#                    where the Secure flag would actively cause problems.
# SameSite=Lax is the right balance for a SPA hosted same-origin behind a
# reverse proxy: it blocks classic cross-site POSTs while still letting
# bookmark/typed-URL navigations carry the cookie. The defense-in-depth
# against CSRF is the X-CSRF-Token header (double-submit cookie).
SESSION_COOKIE_NAME = "pocketlog_session"
CSRF_COOKIE_NAME = "pocketlog_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"
_COOKIE_SECURE_ENV = os.environ.get("SESSION_COOKIE_SECURE", "auto").strip().lower()
COOKIE_PATH = "/"
COOKIE_SAMESITE = "lax"


def _cookie_secure(request: Request) -> bool:
    """Derive whether the Secure flag should be set for this request.

    With SESSION_COOKIE_SECURE=auto (default) the flag tracks the effective
    browser-facing transport: X-Forwarded-Proto is consulted first so that
    HTTPS-terminating reverse proxies work out of the box, then the raw
    request scheme for direct connections. Explicit 0/1 override that logic.
    """
    if _COOKIE_SECURE_ENV == "0":
        return False
    if _COOKIE_SECURE_ENV == "1":
        return True
    # auto: honour X-Forwarded-Proto if present, else use the request scheme.
    proto = request.headers.get("x-forwarded-proto", "").lower()
    if proto:
        return proto == "https"
    return request.url.scheme == "https"


# ---------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------


def set_session_cookies(
    response: Response,
    plain_token: str,
    csrf_token: str,
    *,
    remember_me: bool,
    request: Request,
) -> None:
    """Setzt das Session- und das CSRF-Cookie. Beide haben dieselbe
    Lebensdauer; das CSRF-Cookie ist NICHT HttpOnly, damit der
    Frontend-JS-Code es lesen und im ``X-CSRF-Token``-Header
    zurückschicken kann (Double-Submit-Pattern)."""
    max_age = auth.cookie_max_age_seconds(remember_me)
    secure = _cookie_secure(request)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=plain_token,
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite=COOKIE_SAMESITE,
        path=COOKIE_PATH,
    )
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        max_age=max_age,
        httponly=False,
        secure=secure,
        samesite=COOKIE_SAMESITE,
        path=COOKIE_PATH,
    )


def clear_session_cookies(response: Response, request: Request | None = None) -> None:
    secure = _cookie_secure(request) if request is not None else False
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        path=COOKIE_PATH,
        samesite=COOKIE_SAMESITE,
        secure=secure,
        httponly=True,
    )
    response.delete_cookie(
        CSRF_COOKIE_NAME,
        path=COOKIE_PATH,
        samesite=COOKIE_SAMESITE,
        secure=secure,
        httponly=False,
    )


def _refresh_cookie_if_needed(
    response: Response, session: models.Session, refreshed: bool, request: Request
) -> None:
    """Wenn der Sliding-Refresh getriggert hat, setzen wir das
    Session-Cookie mit neuer Max-Age neu. Sonst lassen wir den Cookie
    in Ruhe — die Cookie-Lebensdauer im Browser läuft dann zwar weiter,
    aber die Server-Seite ist die Source of Truth, ein Cookie-Replay
    nach absolute_expires_at bringt nichts."""
    if not refreshed:
        return
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=session.csrf_token,
        max_age=auth.cookie_max_age_seconds(session.remember_me),
        httponly=False,
        secure=_cookie_secure(request),
        samesite=COOKIE_SAMESITE,
        path=COOKIE_PATH,
    )


# ---------------------------------------------------------------------
# Auth dependencies
# ---------------------------------------------------------------------


def _unauthorized(response: Response, request: Request | None = None) -> HTTPException:
    """401 + leere Cookies. Verhindert, dass der Browser denselben
    kaputten Cookie immer wieder mitschickt."""
    clear_session_cookies(response, request)
    return HTTPException(status_code=401, detail="unauthorized")


def get_current_user(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> models.User:
    plain = request.cookies.get(SESSION_COOKIE_NAME)
    if not plain:
        raise _unauthorized(response, request)
    session = auth.get_session_by_token(db, plain)
    if session is None:
        raise _unauthorized(response, request)
    user = db.get(models.User, session.user_id)
    if user is None or not user.is_active:
        # User wurde gelöscht oder deaktiviert: Session ungültig.
        auth.revoke_session(db, session)
        raise _unauthorized(response, request)

    # CSRF-Check für alle non-safe Methoden. GET/HEAD/OPTIONS sind
    # idempotent und brauchen den Header nicht — wir wollen sonst auch
    # einfache Browser-Navigation aus dem PWA-Shell heraus nicht
    # blockieren.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        sent = request.headers.get(CSRF_HEADER_NAME, "")
        if not sent or not auth.constant_time_eq(sent, session.csrf_token):
            raise HTTPException(status_code=403, detail="csrf_mismatch")

    refreshed = auth.refresh_session_if_needed(db, session)
    _refresh_cookie_if_needed(response, session, refreshed, request)
    # Stash on the request so request-scoped helpers (z. B. der
    # Self-Schutz für DELETE /api/admin/users/{id}) auf die Session-ID
    # kommen ohne sie nochmal aus dem Cookie zu hashen.
    request.state.session_id = session.id
    return user


def require_active_password(
    user: Annotated[models.User, Depends(get_current_user)],
) -> models.User:
    """Sperrt alle App-Endpoints, solange ``force_change_password`` an
    ist. Aufrufer (Frontend) MUSS erst ``POST /api/auth/change-password``
    aufrufen. ``/api/auth/me``, ``/api/auth/logout`` und
    ``/api/auth/change-password`` umgehen diesen Block."""
    if user.force_change_password:
        raise HTTPException(status_code=403, detail="password_change_required")
    return user


def require_admin(
    user: Annotated[models.User, Depends(require_active_password)],
) -> models.User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin_required")
    return user


CurrentUser = Annotated[models.User, Depends(require_active_password)]
AdminUser = Annotated[models.User, Depends(require_admin)]
RawCurrentUser = Annotated[models.User, Depends(get_current_user)]
DB = Annotated[Session, Depends(get_db)]


# ---------------------------------------------------------------------
# API-key auth
# ---------------------------------------------------------------------

# Scope hierarchy: holding a scope grants it plus every narrower one.
# ``write`` is the top *data* tier — it covers ``import`` and ``read`` — so a
# single key can drive a full sync client without stacking scopes. There is
# deliberately no ``admin`` *data* scope: user management, the mass-delete
# endpoints and API-key management stay session-only and are never reachable
# via a bearer token. A legacy key still stored with ``admin`` keeps full data
# access (wildcard below) but likewise never reaches those session-only paths.
_SCOPE_GRANTS: dict[str, set[str]] = {
    "read": {"read"},
    "import": {"import"},
    "write": {"write", "import", "read"},
    "admin": {"admin", "write", "import", "read"},
}


def _scope_satisfies(held: list[str], required: str) -> bool:
    """True if any scope the key holds grants *required* per the hierarchy."""
    granted: set[str] = set()
    for scope in held:
        granted |= _SCOPE_GRANTS.get(scope, {scope})
    return required in granted


def _validate_api_key_user(
    raw_key: str, required_scope: str, db: Session
) -> models.User:
    """Validate a bearer API key and return the associated user.

    Checks: key exists, not expired, has the required scope (or ``admin``),
    user is active and not force-change-password. Updates ``last_used_at``
    with a 5-min damper to avoid a DB write on every request.

    Raises ``HTTPException`` 401/403 on any failure (same semantics as the
    session-cookie path so callers treat both auth methods uniformly).
    """
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    api_key = crud.get_api_key_by_hash(db, key_hash)
    if api_key is None:
        raise HTTPException(status_code=401, detail="invalid_api_key")

    now = _utcnow()
    if api_key.expires_at is not None and api_key.expires_at <= now:
        raise HTTPException(status_code=401, detail="api_key_expired")

    scopes: list[str] = json.loads(api_key.scopes or "[]")
    if not _scope_satisfies(scopes, required_scope):
        raise HTTPException(status_code=403, detail="insufficient_scope")

    user = db.get(models.User, api_key.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="user_inactive")
    if user.force_change_password:
        raise HTTPException(status_code=403, detail="password_change_required")

    # Damped last_used_at write — avoids a commit on every API request.
    if (
        api_key.last_used_at is None
        or (now - api_key.last_used_at).total_seconds() >= _API_KEY_LAST_USED_GRACE
    ):
        api_key.last_used_at = now
        db.commit()

    return user


def require_scope(scope: str):
    """Build an auth dependency that gates an endpoint on *scope*.

    The endpoint then accepts EITHER:
    - A valid session cookie + CSRF (standard browser / PWA path). Any
      logged-in user passes — scopes constrain API keys only, never the UI.
    - An ``Authorization: Bearer <token>`` whose key scope satisfies *scope*
      per the hierarchy (``write`` ⊇ ``import``/``read``). Used by external
      automation, bridge tools and cron scripts.

    The Bearer path bypasses CSRF because the ``Authorization`` header is not
    sent automatically by browsers, so CSRF does not apply there.
    """

    def _dep(
        request: Request,
        response: Response,
        db: Annotated[Session, Depends(get_db)],
    ) -> models.User:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            return _validate_api_key_user(auth_header[7:], scope, db)
        # Fall back to session auth — raises 401/403 on missing/invalid session.
        user = get_current_user(request, response, db)
        return require_active_password(user)

    return _dep


# ``get_import_user`` kept as a named export for back-compat with existing
# imports/tests; the read/write variants gate the rest of the API surface.
get_import_user = require_scope("import")

ReadUser = Annotated[models.User, Depends(require_scope("read"))]
WriteUser = Annotated[models.User, Depends(require_scope("write"))]
ImportUser = Annotated[models.User, Depends(get_import_user)]
