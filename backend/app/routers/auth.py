"""Auth endpoints: setup, login/logout, the /me probe and self password change.

Audit events are emitted here (the endpoint layer has the request IP and the
DB facts); auth.py/crud.py stay audit-free per the project convention.
"""

import logging

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import auth, crud, errors, models, recurring, schemas
from ..deps import (
    CSRF_HEADER_NAME,
    DB,
    SESSION_COOKIE_NAME,
    RawCurrentUser,
    clear_session_cookies,
    set_session_cookies,
)
from ..logging_config import client_ip, safe

audit = logging.getLogger("pocketlog.audit")

router = APIRouter()


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


@router.get("/api/auth/setup-status", response_model=schemas.SetupStatus)
def setup_status(db: DB):
    needs, suggested = _needs_setup(db)
    return schemas.SetupStatus(
        needs_setup=needs,
        suggested_username=suggested,
        default_locale=crud.DEFAULT_LOCALE,
    )


@router.post("/api/auth/setup")
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
        raise errors.conflict("setup_already_done")

    if suggested is not None:
        # Bestand-Admin: Username ist DB-seitig vorgegeben, wir
        # akzeptieren nur das Passwort.
        user = crud.get_user_by_username(db, suggested)
        if user is None or not user.is_admin or user.password_hash is not None:
            # Race: zwischen status-check und setup hat sich der State
            # geändert. Sauber abbrechen.
            raise errors.conflict("setup_already_done")
        crud.set_user_password(db, user, payload.password, force_change=False)
        # Locale aus dem Setup-Screen auch für den migrierten Admin
        # übernehmen — seine Kategorien sind ggf. schon (deutsch) geseedet,
        # aber die UI-Locale soll der Wahl folgen.
        crud.update_settings(db, user.id, schemas.SettingsUpdate(locale=payload.locale))
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
            raise errors.conflict("setup_already_done")
        mode = "fresh"

    audit.info(
        "setup.admin_created id=%s username=%s ip=%s mode=%s",
        user.id,
        user.username,
        client_ip(request),
        mode,
    )

    # Direkt einloggen, damit die App nicht in den Login-Flow zurückfällt.
    user_agent = request.headers.get("user-agent")
    session, plain = auth.create_session(
        db, user, remember_me=False, user_agent=user_agent
    )
    set_session_cookies(
        response, plain, session.csrf_token, remember_me=False, request=request
    )
    return {"ok": True}


@router.post("/api/auth/login")
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
            safe(username),
            ip,
        )
        raise HTTPException(status_code=401, detail="invalid_credentials")

    locked = auth.current_lockout_seconds(user)
    if locked is not None:
        # Während eines aktiven Lockouts wird gar nicht erst verifiziert.
        audit.warning(
            "auth.login.during_lockout user=%s id=%s ip=%s seconds=%s",
            user.username,
            user.id,
            ip,
            locked,
        )
        return _lockout_response(response, locked)

    if not auth.verify_password(payload.password, user.password_hash):
        lockout = auth.record_failed_login(db, user)
        if lockout is not None:
            audit.warning(
                "auth.login.lockout_triggered user=%s id=%s ip=%s seconds=%s",
                user.username,
                user.id,
                ip,
                lockout,
            )
            return _lockout_response(response, lockout)
        audit.warning(
            "auth.login.failure username=%s ip=%s reason=bad_password",
            safe(username),
            ip,
        )
        raise HTTPException(status_code=401, detail="invalid_credentials")

    auth.clear_failed_login(db, user)
    session, plain = auth.create_session(
        db, user, remember_me=payload.remember_me, user_agent=user_agent
    )
    set_session_cookies(
        response,
        plain,
        session.csrf_token,
        remember_me=payload.remember_me,
        request=request,
    )
    audit.info(
        "auth.login.success user=%s id=%s ip=%s ua=%s",
        user.username,
        user.id,
        ip,
        safe(user_agent or "unknown"),
    )
    # Symmetric with /api/auth/me: run the recurring catch-up so the
    # "N transactions added automatically" banner also fires on the
    # first request after a long-paused user comes back. Skipped when
    # the user lands in the force-change-password view, mirroring the
    # /me path.
    materialized = 0
    if not user.force_change_password:
        materialized = recurring.catch_up_safely(db, user)
        if materialized:
            audit.info(
                "recurring.catchup id=%s count=%s trigger=login",
                user.id,
                materialized,
            )
    return {
        "user": schemas.UserMe(
            id=user.id,
            username=user.username,
            is_admin=user.is_admin,
            force_change_password=user.force_change_password,
            csrf_token=session.csrf_token,
            recurring_materialized_count=materialized,
        )
    }


def _lockout_response(response: Response, seconds: int) -> Response:
    """429 + Retry-After. JSON-Body damit das Frontend einen
    sprechenden Hinweis zeigen kann."""
    body = f'{{"detail":"too_many_attempts","retry_after":{seconds}}}'
    r = Response(
        content=body,
        status_code=429,
        media_type="application/json",
        headers={"Retry-After": str(seconds)},
    )
    # Auch hier saubere Cookies — falls noch ein altes Cookie hängt.
    clear_session_cookies(r)
    return r


@router.post("/api/auth/logout", status_code=204)
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
    clear_session_cookies(response, request)
    return Response(status_code=204)


@router.get("/api/auth/me", response_model=schemas.UserMe)
def auth_me(request: Request, response: Response, db: DB, user: RawCurrentUser):
    # Opportunistic housekeeping: prune expired sessions system-wide. Damped
    # internally, so this is a no-op on most requests. /me is called on
    # every app boot/reload, making it a reliable, traffic-proportional hook
    # without a separate cron/scheduler.
    auth.maybe_cleanup_expired_sessions(db)
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
                user.id,
                materialized,
            )
    return schemas.UserMe(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        force_change_password=user.force_change_password,
        csrf_token=csrf,
        recurring_materialized_count=materialized,
    )


@router.post("/api/auth/change-password", status_code=204)
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
            raise HTTPException(status_code=400, detail="current_password_wrong")
        if payload.new_password == payload.current_password:
            raise HTTPException(status_code=400, detail="password_reused")
    crud.set_user_password(db, user, payload.new_password, force_change=False)
    # Alle anderen Sessions des Users invalidieren — bei einer
    # Passwort-Änderung kann der Auslöser eine Kompromittierung
    # gewesen sein.
    current_session_id = getattr(request.state, "session_id", None)
    revoked = auth.revoke_all_user_sessions(db, user.id, except_id=current_session_id)
    audit.info(
        "auth.password.change_self id=%s ip=%s revoked_count=%s",
        user.id,
        client_ip(request),
        revoked,
    )
    return Response(status_code=204)
