from datetime import date as date_type

from sqlalchemy import and_, extract, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models, schemas

DEFAULT_CATEGORIES: list[dict] = [
    {"name": "Lebensmittel", "icon": "🛒", "color": "#c8623a"},
    {"name": "Wohnen", "icon": "🏠", "color": "#8a6a4a"},
    {"name": "Mobilität", "icon": "🚗", "color": "#6a8a8a"},
    {"name": "Freizeit", "icon": "🎬", "color": "#a45ab0"},
    {"name": "Gesundheit", "icon": "💊", "color": "#3a7d5c"},
    {"name": "Sonstiges", "icon": "📦", "color": "#9e9b96"},
    {"name": "Gehalt", "icon": "💰", "color": "#3a7d5c"},
]


# ---------- Categories ----------

def ensure_default_categories(db: Session, username: str) -> None:
    existing = db.scalar(
        select(models.Category).where(models.Category.username == username).limit(1)
    )
    if existing is not None:
        return
    for c in DEFAULT_CATEGORIES:
        db.add(models.Category(username=username, **c))
    db.commit()


def list_categories(db: Session, username: str) -> list[models.Category]:
    ensure_default_categories(db, username)
    return list(
        db.scalars(
            select(models.Category)
            .where(models.Category.username == username)
            .order_by(models.Category.id)
        )
    )


def create_category(
    db: Session, username: str, payload: schemas.CategoryCreate
) -> models.Category:
    cat = models.Category(username=username, **payload.model_dump())
    db.add(cat)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(cat)
    return cat


def delete_category(db: Session, username: str, category_id: int) -> bool:
    cat = db.scalar(
        select(models.Category).where(
            and_(
                models.Category.id == category_id,
                models.Category.username == username,
            )
        )
    )
    if cat is None:
        return False
    in_use = db.scalar(
        select(models.Transaction.id).where(
            models.Transaction.category_id == category_id
        ).limit(1)
    )
    if in_use is not None:
        raise ValueError("category_in_use")
    db.delete(cat)
    db.commit()
    return True


# ---------- Transactions ----------

def list_transactions(
    db: Session, username: str, year: int, month: int | None = None
) -> list[models.Transaction]:
    q = select(models.Transaction).where(
        and_(
            models.Transaction.username == username,
            extract("year", models.Transaction.date) == year,
        )
    )
    if month is not None:
        q = q.where(extract("month", models.Transaction.date) == month)
    q = q.order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    return list(db.scalars(q))


def list_all_transactions(db: Session, username: str) -> list[models.Transaction]:
    q = (
        select(models.Transaction)
        .where(models.Transaction.username == username)
        .order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    )
    return list(db.scalars(q))


def _check_category_owned(db: Session, username: str, category_id: int) -> bool:
    return (
        db.scalar(
            select(models.Category.id).where(
                and_(
                    models.Category.id == category_id,
                    models.Category.username == username,
                )
            )
        )
        is not None
    )


def create_transaction(
    db: Session, username: str, payload: schemas.TransactionCreate
) -> models.Transaction:
    if not _check_category_owned(db, username, payload.category_id):
        raise ValueError("unknown_category")
    tx = models.Transaction(username=username, **payload.model_dump(by_alias=False))
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return tx


def update_transaction(
    db: Session, username: str, tx_id: int, payload: schemas.TransactionUpdate
) -> models.Transaction | None:
    tx = db.scalar(
        select(models.Transaction).where(
            and_(
                models.Transaction.id == tx_id,
                models.Transaction.username == username,
            )
        )
    )
    if tx is None:
        return None
    if not _check_category_owned(db, username, payload.category_id):
        raise ValueError("unknown_category")
    for k, v in payload.model_dump(by_alias=False).items():
        setattr(tx, k, v)
    db.commit()
    db.refresh(tx)
    return tx


def delete_transaction(db: Session, username: str, tx_id: int) -> bool:
    tx = db.scalar(
        select(models.Transaction).where(
            and_(
                models.Transaction.id == tx_id,
                models.Transaction.username == username,
            )
        )
    )
    if tx is None:
        return False
    db.delete(tx)
    db.commit()
    return True
