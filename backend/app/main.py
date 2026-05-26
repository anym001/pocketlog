import csv
import hmac
import io
import logging
import os
import re
from datetime import date as date_type
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.middleware.base import BaseHTTPMiddleware

from . import crud, models, schemas
from .database import get_db

logger = logging.getLogger("uvicorn.error")

# Shared secret between SWAG and the backend. Every request must carry a
# matching X-Auth-Secret header — guards against direct access to port
# 8000 with a forged X-Authentik-Username header. The backend refuses to
# start without a secret unless ALLOW_NO_AUTH_SECRET=1 is set explicitly
# (intended for local dev where port 8000 is never exposed).
AUTH_SECRET = os.environ.get("AUTH_SECRET", "").strip()
# The SWAG sample config ships with `REPLACE-ME-WITH-OPENSSL-RAND-HEX-32`
# as a deliberately conspicuous placeholder. If that string ever ends up
# in the AUTH_SECRET env, the operator forgot to generate a real secret;
# refusing to start is safer than silently accepting it as the shared
# token (which would let anyone who knows the template impersonate SWAG).
if "REPLACE-ME" in AUTH_SECRET:
    raise SystemExit(
        "AUTH_SECRET still contains the placeholder 'REPLACE-ME…' from the "
        "SWAG sample config. Generate a real secret with `openssl rand -hex 32` "
        "and set it both on this container and in SWAG's "
        "pocketlog.subdomain.conf."
    )
if not AUTH_SECRET:
    if os.environ.get("ALLOW_NO_AUTH_SECRET") != "1":
        raise SystemExit(
            "AUTH_SECRET is not set. The backend refuses to start without a "
            "shared secret with SWAG. Generate one with `openssl rand -hex 32` "
            "and set it both as the AUTH_SECRET environment variable on this "
            "container and as the X-Auth-Secret value in SWAG's "
            "pocketlog.subdomain.conf. To explicitly run without a secret "
            "(local dev only — never expose port 8000), set "
            "ALLOW_NO_AUTH_SECRET=1."
        )
    # Banner-style so this can't get lost in the uvicorn startup chatter.
    # Anyone running this configuration is one firewall mistake away from
    # a credentialless takeover; the warning has to be hard to overlook
    # when scanning `docker logs`.
    logger.warning(
        "\n"
        "================================================================\n"
        " ALLOW_NO_AUTH_SECRET=1 — running WITHOUT shared-secret auth.\n"
        " The backend blindly trusts the X-Authentik-Username header.\n"
        " Port 8000 must only be reachable through SWAG / Authentik in\n"
        " this configuration. Never expose it to the public internet.\n"
        "================================================================"
    )

# Allowlist for the X-Authentik-Username header. Authentik usernames are
# ASCII slugs (letters, digits, dot, underscore, dash) plus @ and + for
# email-style logins. Length is bound to the DB column (VARCHAR(150)).
# Rejecting whitespace, NUL bytes, control characters and Unicode prevents
# the auto-create flow in crud.get_or_create_user from materialising a
# second user row that differs from the legitimate one only by an
# invisible character (trailing space, RTL override, ZWJ).
USERNAME_RE = re.compile(r"^[A-Za-z0-9._@+\-]{1,150}$")

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


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", CSP_POLICY)
        return response


app.add_middleware(SecurityHeadersMiddleware)


def get_current_user(
    db: Annotated[Session, Depends(get_db)],
    x_authentik_username: Annotated[str | None, Header()] = None,
    x_auth_secret: Annotated[str | None, Header()] = None,
) -> models.User:
    # Both branches return the same generic detail so a direct probe on
    # port 8000 can't tell which header was wrong — that would leak how
    # far the request got past the auth boundary.
    if AUTH_SECRET and not (x_auth_secret and hmac.compare_digest(x_auth_secret, AUTH_SECRET)):
        raise HTTPException(status_code=401, detail="unauthorized")
    # Strip leading/trailing whitespace so an accidental space in the
    # Authentik header doesn't create a parallel user row, then enforce
    # the allowlist.
    username = (x_authentik_username or "").strip()
    if not username or not USERNAME_RE.match(username):
        raise HTTPException(status_code=401, detail="unauthorized")
    return crud.get_or_create_user(db, username)


CurrentUser = Annotated[models.User, Depends(get_current_user)]
DB = Annotated[Session, Depends(get_db)]


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/version")
def version() -> dict:
    return {"version": os.environ.get("APP_VERSION", "dev")}


# ---------- Categories ----------

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
        raise
    if not ok:
        raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---------- Transactions ----------

@app.get(
    "/api/transactions",
    response_model=list[schemas.TransactionOut],
    response_model_by_alias=True,
)
def get_transactions(
    user: CurrentUser,
    db: DB,
    year: int | None = Query(default=None, ge=1900, le=2999),
    month: int | None = Query(default=None, ge=1, le=12),
    date_from: str | None = Query(default=None, alias="from"),
    date_to: str | None = Query(default=None, alias="to"),
):
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


# ---------- Tags ----------

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


# ---------- Admin / Data Management ----------
# Bulk reset operations the user triggers from the Verwaltung drawer.
# User row and user_settings are preserved either way.

@app.delete("/api/admin/transactions", status_code=204)
def reset_transactions(user: CurrentUser, db: DB):
    crud.delete_all_transactions(db, user.id)
    return Response(status_code=204)


@app.delete("/api/admin/all-data", status_code=204)
def reset_all_data(user: CurrentUser, db: DB):
    crud.delete_all_user_data(db, user.id)
    return Response(status_code=204)


# ---------- User Settings ----------
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


# ---------- CSV-Import ----------

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


# ---------- CSV-Export ----------

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


# ---------- PWA Static Files ----------
# Located at /app/static in the image (see Dockerfile). Must be mounted last
# so that /api/* routes take precedence.
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
