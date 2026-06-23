"""Budget CRUD. A budget is 1:1 with a category
(``uq_budgets_user_category``); the ownership of the linked category is
validated through the shared ``categories._owned_category_exists`` helper.
A category may carry both a goal and a budget — they are independent.
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import exceptions, models, schemas
from ._shared import _get_owned
from .categories import _owned_category_exists


def list_budgets(db: Session, user_id: int) -> list[models.Budget]:
    return list(
        db.scalars(
            select(models.Budget)
            .where(models.Budget.user_id == user_id)
            .order_by(models.Budget.id)
        )
    )


def create_budget(
    db: Session, user_id: int, payload: schemas.BudgetCreate
) -> models.Budget:
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.CategoryNotFoundError()
    budget = models.Budget(user_id=user_id, **payload.model_dump())
    db.add(budget)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(budget)
    return budget


def update_budget(
    db: Session,
    user_id: int,
    budget_id: int,
    payload: schemas.BudgetUpdate,
) -> models.Budget | None:
    budget = _get_owned(db, models.Budget, user_id, budget_id)
    if budget is None:
        return None
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.CategoryNotFoundError()
    for k, v in payload.model_dump().items():
        setattr(budget, k, v)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(budget)
    return budget


def delete_budget(db: Session, user_id: int, budget_id: int) -> bool:
    budget = _get_owned(db, models.Budget, user_id, budget_id)
    if budget is None:
        return False
    db.delete(budget)
    db.commit()
    return True
