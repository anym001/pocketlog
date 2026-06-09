"""Shared FastAPI auth plumbing: session-cookie I/O and the dependency chain.

Extracted from ``main.py`` so the per-domain routers (``app.routers.*``) can
share the auth dependencies and cookie handling without importing the app
module — that would create an import cycle (``main`` imports the routers, a
router importing ``main`` back would not resolve).

This is the *HTTP-layer* auth wiring (cookies, CSRF header check, the
``Depends`` chain). The session/CSRF/brute-force *logic* lives in ``auth.py``;
this module only adapts it to FastAPI request/response objects.
"""

import os
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from . import auth, models
from .database import get_db

# Cookie attributes. `Secure` is on by default; flip via
# SESSION_COOKIE_SECURE=0 only for local HTTP dev where the cookie would
# otherwise never be sent at all. SameSite=Lax is the right balance for
# a SPA hosted same-origin behind a reverse proxy: it blocks classic
# cross-site POSTs while still letting bookmark/typed-URL navigations
# carry the cookie. The defense-in-depth against CSRF is the
# X-CSRF-Token header (double-submit cookie).
SESSION_COOKIE_NAME = "pocketlog_session"
CSRF_COOKIE_NAME = "pocketlog_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"
COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "1") != "0"
COOKIE_PATH = "/"
COOKIE_SAMESITE = "lax"


# ---------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------


def set_session_cookies(
    response: Response,
    plain_token: str,
    csrf_token: str,
    *,
    remember_me: bool,
) -> None:
    """Setzt das Session- und das CSRF-Cookie. Beide haben dieselbe
    Lebensdauer; das CSRF-Cookie ist NICHT HttpOnly, damit der
    Frontend-JS-Code es lesen und im ``X-CSRF-Token``-Header
    zurückschicken kann (Double-Submit-Pattern)."""
    max_age = auth.cookie_max_age_seconds(remember_me)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=plain_token,
        max_age=max_age,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path=COOKIE_PATH,
    )
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        max_age=max_age,
        httponly=False,
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path=COOKIE_PATH,
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(
        SESSION_COOKIE_NAME,
        path=COOKIE_PATH,
        samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        httponly=True,
    )
    response.delete_cookie(
        CSRF_COOKIE_NAME,
        path=COOKIE_PATH,
        samesite=COOKIE_SAMESITE,
        secure=COOKIE_SECURE,
        httponly=False,
    )


def _refresh_cookie_if_needed(
    response: Response, session: models.Session, refreshed: bool
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
        secure=COOKIE_SECURE,
        samesite=COOKIE_SAMESITE,
        path=COOKIE_PATH,
    )


# ---------------------------------------------------------------------
# Auth dependencies
# ---------------------------------------------------------------------


def _unauthorized(response: Response) -> HTTPException:
    """401 + leere Cookies. Verhindert, dass der Browser denselben
    kaputten Cookie immer wieder mitschickt."""
    clear_session_cookies(response)
    return HTTPException(status_code=401, detail="unauthorized")


def get_current_user(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> models.User:
    plain = request.cookies.get(SESSION_COOKIE_NAME)
    if not plain:
        raise _unauthorized(response)
    session = auth.get_session_by_token(db, plain)
    if session is None:
        raise _unauthorized(response)
    user = db.get(models.User, session.user_id)
    if user is None or not user.is_active:
        # User wurde gelöscht oder deaktiviert: Session ungültig.
        auth.revoke_session(db, session)
        raise _unauthorized(response)

    # CSRF-Check für alle non-safe Methoden. GET/HEAD/OPTIONS sind
    # idempotent und brauchen den Header nicht — wir wollen sonst auch
    # einfache Browser-Navigation aus dem PWA-Shell heraus nicht
    # blockieren.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        sent = request.headers.get(CSRF_HEADER_NAME, "")
        if not sent or not auth.constant_time_eq(sent, session.csrf_token):
            raise HTTPException(status_code=403, detail="csrf_mismatch")

    refreshed = auth.refresh_session_if_needed(db, session)
    _refresh_cookie_if_needed(response, session, refreshed)
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
