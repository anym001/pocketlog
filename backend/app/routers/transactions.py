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
from ..logging_config import client_ip

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


@router.post(
    "/api/transactions/bulk",
    response_model=schemas.TransactionBulkResult,
)
def bulk_transactions(
    payload: schemas.TransactionBulk,
    request: Request,
    user: WriteUser,
    db: DB,
):
    # Declared before the /{tx_id} routes so "bulk" is matched as a literal
    # path rather than coerced into the int path param.
    action = payload.action
    if action == "set_category":
        # A foreign category raises UnknownCategoryError -> 400 (global handler).
        matched, updated = crud.bulk_set_category(
            db, user.id, payload.ids, payload.category_id
        )
    elif action == "add_tags":
        matched, updated = crud.bulk_add_tags(db, user.id, payload.ids, payload.tags)
    elif action == "remove_tags":
        matched, updated = crud.bulk_remove_tags(db, user.id, payload.ids, payload.tags)
    else:  # delete — the discriminated union admits no other value
        matched, updated = crud.bulk_delete(db, user.id, payload.ids)
    # Counts only — never the affected ids, tag names or amounts.
    audit.info(
        "transaction.bulk action=%s id=%s requested=%s matched=%s updated=%s ip=%s",
        action,
        user.id,
        len(payload.ids),
        matched,
        updated,
        client_ip(request),
    )
    return schemas.TransactionBulkResult(matched=matched, updated=updated)


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
