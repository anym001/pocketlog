"""Transaction CRUD plus the secondary recurring catch-up trigger.

GET /transactions also runs app.recurring.catch_up_safely so the ledger view
stays fresh even when the frontend skipped /auth/me (e.g. a PWA wake on a
cached shell). The materialized count is discarded here — the info banner is
fed by /auth/me.
"""

import logging
from datetime import date as date_type

from fastapi import APIRouter, HTTPException, Query, Request, Response

from .. import crud, errors, recurring, schemas
from ..deps import DB, ReadUser, WriteUser

audit = logging.getLogger("pocketlog.audit")

router = APIRouter()


@router.get(
    "/api/transactions",
    response_model=list[schemas.TransactionOut],
    response_model_by_alias=True,
)
def get_transactions(
    request: Request,
    user: ReadUser,
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


@router.post(
    "/api/transactions",
    response_model=schemas.TransactionOut,
    response_model_by_alias=True,
    status_code=201,
)
def post_transaction(payload: schemas.TransactionCreate, user: WriteUser, db: DB):
    # A foreign category raises UnknownCategoryError -> 400 (global handler).
    return crud.create_transaction(db, user.id, payload)


@router.put(
    "/api/transactions/{tx_id}",
    response_model=schemas.TransactionOut,
    response_model_by_alias=True,
)
def put_transaction(
    tx_id: int,
    payload: schemas.TransactionUpdate,
    user: WriteUser,
    db: DB,
):
    tx = crud.update_transaction(db, user.id, tx_id, payload)
    if tx is None:
        raise errors.not_found()
    return tx


@router.delete("/api/transactions/{tx_id}", status_code=204)
def remove_transaction(tx_id: int, user: WriteUser, db: DB):
    if not crud.delete_transaction(db, user.id, tx_id):
        raise errors.not_found()
    return Response(status_code=204)
