import csv
import hmac
import io
import logging
import os
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response, UploadFile
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import crud, schemas
from .database import get_db

logger = logging.getLogger("uvicorn.error")

# Shared Secret zwischen SWAG und Backend. Wenn gesetzt, muss jeder Request
# den passenden X-Auth-Secret-Header tragen – sonst 401. Schützt gegen
# Direktzugriffe auf Port 8000 mit gefälschtem X-Authentik-Username.
AUTH_SECRET = os.environ.get("AUTH_SECRET", "").strip()
if not AUTH_SECRET:
    logger.warning(
        "AUTH_SECRET ist nicht gesetzt – das Backend vertraut blind dem "
        "X-Authentik-Username-Header. Port 8000 darf in dem Fall nur über "
        "SWAG erreichbar sein."
    )

app = FastAPI(
    title="PocketLog API",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)


def get_current_user(
    x_authentik_username: Annotated[str | None, Header()] = None,
    x_auth_secret: Annotated[str | None, Header()] = None,
) -> str:
    if AUTH_SECRET and not (x_auth_secret and hmac.compare_digest(x_auth_secret, AUTH_SECRET)):
        raise HTTPException(status_code=401, detail="invalid auth secret")
    if not x_authentik_username:
        raise HTTPException(status_code=401, detail="missing X-Authentik-Username header")
    return x_authentik_username


CurrentUser = Annotated[str, Depends(get_current_user)]
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
    return crud.list_categories(db, user)


@app.post(
    "/api/categories", response_model=schemas.CategoryOut, status_code=201
)
def post_category(payload: schemas.CategoryCreate, user: CurrentUser, db: DB):
    try:
        return crud.create_category(db, user, payload)
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
        cat = crud.update_category(db, user, category_id, payload)
    except IntegrityError:
        raise HTTPException(status_code=409, detail="category exists")
    if cat is None:
        raise HTTPException(status_code=404, detail="not found")
    return cat


@app.delete("/api/categories/{category_id}", status_code=204)
def remove_category(category_id: int, user: CurrentUser, db: DB):
    try:
        ok = crud.delete_category(db, user, category_id)
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
):
    if year is None:
        return crud.list_all_transactions(db, user)
    return crud.list_transactions(db, user, year, month)


@app.post(
    "/api/transactions",
    response_model=schemas.TransactionOut,
    response_model_by_alias=True,
    status_code=201,
)
def post_transaction(payload: schemas.TransactionCreate, user: CurrentUser, db: DB):
    try:
        return crud.create_transaction(db, user, payload)
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
        tx = crud.update_transaction(db, user, tx_id, payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if tx is None:
        raise HTTPException(status_code=404, detail="not found")
    return tx


@app.delete("/api/transactions/{tx_id}", status_code=204)
def remove_transaction(tx_id: int, user: CurrentUser, db: DB):
    if not crud.delete_transaction(db, user, tx_id):
        raise HTTPException(status_code=404, detail="not found")
    return Response(status_code=204)


# ---------- Tags ----------

@app.get("/api/tags", response_model=list[str])
def get_tags(user: CurrentUser, db: DB):
    return crud.list_tags(db, user)


@app.put("/api/tags/{name}")
def put_tag(name: str, payload: schemas.TagRename, user: CurrentUser, db: DB):
    try:
        affected = crud.rename_tag(db, user, name, payload.new_name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"affected": affected}


@app.delete("/api/tags/{name}", status_code=204)
def remove_tag(name: str, user: CurrentUser, db: DB):
    crud.delete_tag(db, user, name)
    return Response(status_code=204)


# ---------- CSV-Import ----------

MAX_IMPORT_BYTES = 5 * 1024 * 1024  # 5 MB


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
        # Fallback für Excel-Exporte unter Windows
        try:
            text = raw.decode("cp1252")
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="encoding not utf-8/cp1252")
    return crud.import_csv(db, user, text)


# ---------- CSV-Export ----------

@app.get("/api/export/csv")
def export_csv(user: CurrentUser, db: DB):
    txs = crud.list_all_transactions(db, user)
    categories = {c.id: c.name for c in crud.list_categories(db, user)}

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["date", "type", "amount", "description", "category", "tags"])
    for t in txs:
        writer.writerow(
            [
                t.date.isoformat(),
                t.type,
                f"{t.amount:.2f}",
                t.description,
                categories.get(t.category_id, ""),
                ",".join(t.tags or []),
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="pocketlog.csv"'},
    )


# ---------- PWA Static Files ----------
# Liegt im Image unter /app/static (siehe Dockerfile).  Muss als letztes
# gemountet werden, damit /api/... vorher matcht.
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")
