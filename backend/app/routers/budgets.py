"""Budget CRUD. A budget is 1:1 with a category (uq_budgets_user_category); a
second budget on the same category raises IntegrityError -> 409. Consumption is
derived in the frontend, never stored. A category may carry both a goal and a
budget — they are independent.
"""

import logging

from fastapi import APIRouter, Request, Response
from sqlalchemy.exc import IntegrityError

from .. import crud, errors, schemas
from ..deps import DB, ReadUser, WriteUser
from ..logging_config import client_ip

audit = logging.getLogger("pocketlog.audit")

router = APIRouter()


@router.get("/api/budgets", response_model=list[schemas.BudgetOut])
def get_budgets(user: ReadUser, db: DB):
    return crud.list_budgets(db, user.id)


@router.post("/api/budgets", response_model=schemas.BudgetOut, status_code=201)
def post_budget(
    payload: schemas.BudgetCreate,
    request: Request,
    user: WriteUser,
    db: DB,
):
    try:
        budget = crud.create_budget(db, user.id, payload)
    except IntegrityError:
        raise errors.conflict("budget exists for category")
    audit.info(
        "budget.create id=%s budget_id=%s category_id=%s freq=%s ip=%s",
        user.id,
        budget.id,
        budget.category_id,
        budget.frequency,
        client_ip(request),
    )
    return budget


@router.put("/api/budgets/{budget_id}", response_model=schemas.BudgetOut)
def put_budget(
    budget_id: int,
    payload: schemas.BudgetUpdate,
    request: Request,
    user: WriteUser,
    db: DB,
):
    try:
        budget = crud.update_budget(db, user.id, budget_id, payload)
    except IntegrityError:
        raise errors.conflict("budget exists for category")
    if budget is None:
        raise errors.not_found()
    audit.info(
        "budget.update id=%s budget_id=%s ip=%s",
        user.id,
        budget_id,
        client_ip(request),
    )
    return budget


@router.delete("/api/budgets/{budget_id}", status_code=204)
def remove_budget(budget_id: int, request: Request, user: WriteUser, db: DB):
    if not crud.delete_budget(db, user.id, budget_id):
        raise errors.not_found()
    audit.info(
        "budget.delete id=%s budget_id=%s ip=%s",
        user.id,
        budget_id,
        client_ip(request),
    )
    return Response(status_code=204)
