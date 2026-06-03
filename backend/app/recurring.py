"""Recurring transactions — pure date math + materialization engine.

A ``RecurringRule`` carries the *intent*: frequency, interval, anchor
day, end conditions. The cached ``next_occurrence_date`` cursor is
advanced by :func:`materialize_due` on each authenticated read that
hooks the catch-up. The functions in this module are split so the
date math (``next_occurrence``, ``_clamp_day``) is testable in
isolation and the side-effecting bits (``materialize_due``,
``catch_up_safely``) sit on top.

Why no scheduler: PocketLog runs in a single uvicorn process and is
deployed standalone (no celery, no cron). The catch-up runs cheaply
in the request path (indexed scan ``WHERE active AND
next_occurrence_date <= today``) so the "trigger" is the next time
the user opens the app. See ``main.auth_me`` and
``main.get_transactions`` for the call sites.
"""
from __future__ import annotations

import calendar
import logging
from datetime import date as date_type
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import models

# Hard cap on how far into the past a rule's start_date may sit when
# the rule is created. Without this a typo (e.g. "2010" instead of
# "2026") would silently materialize thousands of rows on save.
MAX_BACKDATE_MONTHS = 36

# Per-request cap on materialized transactions. Keeps the worst-case
# /auth/me latency bounded even when a user has been away for years.
# The cursor stays at the next due date, so the rest is caught up on
# the following request. The ORDER BY in materialize_due makes this
# fair across rules — the oldest pending always wins.
DEFAULT_CATCHUP_LIMIT = 200

logger = logging.getLogger("pocketlog.api")


# ---------- pure date math ----------

def _clamp_day(year: int, month: int, day_of_month: int) -> date_type:
    """Return ``date(year, month, min(day_of_month, last_day))``.

    Reproduces Outlook's "last day of month" semantics for
    ``day_of_month=31``: a monthly rule on the 31st lands on Feb 28
    (29 in leap years), Apr 30, Jun 30, Sep 30, Nov 30, and 31 in
    every other month.
    """
    last = calendar.monthrange(year, month)[1]
    return date_type(year, month, min(day_of_month, last))


def _add_months(year: int, month: int, months: int) -> tuple[int, int]:
    """Return ``(year, month)`` shifted by ``months`` (no clamping).

    Internal helper. Output month is 1..12 and the year carries the
    overflow.
    """
    idx = (month - 1) + months
    return year + idx // 12, (idx % 12) + 1


def _terminated_by_count(rule: models.RecurringRule) -> bool:
    # occurrences_count carries a server_default of 0 but Python sees
    # None on a freshly constructed (pre-flush) ORM instance — coerce
    # so create_recurring_rule can ask "is this rule already over"
    # before the row exists.
    count = rule.occurrences_count or 0
    return (
        rule.max_occurrences is not None
        and count >= rule.max_occurrences
    )


def _terminated_by_date(
    rule: models.RecurringRule, candidate: date_type
) -> bool:
    return rule.end_date is not None and candidate > rule.end_date


def first_occurrence_on_or_after(
    rule: models.RecurringRule, anchor: date_type
) -> date_type | None:
    """Anchor the cursor for a freshly created or freshly edited rule.

    Walks the natural rhythm of the rule's frequency to the first
    valid date on or after ``anchor`` (typically ``rule.start_date``
    on create, ``max(today, payload.start_date)`` on update). Honours
    end_date / max_occurrences — returns ``None`` if the rule is
    already terminated before any occurrence happens.
    """
    if _terminated_by_count(rule):
        return None

    if rule.frequency == "daily":
        # Daily rules anchor exactly on the supplied date.
        candidate = anchor
    elif rule.frequency == "weekly":
        # Honour the anchor weekday; advance day-by-day until we hit
        # the right one, then ``anchor`` itself if it matches.
        target_weekday = rule.weekday if rule.weekday is not None else anchor.weekday()
        # weekday() is Mon=0 .. Sun=6 — matches our 0..6 storage.
        days_ahead = (target_weekday - anchor.weekday()) % 7
        from datetime import timedelta
        candidate = anchor + timedelta(days=days_ahead)
    else:
        # monthly / quarterly / yearly: clamp the requested
        # day_of_month into the anchor's month, then step the
        # frequency until we land on/after anchor.
        dom = rule.day_of_month or anchor.day
        candidate = _clamp_day(anchor.year, anchor.month, dom)
        if candidate < anchor:
            step = _frequency_step_months(rule.frequency)
            y, m = _add_months(anchor.year, anchor.month, step)
            candidate = _clamp_day(y, m, dom)

    if _terminated_by_date(rule, candidate):
        return None
    return candidate


def _frequency_step_months(frequency: str) -> int:
    if frequency == "monthly":
        return 1
    if frequency == "quarterly":
        return 3
    if frequency == "yearly":
        return 12
    raise ValueError(f"not a month-based frequency: {frequency}")


def next_occurrence(
    rule: models.RecurringRule, after: date_type
) -> date_type | None:
    """Next occurrence *strictly* after ``after``.

    Honours ``interval`` (every N units), ``weekday`` for weekly,
    ``day_of_month`` for month-based frequencies, ``end_date`` and
    ``max_occurrences`` (relative to the running
    ``rule.occurrences_count`` *before* the just-materialized one is
    counted — callers increment after the insert).
    """
    if _terminated_by_count(rule):
        return None

    interval = max(1, rule.interval or 1)

    from datetime import timedelta

    if rule.frequency == "daily":
        candidate = after + timedelta(days=interval)
    elif rule.frequency == "weekly":
        # interval=1 → next week's matching weekday; interval=N → N
        # weeks later. Anchor on the rule's chosen weekday so the
        # first step from a possibly off-weekday ``after`` (the
        # very first occurrence, where the anchor lined up) still
        # lands correctly.
        target_weekday = rule.weekday
        if target_weekday is None:
            target_weekday = after.weekday()
        days_ahead = (target_weekday - after.weekday()) % 7
        if days_ahead == 0:
            days_ahead = 7
        candidate = after + timedelta(days=days_ahead + (interval - 1) * 7)
    else:
        step = _frequency_step_months(rule.frequency) * interval
        y, m = _add_months(after.year, after.month, step)
        dom = rule.day_of_month or after.day
        candidate = _clamp_day(y, m, dom)

    if _terminated_by_date(rule, candidate):
        return None
    return candidate


def occurrences_until(
    rule: models.RecurringRule,
    today: date_type,
    *,
    limit: int,
    skips: set[date_type],
    remaining_count_slots: int | None = None,
) -> list[date_type]:
    """Materializable dates from the cursor up to and including
    ``today``.

    Skipped dates are not returned (but still cost a step). Stops at
    the first of: ``today`` exceeded, end_date passed, max_occurrences
    reached (via ``remaining_count_slots``), per-call ``limit`` hit.
    """
    out: list[date_type] = []
    if rule.next_occurrence_date is None or not rule.active:
        return out

    cursor = rule.next_occurrence_date
    slots = remaining_count_slots
    safety = 0
    while cursor is not None and cursor <= today:
        # Defensive bound: a malformed rule (interval=0) would loop
        # forever; we cap at limit * 4 walks to fail loud rather
        # than silent.
        safety += 1
        if safety > limit * 4 + 100:
            logger.error(
                "recurring.runaway_walk rule_id=%s cursor=%s",
                rule.id, cursor,
            )
            break
        if cursor in skips:
            cursor = next_occurrence(rule, cursor)
            continue
        out.append(cursor)
        if len(out) >= limit:
            break
        if slots is not None:
            slots -= 1
            if slots <= 0:
                break
        cursor = next_occurrence(rule, cursor)
    return out


# ---------- materialization engine ----------

def _due_rules(db: Session, user_id: int, today: date_type) -> list[models.RecurringRule]:
    """Pull all rules whose cursor falls on/before today.

    Eager-loads tags + skips so the loop below does no extra queries
    per rule. The ORDER BY makes catch-up fair across rules.
    """
    stmt = (
        select(models.RecurringRule)
        .where(models.RecurringRule.user_id == user_id)
        .where(models.RecurringRule.active.is_(True))
        .where(models.RecurringRule.next_occurrence_date.is_not(None))
        .where(models.RecurringRule.next_occurrence_date <= today)
        .order_by(
            models.RecurringRule.next_occurrence_date,
            models.RecurringRule.id,
        )
        .options(
            selectinload(models.RecurringRule.tags),
            selectinload(models.RecurringRule.skips),
        )
    )
    return list(db.scalars(stmt))


def materialize_due(
    db: Session,
    user: models.User,
    today: date_type | None = None,
    *,
    limit: int = DEFAULT_CATCHUP_LIMIT,
) -> int:
    """Insert transactions for every due occurrence, up to ``limit``.

    Idempotent under concurrency via ``uq_transactions_rule_date``: a
    racing peer's already-inserted row trips the constraint, the
    per-row savepoint rolls back, and the loop continues. The cursor
    is advanced *only* when the insert wins, so the loser's next pass
    still sees the cursor at the right date.
    """
    if today is None:
        today = date_type.today()

    # Local imports so this module stays free of crud cycles at import
    # time. Each caller still resolves to the same module.
    from . import crud

    rules = _due_rules(db, user.id, today)
    if not rules:
        return 0

    tag_cache = crud._build_tag_cache(db, user.id)

    inserted = 0
    for rule in rules:
        if inserted >= limit:
            break
        # Snapshot skip dates once per rule; the relationship list is
        # already loaded.
        skip_dates = {s.skip_date for s in rule.skips}
        remaining_slots = (
            None
            if rule.max_occurrences is None
            else max(0, rule.max_occurrences - rule.occurrences_count)
        )
        per_rule_limit = limit - inserted
        dates = occurrences_until(
            rule,
            today,
            limit=per_rule_limit,
            skips=skip_dates,
            remaining_count_slots=remaining_slots,
        )
        rule_tag_names = [t.name for t in rule.tags]
        for d in dates:
            if inserted >= limit:
                break
            try:
                with db.begin_nested():
                    tx = models.Transaction(
                        user_id=user.id,
                        amount=rule.amount,
                        description=rule.description or "",
                        category_id=rule.category_id,
                        date=d,
                        type=rule.type,
                        source_rule_id=rule.id,
                    )
                    tx.tags = crud._resolve_tags_cached(
                        db, user.id, rule_tag_names, tag_cache
                    )
                    db.add(tx)
                    # flush so the unique constraint surfaces inside the
                    # savepoint; without it the IntegrityError would
                    # surface on the outer commit and abort the whole
                    # batch.
                    db.flush()
            except IntegrityError:
                # Concurrent catch-up already booked this date — skip
                # silently and let the cursor advance as usual.
                logger.debug(
                    "recurring.race_skipped rule_id=%s date=%s",
                    rule.id, d,
                )
                continue
            inserted += 1
            rule.occurrences_count += 1
            # Advance the cursor from the *materialized* date so a
            # subsequent skip on the same rule sees the right next
            # candidate. Terminating end conditions clear the cursor
            # and pause the rule so the next /auth/me skips it.
            nxt = next_occurrence(rule, d)
            rule.next_occurrence_date = nxt
            if nxt is None or _terminated_by_count(rule):
                rule.next_occurrence_date = None
                rule.active = False
                break

    if inserted:
        db.commit()
    else:
        # No rows changed but the savepoints / loads may have left
        # SQLAlchemy with an open transaction. Roll back so the caller
        # sees a clean session.
        db.rollback()
    return inserted


def catch_up_safely(
    db: Session,
    user: models.User,
    today: date_type | None = None,
    *,
    limit: int = DEFAULT_CATCHUP_LIMIT,
) -> int:
    """Wrapper called from request handlers.

    Swallows any exception (logged as ``recurring.catch_up_failed``)
    and returns 0 so a broken rule can never block ``/api/auth/me``
    or ``/api/transactions``. The wrapper is the only entry point
    intended for the request path.
    """
    try:
        return materialize_due(db, user, today, limit=limit)
    except Exception:
        logger.exception(
            "recurring.catch_up_failed user=%d", user.id
        )
        try:
            db.rollback()
        except Exception:
            pass
        return 0


__all__ = [
    "MAX_BACKDATE_MONTHS",
    "DEFAULT_CATCHUP_LIMIT",
    "_clamp_day",
    "next_occurrence",
    "first_occurrence_on_or_after",
    "occurrences_until",
    "materialize_due",
    "catch_up_safely",
]
