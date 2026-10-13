"""Category CRUD plus the shared category-ownership helpers.

``_owned_category_exists`` lives here because it is the canonical
"does this user own this category" check, consumed by goals, recurring
rules and transactions alike. ``get_or_create_category`` is the CSV-import
entry point. ``_seed_default_categories`` provisions a new user's starter
set and is called from the users module.
"""

from datetime import date as date_type
from datetime import timedelta

from sqlalchemy import and_, case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import exceptions, models, schemas
from ._shared import _get_owned
from .defaults import DEFAULT_CATEGORIES, DEFAULT_CATEGORY_NAMES, DEFAULT_LOCALE

# Window for the usage counts returned by ``list_categories``; kept in step
# with tags.TAG_COUNT_WINDOW_DAYS so both choosers rank over the same period.
CATEGORY_COUNT_WINDOW_DAYS = 90

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
    """Plain listing, ORM rows. Backup and CSV export read these by attribute
    and have no use for usage counts — those live in the sibling below."""
    return list(
        db.scalars(
            select(models.Category)
            .where(models.Category.user_id == user_id)
            .order_by(models.Category.id)
        )
    )


def list_categories_with_usage(db: Session, user_id: int) -> list[dict]:
    """Categories plus their recent usage, split by transaction type, and
    their all-time booking count (``count_total``).

    The counts drive the frontend's category chooser: it shows only the top
    two rows of chips and reaches the rest through search, so the ranking is
    what decides whether the everyday booking is one tap. Splitting by type
    keeps income categories out of the way while booking an expense.

    Same 90-day window as ``tags.list_tags`` — long enough to carry the
    quarterly rhythm, short enough that a category you have stopped using
    drops out of the visible rows. Shaped like ``list_tags``'s LEFT JOIN so
    a category with no transactions still comes back, with count 0.
    """
    cutoff = date_type.today() - timedelta(days=CATEGORY_COUNT_WINDOW_DAYS)
    recent = case((models.Transaction.date >= cutoff, 1), else_=0)
    recent_in = case(
        (and_(models.Transaction.date >= cutoff, models.Transaction.type == "in"), 1),
        else_=0,
    )
    recent_out = case(
        (and_(models.Transaction.date >= cutoff, models.Transaction.type == "out"), 1),
        else_=0,
    )
    rows = db.execute(
        select(
            models.Category,
            func.coalesce(func.sum(recent), 0),
            func.coalesce(func.sum(recent_in), 0),
            func.coalesce(func.sum(recent_out), 0),
            # All-time, unwindowed: what the category list shows, so a 0
            # there means "never used". COUNT of a column skips the NULLs
            # the LEFT JOIN yields for a category without transactions.
            func.count(models.Transaction.id),
        )
        .select_from(models.Category)
        .join(
            models.Transaction,
            models.Transaction.category_id == models.Category.id,
            isouter=True,
        )
        .where(models.Category.user_id == user_id)
        .group_by(models.Category.id)
        .order_by(models.Category.id)
    ).all()
    # Dicts rather than ORM rows: the counts are query results, not columns,
    # and CategoryOut reads them by name either way.
    return [
        {
            "id": cat.id,
            "name": cat.name,
            "icon": cat.icon,
            "color": cat.color,
            "count": int(count or 0),
            "count_in": int(c_in or 0),
            "count_out": int(c_out or 0),
            "count_total": int(total or 0),
        }
        for cat, count, c_in, c_out, total in rows
    ]


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
