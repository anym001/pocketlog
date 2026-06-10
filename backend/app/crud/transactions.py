"""Transaction CRUD. Category ownership is validated through the shared
``categories._owned_category_exists`` helper; tag-name resolution goes
through the ``tags`` module so create/update share the import path with
recurring rules and CSV import.
"""

from datetime import date as date_type

from sqlalchemy import and_, extract, select
from sqlalchemy.orm import Session, selectinload

from .. import exceptions, models, schemas
from ._shared import _get_owned
from .categories import _owned_category_exists
from .tags import _resolve_tags

# Transaction.tags already has lazy='selectin' on the relationship, so
# every list endpoint gets the tags batched in via a single extra IN
# query. The explicit selectinload here is defensive — it makes the
# eager-load policy visible at the call site and survives if the
# relationship default ever changes.
_TX_TAGS_LOAD = selectinload(models.Transaction.tags)


def list_transactions(
    db: Session, user_id: int, year: int, month: int | None = None
) -> list[models.Transaction]:
    q = select(models.Transaction).where(
        and_(
            models.Transaction.user_id == user_id,
            extract("year", models.Transaction.date) == year,
        )
    )
    if month is not None:
        q = q.where(extract("month", models.Transaction.date) == month)
    q = q.options(_TX_TAGS_LOAD).order_by(
        models.Transaction.date.desc(), models.Transaction.id.desc()
    )
    return list(db.scalars(q))


def list_all_transactions(db: Session, user_id: int) -> list[models.Transaction]:
    q = (
        select(models.Transaction)
        .where(models.Transaction.user_id == user_id)
        .options(_TX_TAGS_LOAD)
        .order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    )
    return list(db.scalars(q))


def list_transactions_by_range(
    db: Session,
    user_id: int,
    date_from: date_type | None,
    date_to: date_type | None,
) -> list[models.Transaction]:
    q = select(models.Transaction).where(models.Transaction.user_id == user_id)
    if date_from is not None:
        q = q.where(models.Transaction.date >= date_from)
    if date_to is not None:
        q = q.where(models.Transaction.date <= date_to)
    q = q.options(_TX_TAGS_LOAD).order_by(
        models.Transaction.date.desc(), models.Transaction.id.desc()
    )
    return list(db.scalars(q))


def create_transaction(
    db: Session, user_id: int, payload: schemas.TransactionCreate
) -> models.Transaction:
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.UnknownCategoryError()
    data = payload.model_dump(by_alias=False)
    tag_names = data.pop("tags", None)
    tx = models.Transaction(user_id=user_id, **data)
    tx.tags = _resolve_tags(db, user_id, tag_names)
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return tx


def update_transaction(
    db: Session, user_id: int, tx_id: int, payload: schemas.TransactionUpdate
) -> models.Transaction | None:
    tx = _get_owned(db, models.Transaction, user_id, tx_id)
    if tx is None:
        return None
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.UnknownCategoryError()
    data = payload.model_dump(by_alias=False)
    tag_names = data.pop("tags", None)
    for k, v in data.items():
        setattr(tx, k, v)
    # Replacing the collection lets SQLAlchemy diff old vs new and
    # emit the minimal INSERT/DELETE set on the junction table.
    tx.tags = _resolve_tags(db, user_id, tag_names)
    db.commit()
    db.refresh(tx)
    return tx


def delete_transaction(db: Session, user_id: int, tx_id: int) -> bool:
    tx = _get_owned(db, models.Transaction, user_id, tx_id)
    if tx is None:
        return False
    db.delete(tx)
    db.commit()
    return True
