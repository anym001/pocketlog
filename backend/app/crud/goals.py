"""Goal CRUD. A goal is 1:1 with a category (``uq_goals_user_category``);
the ownership of the linked category is validated through the shared
``categories._owned_category_exists`` helper.
"""

from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import exceptions, models, schemas
from .categories import _owned_category_exists


def list_goals(db: Session, user_id: int) -> list[models.Goal]:
    return list(
        db.scalars(
            select(models.Goal)
            .where(models.Goal.user_id == user_id)
            .order_by(models.Goal.id)
        )
    )


def create_goal(db: Session, user_id: int, payload: schemas.GoalCreate) -> models.Goal:
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.CategoryNotFoundError()
    goal = models.Goal(user_id=user_id, **payload.model_dump())
    db.add(goal)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(goal)
    return goal


def update_goal(
    db: Session,
    user_id: int,
    goal_id: int,
    payload: schemas.GoalUpdate,
) -> models.Goal | None:
    goal = db.scalar(
        select(models.Goal).where(
            and_(
                models.Goal.id == goal_id,
                models.Goal.user_id == user_id,
            )
        )
    )
    if goal is None:
        return None
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.CategoryNotFoundError()
    for k, v in payload.model_dump().items():
        setattr(goal, k, v)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(goal)
    return goal


def delete_goal(db: Session, user_id: int, goal_id: int) -> bool:
    goal = db.scalar(
        select(models.Goal).where(
            and_(
                models.Goal.id == goal_id,
                models.Goal.user_id == user_id,
            )
        )
    )
    if goal is None:
        return False
    db.delete(goal)
    db.commit()
    return True
