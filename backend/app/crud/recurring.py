"""Recurring-rule CRUD.

A rule is a *template* for transactions. The catch-up engine
(``app.recurring.materialize_due``) reads these on each authenticated read
and inserts real rows into ``transactions``. CRUD here only touches the rule
itself; backdating on create is handled by calling into
``recurring.materialize_due`` from ``create_recurring_rule``. ``app.recurring``
is imported lazily inside the functions to avoid a top-level cycle
(``app.recurring`` imports this package).
"""

from datetime import date as date_type

from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .. import exceptions, models, schemas
from .categories import _owned_category_exists
from .tags import _resolve_tags


def _subtract_months(anchor: date_type, months: int) -> date_type:
    """Anchor minus N months, clamping the day-of-month so Feb 30
    becomes Feb 28/29. Used for the backdate-cap check only.
    Equivalent to ``dateutil.relativedelta(months=-N)`` for this
    one-shot use, without adding a new dependency."""
    import calendar as _cal

    total_months = anchor.year * 12 + (anchor.month - 1) - months
    new_year, new_month_idx = divmod(total_months, 12)
    new_month = new_month_idx + 1
    last = _cal.monthrange(new_year, new_month)[1]
    return date_type(new_year, new_month, min(anchor.day, last))


def _load_rule(
    db: Session, user_id: int, rule_id: int
) -> "models.RecurringRule | None":
    return db.scalar(
        select(models.RecurringRule).where(
            and_(
                models.RecurringRule.id == rule_id,
                models.RecurringRule.user_id == user_id,
            )
        )
    )


def list_recurring_rules(db: Session, user_id: int) -> list[models.RecurringRule]:
    return list(
        db.scalars(
            select(models.RecurringRule)
            .where(models.RecurringRule.user_id == user_id)
            .order_by(models.RecurringRule.id)
            .options(
                selectinload(models.RecurringRule.tags),
                selectinload(models.RecurringRule.skips),
            )
        )
    )


def get_recurring_rule(
    db: Session, user_id: int, rule_id: int
) -> models.RecurringRule | None:
    return _load_rule(db, user_id, rule_id)


def _apply_rule_fields(
    rule: models.RecurringRule,
    payload: "schemas.RecurringRuleCreate | schemas.RecurringRuleUpdate",
) -> None:
    """Copy schema fields onto the ORM row (excluding tags + cursor)."""
    rule.name = payload.name
    rule.amount = payload.amount
    rule.type = payload.type
    rule.category_id = payload.category_id
    rule.description = payload.description
    rule.frequency = payload.frequency
    rule.interval = payload.interval
    rule.weekday = payload.weekday if payload.frequency == "weekly" else None
    rule.day_of_month = (
        payload.day_of_month
        if payload.frequency in ("monthly", "quarterly", "yearly")
        else None
    )
    rule.start_date = payload.start_date
    rule.end_date = payload.end_date
    rule.max_occurrences = payload.max_occurrences
    rule.active = payload.active


def create_recurring_rule(
    db: Session,
    user_id: int,
    payload: "schemas.RecurringRuleCreate",
    *,
    today: date_type,
) -> "tuple[models.RecurringRule, int]":
    """Insert a new rule and immediately materialize any backdated
    occurrences in the same transaction.

    Raises ``ValueError`` with one of the stable codes:
    - ``category_not_found`` — payload references a foreign category.
    - ``backdate_too_far`` — ``start_date`` more than
      ``MAX_BACKDATE_MONTHS`` in the past.
    """
    # Local import to avoid a top-level cycle with app.recurring -> crud.
    from .. import recurring as recurring_mod

    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.CategoryNotFoundError()

    earliest = _subtract_months(today, recurring_mod.MAX_BACKDATE_MONTHS)
    if payload.start_date < earliest:
        raise exceptions.BackdateTooFarError()

    rule = models.RecurringRule(user_id=user_id)
    _apply_rule_fields(rule, payload)
    rule.next_occurrence_date = recurring_mod.first_occurrence_on_or_after(
        rule, payload.start_date
    )
    rule.tags = _resolve_tags(db, user_id, payload.tags)
    db.add(rule)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise

    materialized = 0
    if (
        rule.next_occurrence_date is not None
        and rule.next_occurrence_date <= today
        and rule.active
    ):
        # In-transaction backdate: load the user to satisfy the
        # signature without an extra query, then materialize. Reuses
        # the same catch-up routine the request handlers call so the
        # idempotency guard applies here too.
        owner = db.get(models.User, user_id)
        materialized = recurring_mod.materialize_due(
            db, owner, today, limit=recurring_mod.DEFAULT_CATCHUP_LIMIT
        )

    db.commit()
    db.refresh(rule)
    return rule, materialized


def update_recurring_rule(
    db: Session,
    user_id: int,
    rule_id: int,
    payload: "schemas.RecurringRuleUpdate",
) -> models.RecurringRule | None:
    """Replace the rule's fields. Existing transactions are not
    touched. The cursor is recomputed from ``max(today, start_date)``
    so a backdated start date on edit does NOT trigger re-materialization
    of past occurrences — edits only affect the future.
    """
    from .. import recurring as recurring_mod

    rule = _load_rule(db, user_id, rule_id)
    if rule is None:
        return None
    if not _owned_category_exists(db, user_id, payload.category_id):
        raise exceptions.CategoryNotFoundError()

    _apply_rule_fields(rule, payload)
    rule.tags = _resolve_tags(db, user_id, payload.tags)
    today = date_type.today()
    anchor = payload.start_date if payload.start_date > today else today
    rule.next_occurrence_date = recurring_mod.first_occurrence_on_or_after(rule, anchor)
    # If the rule is paused, freeze the cursor at None so the catch-up
    # skips it cleanly regardless of dates.
    if not rule.active:
        pass  # active=False already handled by the catch-up filter
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(rule)
    return rule


def delete_recurring_rule(db: Session, user_id: int, rule_id: int) -> bool:
    rule = _load_rule(db, user_id, rule_id)
    if rule is None:
        return False
    # CASCADE on recurring_rule_skips and recurring_rule_tags cleans
    # the link rows. transactions.source_rule_id is ON DELETE SET NULL,
    # so booked history is preserved.
    db.delete(rule)
    db.commit()
    return True


def skip_next_occurrence(
    db: Session, user_id: int, rule_id: int
) -> "tuple[date_type | None, date_type | None] | None":
    """Skip the rule's currently-cached ``next_occurrence_date``.

    Returns ``(skipped_date, new_next_occurrence_date)`` on success,
    ``None`` if the rule does not exist for this user. ``skipped_date``
    is ``None`` when the rule has already terminated — in that case
    the call is a no-op (204).
    """
    from .. import recurring as recurring_mod

    rule = _load_rule(db, user_id, rule_id)
    if rule is None:
        return None
    if rule.next_occurrence_date is None or not rule.active:
        return None, None

    target = rule.next_occurrence_date
    # Composite PK fingerprints (rule_id, skip_date). A racing peer who
    # already inserted the same row would surface as IntegrityError;
    # swallow it so a double-tap is idempotent.
    skip = models.RecurringRuleSkip(rule_id=rule.id, skip_date=target)
    try:
        with db.begin_nested():
            db.add(skip)
            db.flush()
    except IntegrityError:
        pass

    # Advance the cursor exactly as the catch-up would. End conditions
    # may terminate the rule here too.
    nxt = recurring_mod.next_occurrence(rule, target)
    if nxt is None or (
        rule.max_occurrences is not None
        and rule.occurrences_count >= rule.max_occurrences
    ):
        rule.next_occurrence_date = None
        rule.active = False
    else:
        rule.next_occurrence_date = nxt
    db.commit()
    db.refresh(rule)
    return target, rule.next_occurrence_date


def remove_skip(db: Session, user_id: int, rule_id: int, skip_date: date_type) -> bool:
    """Delete a single skip entry. The cursor is *not* rewound — a
    skipped past date stays gone, only the bookkeeping disappears."""
    rule = _load_rule(db, user_id, rule_id)
    if rule is None:
        return False
    skip = db.scalar(
        select(models.RecurringRuleSkip).where(
            and_(
                models.RecurringRuleSkip.rule_id == rule.id,
                models.RecurringRuleSkip.skip_date == skip_date,
            )
        )
    )
    if skip is None:
        return False
    db.delete(skip)
    db.commit()
    return True
