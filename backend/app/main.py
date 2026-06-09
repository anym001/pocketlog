import csv
import io
import logging
import os
from datetime import date as date_type
from pathlib import Path

from fastapi import (
    FastAPI,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError
from starlette.middleware.base import BaseHTTPMiddleware

from . import (
    auth,
    constants,
    crud,
    errors,
    exceptions,
    models,
    recurring,
    routers,
    schemas,
)
from .deps import (
    DB,
    AdminUser,
    CurrentUser,
)
from .logging_config import client_ip, configure_logging

# Configure the pocketlog logger namespace at import time, so it applies under
# uvicorn (which imports app.main:app) as well as under pytest and the CLI.
configure_logging()

logger = logging.getLogger("pocketlog.api")
audit = logging.getLogger("pocketlog.audit")

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
app.include_router(routers.tags.router)
app.include_router(routers.settings.router)


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


@app.get("/api/admin/users", response_model=list[schemas.AdminUserOut])
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
        raise errors.conflict("username_taken")
    audit.info(
        "admin.user.create actor_admin_id=%s new_user_id=%s username=%s ip=%s",
        _admin.id,
        user.id,
        user.username,
        client_ip(request),
    )
    return _user_to_admin_out(user)


@app.post("/api/admin/users/{user_id}/reset-password", status_code=204)
def admin_reset_password(
    user_id: int,
    payload: schemas.AdminPasswordReset,
    request: Request,
    db: DB,
    admin: AdminUser,
):
    # Self-reset would dump the admin into the force-change view and revoke
    # all their own sessions — an instant self-lockout. Resetting another
    # admin is allowed; only self is blocked (allow_admin_target=True).
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=True
    )
    crud.set_user_password(db, target, payload.new_password, force_change=True)
    # Sicherheit: alle Sessions des betroffenen Users wegwerfen, damit
    # ein bereits eingeloggter Tab nicht weiterläuft.
    revoked = auth.revoke_all_user_sessions(db, target.id)
    audit.info(
        "auth.password.reset_admin actor_admin_id=%s target_id=%s "
        "ip=%s revoked_count=%s",
        admin.id,
        target.id,
        client_ip(request),
        revoked,
    )
    return Response(status_code=204)


@app.post("/api/admin/users/{user_id}/deactivate", status_code=204)
def admin_deactivate(user_id: int, request: Request, db: DB, admin: AdminUser):
    # Neither self nor another admin: deactivating an admin could leave the
    # instance with zero admins.
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=False
    )
    crud.deactivate_user(db, target)
    revoked = auth.revoke_all_user_sessions(db, target.id)
    audit.info(
        "admin.user.deactivate actor_admin_id=%s target_id=%s ip=%s revoked_count=%s",
        admin.id,
        target.id,
        client_ip(request),
        revoked,
    )
    return Response(status_code=204)


@app.post("/api/admin/users/{user_id}/activate", status_code=204)
def admin_activate(user_id: int, request: Request, db: DB, admin: AdminUser):
    # Self is always active (else this admin wouldn't be here); reactivating
    # another admin is fine, so only self is blocked.
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=True
    )
    crud.activate_user(db, target)
    audit.info(
        "admin.user.activate actor_admin_id=%s target_id=%s ip=%s",
        admin.id,
        target.id,
        client_ip(request),
    )
    return Response(status_code=204)


@app.delete("/api/admin/users/{user_id}", status_code=204)
def admin_delete_user(user_id: int, request: Request, db: DB, admin: AdminUser):
    # Symmetric with deactivate: neither self nor another admin may be
    # deleted, keeping the admin-count invariant intact.
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=False
    )
    crud.delete_user(db, target)
    audit.info(
        "admin.user.delete actor_admin_id=%s target_id=%s ip=%s",
        admin.id,
        target.id,
        client_ip(request),
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Recurring Rules
# ---------------------------------------------------------------------
# Templates for auto-booked transactions. The catch-up engine
# (app.recurring) materializes due occurrences on each /auth/me and
# /transactions read; this CRUD only manages the templates.


@app.get("/api/recurring", response_model=list[schemas.RecurringRuleOut])
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
    except IntegrityError:
        raise errors.conflict("rule name exists")
    audit.info(
        "recurring.create id=%s rule_id=%s freq=%s interval=%s materialized=%s ip=%s",
        user.id,
        rule.id,
        rule.frequency,
        rule.interval,
        count,
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
    except IntegrityError:
        raise errors.conflict("rule name exists")
    if rule is None:
        raise errors.not_found()
    audit.info(
        "recurring.update id=%s rule_id=%s ip=%s",
        user.id,
        rule_id,
        client_ip(request),
    )
    return rule


@app.delete("/api/recurring/{rule_id}", status_code=204)
def remove_recurring(rule_id: int, request: Request, user: CurrentUser, db: DB):
    if not crud.delete_recurring_rule(db, user.id, rule_id):
        raise errors.not_found()
    audit.info(
        "recurring.delete id=%s rule_id=%s ip=%s",
        user.id,
        rule_id,
        client_ip(request),
    )
    return Response(status_code=204)


@app.post(
    "/api/recurring/{rule_id}/skip-next",
    response_model=schemas.RecurringSkipOut,
)
def post_recurring_skip_next(rule_id: int, user: CurrentUser, db: DB):
    result = crud.skip_next_occurrence(db, user.id, rule_id)
    if result is None:
        raise errors.not_found()
    skipped, nxt = result
    return schemas.RecurringSkipOut(skipped_date=skipped, next_occurrence_date=nxt)


@app.delete("/api/recurring/{rule_id}/skip/{skip_date}", status_code=204)
def remove_recurring_skip(rule_id: int, skip_date: str, user: CurrentUser, db: DB):
    try:
        d = date_type.fromisoformat(skip_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid date")
    if not crud.remove_skip(db, user.id, rule_id, d):
        raise errors.not_found()
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
            user.id,
            n,
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
    # A foreign category raises UnknownCategoryError -> 400 (global handler).
    return crud.create_transaction(db, user.id, payload)


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
    tx = crud.update_transaction(db, user.id, tx_id, payload)
    if tx is None:
        raise errors.not_found()
    return tx


@app.delete("/api/transactions/{tx_id}", status_code=204)
def remove_transaction(tx_id: int, user: CurrentUser, db: DB):
    if not crud.delete_transaction(db, user.id, tx_id):
        raise errors.not_found()
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
        user.id,
        client_ip(request),
        count,
    )
    return Response(status_code=204)


@app.delete("/api/admin/all-data", status_code=204)
def reset_all_data(request: Request, user: CurrentUser, db: DB):
    crud.delete_all_user_data(db, user.id)
    audit.info(
        "data.reset_all_data id=%s ip=%s",
        user.id,
        client_ip(request),
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------
# CSV-Import
# ---------------------------------------------------------------------


@app.post("/api/import/csv", response_model=schemas.ImportResult)
async def import_csv(file: UploadFile, user: CurrentUser, db: DB):
    raw = await file.read()
    if len(raw) > constants.MAX_IMPORT_BYTES:
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
    return crud.import_csv(db, user.id, text, max_rows=constants.MAX_IMPORT_ROWS)


# ---------------------------------------------------------------------
# CSV-Export
# ---------------------------------------------------------------------


def _csv_safe(value: str) -> str:
    # CSV formula-injection guard; prefix set documented in app.constants.
    if value and value[0] in constants.CSV_FORMULA_PREFIXES:
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
