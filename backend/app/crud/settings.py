"""User-settings CRUD plus the bulk data-reset operations.

The two ``delete_all_*`` functions back the self-service reset endpoints in
``routers/admin.py``; they preserve the user row and its settings, only
clearing ledger data. Deletion order respects the ON DELETE RESTRICT links
(transactions and recurring rules before categories).
"""

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models, schemas


def get_or_create_settings(db: Session, user_id: int) -> models.UserSettings:
    s = db.scalar(
        select(models.UserSettings).where(models.UserSettings.user_id == user_id)
    )
    if s is not None:
        return s
    s = models.UserSettings(user_id=user_id)
    db.add(s)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent insert — fetch the winner.
        db.rollback()
        s = db.scalar(
            select(models.UserSettings).where(models.UserSettings.user_id == user_id)
        )
        if s is None:
            raise
    else:
        db.refresh(s)
    return s


def update_settings(
    db: Session, user_id: int, payload: schemas.SettingsUpdate
) -> models.UserSettings:
    s = get_or_create_settings(db, user_id)
    data = payload.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(s, k, v)
    if data:
        db.commit()
        db.refresh(s)
    return s


def delete_all_transactions(db: Session, user_id: int) -> int:
    result = db.execute(
        delete(models.Transaction).where(models.Transaction.user_id == user_id)
    )
    db.commit()
    return result.rowcount or 0


def delete_all_user_data(db: Session, user_id: int) -> None:
    # Order matters: transactions reference categories with ON DELETE RESTRICT,
    # so the rows must go first or the categories delete raises IntegrityError.
    # Goals reference categories with ON DELETE CASCADE, but delete them
    # explicitly too so the cleanup doesn't silently depend on the DB-level
    # cascade (and on SQLite's foreign_keys pragma being on).
    db.execute(delete(models.Transaction).where(models.Transaction.user_id == user_id))
    # Recurring rules reference categories with ON DELETE RESTRICT too;
    # they must go before the categories. The link table
    # (recurring_rule_tags) and the skips table CASCADE on rule delete,
    # so a single DELETE here is enough.
    db.execute(
        delete(models.RecurringRule).where(models.RecurringRule.user_id == user_id)
    )
    db.execute(delete(models.Goal).where(models.Goal.user_id == user_id))
    # Budgets reference categories with ON DELETE CASCADE, same as goals;
    # delete them explicitly too so the cleanup doesn't silently depend on
    # the DB-level cascade (and on SQLite's foreign_keys pragma being on).
    db.execute(delete(models.Budget).where(models.Budget.user_id == user_id))
    db.execute(delete(models.Tag).where(models.Tag.user_id == user_id))
    db.execute(delete(models.Category).where(models.Category.user_id == user_id))
    db.commit()
