import csv
import io
import logging
import os
from datetime import date as date_type
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.middleware.base import BaseHTTPMiddleware

from . import auth, crud, models, recurring, schemas
from .database import get_db
from .logging_config import client_ip, configure_logging, safe

# Configure the pocketlog logger namespace at import time, so it applies under
# uvicorn (which imports app.main:app) as well as under pytest and the CLI.
configure_logging()

logger = logging.getLogger("pocketlog.api")
audit = logging.getLogger("pocketlog.audit")

# Swagger UI and the OpenAPI schema are off by default. Both leak the full
# API surface and Swagger's "Try it out" issues real requests against this
# backend. Opt in with ENABLE_DOCS=1 when debugging — never in production.
DOCS_ENABLED = os.environ.get("ENABLE_DOCS") == "1"

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

app = FastAPI(
    title="PocketLog API",
    docs_url="/api/docs" if DOCS_ENABLED else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if DOCS_ENABLED else None,
)


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


_SHELL_NO_CACHE_PATHS = frozenset({
    "/",
    "/index.html",
    "/app.js",
    "/sw.js",
    "/db.js",
    "/styles.css",
    "/manifest.webmanifest",
})


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


# ---------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------

def _set_session_cookies(
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


def _clear_session_cookies(response: Response) -> None:
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
# Auth-Dependencies
# ---------------------------------------------------------------------

def _unauthorized(response: Response) -> HTTPException:
    """401 + leere Cookies. Verhindert, dass der Browser denselben
    kaputten Cookie immer wieder mitschickt."""
    _clear_session_cookies(response)
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
        raise HTTPException(
            status_code=403, detail="password_change_required"
        )
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
# Public endpoints
# ---------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/version")
def version() -> dict:
    return {"version": os.environ.get("APP_VERSION", "dev")}


# ---------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------

def _needs_setup(db: Session) -> tuple[bool, str | None]:
    """Setup-Modus aktiv? Falls ja, optional Username-Vorschlag.

    Drei Fälle:
    1. Gar kein User in der DB → leerer Vorschlag, der Operator gibt
       Username und Passwort frei ein.
    2. Genau ein Admin existiert, hat aber noch keinen ``password_hash``
       → das ist der via Migration promovierte Bestand-Admin. Vorschlag
       enthält seinen Username, das Frontend macht das Feld read-only.
    3. Sonst (mindestens ein Admin mit Passwort) → kein Setup mehr.
    """
    if crud.count_users(db) == 0:
        return True, None
    pending = crud.get_pending_admin(db)
    if pending is not None:
        return True, pending.username
    return False, None


@app.get("/api/auth/setup-status", response_model=schemas.SetupStatus)
def setup_status(db: DB):
    needs, suggested = _needs_setup(db)
    return schemas.SetupStatus(
        needs_setup=needs,
        suggested_username=suggested,
        default_locale=crud.DEFAULT_LOCALE,
    )


@app.post("/api/auth/setup")
def setup_admin(
    payload: schemas.SetupRequest,
    request: Request,
    response: Response,
    db: DB,
):
    needs, suggested = _needs_setup(db)
    if not needs:
        # Setup ist bereits abgeschlossen — kein Admin-Override-Pfad
        # offen lassen.
        raise HTTPException(status_code=409, detail="setup_already_done")

    if suggested is not None:
        # Bestand-Admin: Username ist DB-seitig vorgegeben, wir
        # akzeptieren nur das Passwort.
        user = crud.get_user_by_username(db, suggested)
        if user is None or not user.is_admin or user.password_hash is not None:
            # Race: zwischen status-check und setup hat sich der State
            # geändert. Sauber abbrechen.
            raise HTTPException(status_code=409, detail="setup_already_done")
        crud.set_user_password(
            db, user, payload.password, force_change=False
        )
        # Locale aus dem Setup-Screen auch für den migrierten Admin
        # übernehmen — seine Kategorien sind ggf. schon (deutsch) geseedet,
        # aber die UI-Locale soll der Wahl folgen.
        crud.update_settings(
            db, user.id, schemas.SettingsUpdate(locale=payload.locale)
        )
        mode = "migrated"
    else:
        # Fresh install: neuer Admin-User mit dem gewählten Username.
        try:
            user = crud.create_user(
                db,
                username=payload.username,
                password=payload.password,
                is_admin=True,
                force_change_password=False,
                locale=payload.locale,
            )
        except IntegrityError:
            # Race mit einem parallelen Setup-Versuch — Username
            # existiert schon. Aus Sicht des zweiten Setup-Versuchs ist
            # die DB jetzt initialisiert.
            raise HTTPException(status_code=409, detail="setup_already_done")
        mode = "fresh"

    audit.info(
        "setup.admin_created id=%s username=%s ip=%s mode=%s",
        user.id, user.username, client_ip(request), mode,
    )

    # Direkt einloggen, damit die App nicht in den Login-Flow zurückfällt.
    user_agent = request.headers.get("user-agent")
    session, plain = auth.create_session(
        db, user, remember_me=False, user_agent=user_agent
    )
    _set_session_cookies(response, plain, session.csrf_token, remember_me=False)
    return {"ok": True}


@app.post("/api/auth/login")
def login(payload: schemas.LoginRequest, request: Request, response: Response, db: DB):
    user_agent = request.headers.get("user-agent")
    username = payload.username.strip()
    user = crud.get_user_by_username(db, username) if username else None

    ip = client_ip(request)

    if user is None or not user.is_active or user.password_hash is None:
        # Konstante-Zeit-Verify gegen Dummy-Hash, damit
        # Username-Enumeration via Timing nicht funktioniert.
        auth.verify_password_dummy()
        # reason is logged server-side only — never returned to the client, so
        # it does not enable username enumeration.
        audit.warning(
            "auth.login.failure username=%s ip=%s reason=unknown_user",
            safe(username), ip,
        )
        raise HTTPException(status_code=401, detail="invalid_credentials")

    locked = auth.current_lockout_seconds(user)
    if locked is not None:
        # Während eines aktiven Lockouts wird gar nicht erst verifiziert.
        audit.warning(
            "auth.login.during_lockout user=%s id=%s ip=%s seconds=%s",
            user.username, user.id, ip, locked,
        )
        return _lockout_response(response, locked)

    if not auth.verify_password(payload.password, user.password_hash):
        lockout = auth.record_failed_login(db, user)
        if lockout is not None:
            audit.warning(
                "auth.login.lockout_triggered user=%s id=%s ip=%s seconds=%s",
                user.username, user.id, ip, lockout,
            )
            return _lockout_response(response, lockout)
        audit.warning(
            "auth.login.failure username=%s ip=%s reason=bad_password",
            safe(username), ip,
        )
        raise HTTPException(status_code=401, detail="invalid_credentials")

    auth.clear_failed_login(db, user)
    session, plain = auth.create_session(
        db, user, remember_me=payload.remember_me, user_agent=user_agent
    )
    _set_session_cookies(
        response, plain, session.csrf_token, remember_me=payload.remember_me
    )
    audit.info(
        "auth.login.success user=%s id=%s ip=%s ua=%s",
        user.username, user.id, ip, safe(user_agent or "unknown"),
    )
    return {
        "user": schemas.UserMe(
            id=user.id,
            username=user.username,
            is_admin=user.is_admin,
            force_change_password=user.force_change_password,
            csrf_token=session.csrf_token,
        )
    }


def _lockout_response(response: Response, seconds: int) -> Response:
    """429 + Retry-After. JSON-Body damit das Frontend einen
    sprechenden Hinweis zeigen kann."""
    body = '{"detail":"too_many_attempts","retry_after":%d}' % seconds
    r = Response(
        content=body,
        status_code=429,
        media_type="application/json",
        headers={"Retry-After": str(seconds)},
    )
    # Auch hier saubere Cookies — falls noch ein altes Cookie hängt.
    _clear_session_cookies(r)
    return r


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: DB):
    plain = request.cookies.get(SESSION_COOKIE_NAME)
    if plain:
        session = auth.get_session_by_token(db, plain)
        if session is not None:
            # CSRF-Check: Logout ist state-changing.
            sent = request.headers.get(CSRF_HEADER_NAME, "")
            if not sent or not auth.constant_time_eq(sent, session.csrf_token):
                raise HTTPException(status_code=403, detail="csrf_mismatch")
            user_id = session.user_id
            auth.revoke_session(db, session)
            audit.info("auth.logout id=%s ip=%s", user_id, client_ip(request))
    _clear_session_cookies(response)
    return Response(status_code=204)


@app.get("/api/auth/me", response_model=schemas.UserMe)
def auth_me(request: Request, response: Response, db: DB, user: RawCurrentUser):
    # CSRF-Token kommt aus der Session-Row, die get_current_user bereits
    # validiert hat. Wir holen sie noch einmal über die request.state-ID.
    session_id = getattr(request.state, "session_id", None)
    session = db.get(models.Session, session_id) if session_id else None
    csrf = session.csrf_token if session else ""
    # Recurring catch-up runs here so the count can be carried in the
    # response: the frontend uses it to show a one-time info banner
    # ("N Buchungen automatisch ergänzt"). Wrapped in catch_up_safely
    # so a broken rule can never block auth.
    materialized = 0
    if not user.force_change_password:
        materialized = recurring.catch_up_safely(db, user)
        if materialized:
            audit.info(
                "recurring.catchup id=%s count=%s trigger=auth_me",
                user.id, materialized,
            )
    return schemas.UserMe(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        force_change_password=user.force_change_password,
        csrf_token=csrf,
        recurring_materialized_count=materialized,
    )


@app.post("/api/auth/change-password", status_code=204)
def change_password(
    payload: schemas.ChangePasswordRequest,
    request: Request,
    response: Response,
    db: DB,
    user: RawCurrentUser,
):
    skip_verification = user.force_change_password or user.password_hash is None
    if not skip_verification:
        if payload.current_password is None or not auth.verify_password(
            payload.current_password, user.password_hash
        ):
            # Kein Lockout-Trigger — der User ist authentifiziert, das ist
            # kein Login-Brute-Force. 400 reicht.
            raise HTTPException(
                status_code=400, detail="current_password_wrong"
            )
        if payload.new_password == payload.current_password:
            raise HTTPException(
                status_code=400, detail="password_reused"
            )
    crud.set_user_password(db, user, payload.new_password, force_change=False)
    # Alle anderen Sessions des Users invalidieren — bei einer
    # Passwort-Änderung kann der Auslöser eine Kompromittierung
    # gewesen sein.
    current_session_id = getattr(request.state, "session_id", None)
    revoked = auth.revoke_all_user_sessions(
        db, user.id, except_id=current_session_id
    )
    audit.info(
        "auth.password.change_self id=%s ip=%s revoked_count=%s",
        user.id, client_ip(request), revoked,
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Admin-User-Endpoints
# ---------------------------------------------------------------------

def _user_to_admin_out(user: models.User) -> schemas.AdminUserOut:
    return schemas.AdminUserOut(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        is_active=user.is_active,
        force_change_password=user.force_change_password,
        locked_until=user.lockout_until,
        created_at=user.created_at,
    )


@app.get(
    "/api/admin/users", response_model=list[schemas.AdminUserOut]
)
def admin_list_users(db: DB, _admin: AdminUser):
    return [_user_to_admin_out(u) for u in crud.list_all_users(db)]


@app.post(
    "/api/admin/users",
    response_model=schemas.AdminUserOut,
    status_code=201,
)
def admin_create_user(
    payload: schemas.AdminUserCreate, request: Request, db: DB, _admin: AdminUser
):
    # New users inherit the creating admin's language + currency so their
    # default categories are seeded in the admin's language and the app
    # opens in the same locale (the admin can't know the user's own
    # preference yet; the user can change it later in Settings).
    admin_settings = crud.get_or_create_settings(db, _admin.id)
    try:
        user = crud.create_user(
            db,
            username=payload.username,
            password=payload.password,
            is_admin=False,
            force_change_password=True,
            locale=admin_settings.locale,
            currency=admin_settings.currency,
        )
    except IntegrityError:
        raise HTTPException(status_code=409, detail="username_taken")
    audit.info(
        "admin.user.create actor_admin_id=%s new_user_id=%s username=%s ip=%s",
        _admin.id, user.id, user.username, client_ip(request),
    )
    return _user_to_admin_out(user)


def _resolve_admin_target(user_id: int, db: Session) -> models.User:
    """Helper: lädt den Ziel-User für eine Admin-Aktion. Wirft 404 wenn
    nicht gefunden. Self-Schutz-Regeln liegen in den Endpoints, weil sie
    pro Aktion unterschiedlich sind."""
    target = crud.get_user_by_id(db, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    return target


@app.post("/api/admin/users/{user_id}/reset-password", status_code=204)
def admin_reset_password(
    user_id: int,
    payload: schemas.AdminPasswordReset,
    request: Request,
    db: DB,
    admin: AdminUser,
):
    target = _resolve_admin_target(user_id, db)
    if target.id == admin.id:
        # Würde den Admin in den Force-Change-View dumpen und alle eigenen
        # Sessions wegwerfen — UX-Falle (sofortiger Self-Lockout). Wer
        # sein Passwort ändern will, geht durch die Self-Service-View.
        raise HTTPException(status_code=403, detail="cannot_modify_self")
    crud.set_user_password(db, target, payload.new_password, force_change=True)
    # Sicherheit: alle Sessions des betroffenen Users wegwerfen, damit
    # ein bereits eingeloggter Tab nicht weiterläuft.
    revoked = auth.revoke_all_user_sessions(db, target.id)
    audit.info(
        "auth.password.reset_admin actor_admin_id=%s target_id=%s ip=%s revoked_count=%s",
        admin.id, target.id, client_ip(request), revoked,
    )
    return Response(status_code=204)


@app.post("/api/admin/users/{user_id}/deactivate", status_code=204)
def admin_deactivate(user_id: int, request: Request, db: DB, admin: AdminUser):
    target = _resolve_admin_target(user_id, db)
    if target.id == admin.id:
        raise HTTPException(status_code=403, detail="cannot_modify_self")
    if target.is_admin:
        # Admins dürfen nicht deaktiviert werden — sonst landet die App
        # in einem Zustand mit null Admins.
        raise HTTPException(status_code=403, detail="cannot_modify_admin")
    crud.deactivate_user(db, target)
    revoked = auth.revoke_all_user_sessions(db, target.id)
    audit.info(
        "admin.user.deactivate actor_admin_id=%s target_id=%s ip=%s revoked_count=%s",
        admin.id, target.id, client_ip(request), revoked,
    )
    return Response(status_code=204)


@app.post("/api/admin/users/{user_id}/activate", status_code=204)
def admin_activate(user_id: int, request: Request, db: DB, admin: AdminUser):
    target = _resolve_admin_target(user_id, db)
    if target.id == admin.id:
        # Self ist immer aktiv (sonst wäre admin oben gar nicht hier).
        raise HTTPException(status_code=403, detail="cannot_modify_self")
    crud.activate_user(db, target)
    audit.info(
        "admin.user.activate actor_admin_id=%s target_id=%s ip=%s",
        admin.id, target.id, client_ip(request),
    )
    return Response(status_code=204)


@app.delete("/api/admin/users/{user_id}", status_code=204)
def admin_delete_user(user_id: int, request: Request, db: DB, admin: AdminUser):
    target = _resolve_admin_target(user_id, db)
    if target.id == admin.id:
        raise HTTPException(status_code=403, detail="cannot_modify_self")
    if target.is_admin:
        # Symmetrisch zu deactivate: ein zweiter Admin (Testfixtures,
        # zukünftige Mehr-Admin-Erweiterung) darf nicht per DELETE
        # entfernt werden. Beim aktuellen Single-Admin-Modell kann das
        # ohnehin nicht passieren, weil ``target.id == admin.id`` oben
        # schon greift — aber die Regel macht das Modell konsistent.
        raise HTTPException(status_code=403, detail="cannot_modify_admin")
    crud.delete_user(db, target)
    audit.info(
        "admin.user.delete actor_admin_id=%s target_id=%s ip=%s",
        admin.id, target.id, client_ip(request),
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------

@app.get("/api/categories", response_model=list[schemas.CategoryOut])
def get_categories(user: CurrentUser, db: DB):
    return crud.list_categories(db, user.id)


@app.post(
    "/api/categories", response_model=schemas.CategoryOut, status_code=201
)
def post_category(payload: schemas.CategoryCreate, user: CurrentUser, db: DB):
    try:
        return crud.create_category(db, user.id, payload)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="category exists")


@app.put("/api/categories/{category_id}", response_model=schemas.CategoryOut)
def put_category(
    category_id: int,
    payload: schemas.CategoryUpdate,
    user: CurrentUser,
    db: DB,
):
    try:
        cat = crud.update_category(db, user.id, category_id, payload)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="category exists")
    if cat is None:
        raise HTTPException(status_code=404, detail="not found")
    return cat


@app.delete("/api/categories/{category_id}", status_code=204)
def remove_category(category_id: int, user: CurrentUser, db: DB):
    try:
        ok = crud.delete_category(db, user.id, category_id)
    except ValueError as e:
        if str(e) == "category_in_use":
            raise HTTPException(status_code=409, detail="category in use")
        if str(e) == "category_has_goal":
            raise HTTPException(status_code=409, detail="category has goal")
        if str(e) == "category_has_recurring_rule":
            raise HTTPException(
                status_code=409, detail="category has recurring rule"
            )
        raise
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Goals
# ---------------------------------------------------------------------

@app.get("/api/goals", response_model=list[schemas.GoalOut])
def get_goals(user: CurrentUser, db: DB):
    return crud.list_goals(db, user.id)


@app.post("/api/goals", response_model=schemas.GoalOut, status_code=201)
def post_goal(payload: schemas.GoalCreate, user: CurrentUser, db: DB):
    try:
        return crud.create_goal(db, user.id, payload)
    except ValueError as e:
        if str(e) == "category_not_found":
            raise HTTPException(status_code=422, detail="category not found")
        raise
    except IntegrityError:
        raise HTTPException(status_code=409, detail="goal exists for category")


@app.put("/api/goals/{goal_id}", response_model=schemas.GoalOut)
def put_goal(
    goal_id: int,
    payload: schemas.GoalUpdate,
    user: CurrentUser,
    db: DB,
):
    try:
        goal = crud.update_goal(db, user.id, goal_id, payload)
    except ValueError as e:
        if str(e) == "category_not_found":
            raise HTTPException(status_code=422, detail="category not found")
        raise
    except IntegrityError:
        raise HTTPException(status_code=409, detail="goal exists for category")
    if goal is None:
        raise HTTPException(status_code=404, detail="not found")
    return goal


@app.delete("/api/goals/{goal_id}", status_code=204)
def remove_goal(goal_id: int, user: CurrentUser, db: DB):
    ok = crud.delete_goal(db, user.id, goal_id)
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Recurring Rules
# ---------------------------------------------------------------------
# Templates for auto-booked transactions. The catch-up engine
# (app.recurring) materializes due occurrences on each /auth/me and
# /transactions read; this CRUD only manages the templates.

@app.get(
    "/api/recurring", response_model=list[schemas.RecurringRuleOut]
)
def get_recurring(user: CurrentUser, db: DB):
    return crud.list_recurring_rules(db, user.id)


@app.post(
    "/api/recurring",
    response_model=schemas.RecurringRuleCreateResponse,
    status_code=201,
)
def post_recurring(
    payload: schemas.RecurringRuleCreate,
    request: Request,
    user: CurrentUser,
    db: DB,
):
    try:
        rule, count = crud.create_recurring_rule(
            db, user.id, payload, today=date_type.today()
        )
    except ValueError as e:
        code = str(e)
        if code == "category_not_found":
            raise HTTPException(
                status_code=422, detail="category not found"
            )
        if code == "backdate_too_far":
            raise HTTPException(
                status_code=422, detail="backdate too far"
            )
        raise
    except IntegrityError:
        raise HTTPException(status_code=409, detail="rule name exists")
    audit.info(
        "recurring.create id=%s rule_id=%s freq=%s interval=%s "
        "materialized=%s ip=%s",
        user.id, rule.id, rule.frequency, rule.interval, count,
        client_ip(request),
    )
    return schemas.RecurringRuleCreateResponse(
        rule=schemas.RecurringRuleOut.model_validate(rule),
        materialized_count=count,
    )


@app.put(
    "/api/recurring/{rule_id}",
    response_model=schemas.RecurringRuleOut,
)
def put_recurring(
    rule_id: int,
    payload: schemas.RecurringRuleUpdate,
    request: Request,
    user: CurrentUser,
    db: DB,
):
    try:
        rule = crud.update_recurring_rule(db, user.id, rule_id, payload)
    except ValueError as e:
        if str(e) == "category_not_found":
            raise HTTPException(
                status_code=422, detail="category not found"
            )
        raise
    except IntegrityError:
        raise HTTPException(status_code=409, detail="rule name exists")
    if rule is None:
        raise HTTPException(status_code=404, detail="not found")
    audit.info(
        "recurring.update id=%s rule_id=%s ip=%s",
        user.id, rule_id, client_ip(request),
    )
    return rule


@app.delete("/api/recurring/{rule_id}", status_code=204)
def remove_recurring(
    rule_id: int, request: Request, user: CurrentUser, db: DB
):
    if not crud.delete_recurring_rule(db, user.id, rule_id):
        raise HTTPException(status_code=404, detail="not found")
    audit.info(
        "recurring.delete id=%s rule_id=%s ip=%s",
        user.id, rule_id, client_ip(request),
    )
    return Response(status_code=204)


@app.post(
    "/api/recurring/{rule_id}/skip-next",
    response_model=schemas.RecurringSkipOut,
)
def post_recurring_skip_next(
    rule_id: int, user: CurrentUser, db: DB
):
    result = crud.skip_next_occurrence(db, user.id, rule_id)
    if result is None:
        raise HTTPException(status_code=404, detail="not found")
    skipped, nxt = result
    return schemas.RecurringSkipOut(
        skipped_date=skipped, next_occurrence_date=nxt
    )


@app.delete(
    "/api/recurring/{rule_id}/skip/{skip_date}", status_code=204
)
def remove_recurring_skip(
    rule_id: int, skip_date: str, user: CurrentUser, db: DB
):
    try:
        d = date_type.fromisoformat(skip_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid date")
    if not crud.remove_skip(db, user.id, rule_id, d):
        raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Transactions
# ---------------------------------------------------------------------

@app.get(
    "/api/transactions",
    response_model=list[schemas.TransactionOut],
    response_model_by_alias=True,
)
def get_transactions(
    request: Request,
    user: CurrentUser,
    db: DB,
    year: int | None = Query(default=None, ge=1900, le=2999),
    month: int | None = Query(default=None, ge=1, le=12),
    date_from: str | None = Query(default=None, alias="from"),
    date_to: str | None = Query(default=None, alias="to"),
):
    # Secondary catch-up trigger so the ledger view is always fresh
    # even when the frontend skipped /auth/me (e.g. PWA wake on a
    # cached shell). Count is discarded — the banner is fed by
    # /auth/me. Failure is swallowed by catch_up_safely.
    n = recurring.catch_up_safely(db, user)
    if n:
        audit.info(
            "recurring.catchup id=%s count=%s trigger=transactions",
            user.id, n,
        )
    if date_from is not None or date_to is not None:
        try:
            df = date_type.fromisoformat(date_from) if date_from else None
            dt = date_type.fromisoformat(date_to) if date_to else None
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid date range")
        if df is not None and dt is not None and df > dt:
            raise HTTPException(status_code=400, detail="invalid date range")
        return crud.list_transactions_by_range(db, user.id, df, dt)
    if year is None:
        return crud.list_all_transactions(db, user.id)
    return crud.list_transactions(db, user.id, year, month)


@app.post(
    "/api/transactions",
    response_model=schemas.TransactionOut,
    response_model_by_alias=True,
    status_code=201,
)
def post_transaction(payload: schemas.TransactionCreate, user: CurrentUser, db: DB):
    try:
        return crud.create_transaction(db, user.id, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put(
    "/api/transactions/{tx_id}",
    response_model=schemas.TransactionOut,
    response_model_by_alias=True,
)
def put_transaction(
    tx_id: int,
    payload: schemas.TransactionUpdate,
    user: CurrentUser,
    db: DB,
):
    try:
        tx = crud.update_transaction(db, user.id, tx_id, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if tx is None:
        raise HTTPException(status_code=404, detail="not found")
    return tx


@app.delete("/api/transactions/{tx_id}", status_code=204)
def remove_transaction(tx_id: int, user: CurrentUser, db: DB):
    if not crud.delete_transaction(db, user.id, tx_id):
        raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------

@app.get("/api/tags", response_model=list[schemas.TagOut])
def get_tags(user: CurrentUser, db: DB):
    return crud.list_tags(db, user.id)


@app.post("/api/tags", status_code=201)
def post_tag(payload: schemas.TagCreate, user: CurrentUser, db: DB):
    try:
        tag = crud.create_tag(db, user.id, payload.name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except IntegrityError:
        raise HTTPException(status_code=409, detail="tag exists")
    return {"name": tag.name}


@app.put("/api/tags/{name}")
def put_tag(name: str, payload: schemas.TagRename, user: CurrentUser, db: DB):
    try:
        affected = crud.rename_tag(db, user.id, name, payload.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except IntegrityError:
        raise HTTPException(status_code=409, detail="tag exists")
    return {"affected": affected}


@app.delete("/api/tags/{name}", status_code=204)
def remove_tag(name: str, user: CurrentUser, db: DB):
    crud.delete_tag(db, user.id, name)
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Admin / Data Management (user-self-service despite the path)
# ---------------------------------------------------------------------
# Bulk reset operations the user triggers from the Verwaltung drawer.
# User row and user_settings are preserved either way. Paths kept under
# /api/admin/* for backwards-compat with already-queued outbox entries
# in the IndexedDB outbox — renaming would orphan those.

@app.delete("/api/admin/transactions", status_code=204)
def reset_transactions(request: Request, user: CurrentUser, db: DB):
    count = crud.delete_all_transactions(db, user.id)
    audit.info(
        "data.reset_transactions id=%s ip=%s deleted_count=%s",
        user.id, client_ip(request), count,
    )
    return Response(status_code=204)


@app.delete("/api/admin/all-data", status_code=204)
def reset_all_data(request: Request, user: CurrentUser, db: DB):
    crud.delete_all_user_data(db, user.id)
    audit.info(
        "data.reset_all_data id=%s ip=%s",
        user.id, client_ip(request),
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------
# User Settings
# ---------------------------------------------------------------------
# Mirror of the UI preferences in localStorage. The frontend renders from
# localStorage for an instant paint and reconciles with the server in the
# background — this endpoint pair is the backup that survives iOS-side
# localStorage eviction.

@app.get("/api/settings", response_model=schemas.SettingsOut)
def get_settings(user: CurrentUser, db: DB):
    return crud.get_or_create_settings(db, user.id)


@app.put("/api/settings", response_model=schemas.SettingsOut)
def put_settings(payload: schemas.SettingsUpdate, user: CurrentUser, db: DB):
    return crud.update_settings(db, user.id, payload)


# ---------------------------------------------------------------------
# CSV-Import
# ---------------------------------------------------------------------

MAX_IMPORT_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_IMPORT_ROWS = 10_000


@app.post("/api/import/csv", response_model=schemas.ImportResult)
async def import_csv(file: UploadFile, user: CurrentUser, db: DB):
    raw = await file.read()
    if len(raw) > MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="file too large (>5MB)")
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        # Fallback for Excel exports on Windows
        try:
            text = raw.decode("cp1252")
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="encoding not utf-8/cp1252")
    return crud.import_csv(db, user.id, text, max_rows=MAX_IMPORT_ROWS)


# ---------------------------------------------------------------------
# CSV-Export
# ---------------------------------------------------------------------

# Excel, Numbers and LibreOffice evaluate cell contents that start with =, +,
# -, @ or a leading tab/CR as a formula. A user-controlled field that begins
# with one of those characters would execute when the file is re-opened. Prefix
# a single quote so the cell is forced to text without losing information.
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: str) -> str:
    if value and value[0] in _CSV_FORMULA_PREFIXES:
        return "'" + value
    return value


@app.get("/api/export/csv")
def export_csv(user: CurrentUser, db: DB):
    txs = crud.list_all_transactions(db, user.id)
    categories = {c.id: c.name for c in crud.list_categories(db, user.id)}

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["date", "type", "amount", "description", "category", "tags"])
    for t in txs:
        # Each tag is escaped individually, so the joined string can only
        # start with a formula-trigger if the first tag did — which then
        # already carries the leading quote. The outer _csv_safe is kept
        # as defence-in-depth in case the per-tag rule ever changes.
        joined_tags = ",".join(_csv_safe(tag.name) for tag in t.tags)
        writer.writerow(
            [
                t.date.isoformat(),
                t.type,
                f"{t.amount:.2f}",
                _csv_safe(t.description),
                _csv_safe(categories.get(t.category_id, "")),
                _csv_safe(joined_tags),
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="pocketlog.csv"'},
    )


# ---------------------------------------------------------------------
# PWA Static Files
# ---------------------------------------------------------------------
# Located at /app/static in the image (see Dockerfile). Must be mounted last
# so that /api/* routes take precedence.
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
