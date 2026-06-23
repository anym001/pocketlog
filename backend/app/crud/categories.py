"""Category CRUD plus the shared category-ownership helpers.

``_owned_category_exists`` lives here because it is the canonical
"does this user own this category" check, consumed by goals, recurring
rules and transactions alike. ``get_or_create_category`` is the CSV-import
entry point. ``_seed_default_categories`` provisions a new user's starter
set and is called from the users module.
"""

from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import exceptions, models, schemas
from ._shared import _get_owned
from .defaults import DEFAULT_CATEGORIES, DEFAULT_CATEGORY_NAMES, DEFAULT_LOCALE

# Entities that block category deletion, paired with the error each raises.
# Checked in order by delete_category; extend this when a new entity gains a
# category_id FK instead of adding another inline guard block.
_CATEGORY_DELETE_GUARDS = (
    (models.Transaction, exceptions.CategoryInUseError),
    (models.Goal, exceptions.CategoryHasGoalError),
    (models.RecurringRule, exceptions.CategoryHasRecurringRuleError),
    (models.Budget, exceptions.CategoryHasBudgetError),
)


def _seed_default_categories(
    db: Session, user_id: int, locale: str = DEFAULT_LOCALE, *, commit: bool = True
) -> None:
    bundle = schemas.bundle_for_locale(locale)
    names = DEFAULT_CATEGORY_NAMES.get(bundle, DEFAULT_CATEGORY_NAMES["de"])
    for c in DEFAULT_CATEGORIES:
        db.add(
            models.Category(
                user_id=user_id,
                name=names[c["key"]],
                icon=c["icon"],
                color=c["color"],
            )
        )
    if commit:
        db.commit()


def list_categories(db: Session, user_id: int) -> list[models.Category]:
    return list(
        db.scalars(
            select(models.Category)
            .where(models.Category.user_id == user_id)
            .order_by(models.Category.id)
        )
    )


def get_or_create_category(db: Session, user_id: int, name: str) -> models.Category:
    # CSV import path lands here with raw cell content — apply the same
    # control-char strip as schemas._normalise_name so a CSV with a NUL
    # in the category column can't insert an unreachable row.
    name = schemas._CONTROL_CHARS.sub("", name or "").strip() or "Sonstiges"
    cat = db.scalar(
        select(models.Category).where(
            and_(models.Category.user_id == user_id, models.Category.name == name)
        )
    )
    if cat is not None:
        return cat
    cat = models.Category(
        user_id=user_id, name=name[:100], icon="package", color="#9e9b96"
    )
    db.add(cat)
    db.flush()
    return cat


def create_category(
    db: Session, user_id: int, payload: schemas.CategoryCreate
) -> models.Category:
    cat = models.Category(user_id=user_id, **payload.model_dump())
    db.add(cat)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(cat)
    return cat


def update_category(
    db: Session,
    user_id: int,
    category_id: int,
    payload: schemas.CategoryUpdate,
) -> models.Category | None:
    cat = _get_owned(db, models.Category, user_id, category_id)
    if cat is None:
        return None
    for k, v in payload.model_dump().items():
        setattr(cat, k, v)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(cat)
    return cat


def delete_category(db: Session, user_id: int, category_id: int) -> bool:
    cat = _get_owned(db, models.Category, user_id, category_id)
    if cat is None:
        return False
    # Every entity that references a category blocks its deletion rather than
    # letting the FK cascade (Goal/Budget would be silently orphaned) or fail
    # with an opaque IntegrityError (Transaction/RecurringRule are RESTRICT).
    # The user must remove the referencing entity first. New 1:1/owning
    # entities only add a row here — keep the order stable (most common
    # reference first) so the surfaced error is predictable.
    for ref_model, error in _CATEGORY_DELETE_GUARDS:
        referenced = db.scalar(
            select(ref_model.id).where(ref_model.category_id == category_id).limit(1)
        )
        if referenced is not None:
            raise error()
    db.delete(cat)
    db.commit()
    return True


def _owned_category_exists(db: Session, user_id: int, category_id: int) -> bool:
    return (
        db.scalar(
            select(models.Category.id)
            .where(
                and_(
                    models.Category.id == category_id,
                    models.Category.user_id == user_id,
                )
            )
            .limit(1)
        )
        is not None
    )
