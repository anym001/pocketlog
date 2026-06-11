"""Recurring transactions — materialization engine.

A ``RecurringRule`` carries the *intent*: frequency, interval, anchor
day, end conditions. The cached ``next_occurrence_date`` cursor is
advanced by :func:`materialize_due` on each authenticated read that
hooks the catch-up. The pure date math (``next_occurrence``,
``occurrences_until``, …) lives in ``app.recurring_dates`` so it stays
testable in isolation; this module holds the side-effecting bits
(``materialize_due``, ``catch_up_safely``) on top.

Why no scheduler: PocketLog runs in a single uvicorn process and is
deployed standalone (no celery, no cron). The catch-up runs cheaply
in the request path (indexed scan ``WHERE active AND
next_occurrence_date <= today``) so the "trigger" is the next time
the user opens the app. See ``main.auth_me`` and
``main.get_transactions`` for the call sites.
"""

from __future__ import annotations

import logging
from datetime import date as date_type

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import models
from .recurring_dates import (
    _terminated_by_count,
    next_occurrence,
    occurrences_until,
)

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


def _due_rules(
    db: Session, user_id: int, today: date_type
) -> list[models.RecurringRule]:
    """Pull all rules whose cursor falls on/before today.

    Eager-loads tags + skips so the loop below does no extra queries
    per rule. The ORDER BY makes catch-up fair across rules. The
    LIMIT bounds the read at the same per-request cap that bounds
    inserts — without it a user with thousands of rules could pin
    the catch-up's *read* cost above the per-request write cap, and
    inflate every authed request for their own session (self-DoS,
    but trivially abusable).
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
        .limit(DEFAULT_CATCHUP_LIMIT)
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
                    rule.id,
                    d,
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
    # Else: no row changed → nothing to commit. Don't rollback either:
    # the only state changes inside this function happen inside
    # ``db.begin_nested()`` savepoints, which clean themselves up.
    # A blind rollback here would also discard any pending change the
    # caller staged before us (e.g. ``create_recurring_rule`` flushes
    # the new rule, then asks us to backdate — a rollback on a
    # 0-insert race would lose the rule).
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
        logger.exception("recurring.catch_up_failed user=%d", user.id)
        try:
            db.rollback()
        except Exception:
            pass
        return 0


__all__ = [
    "MAX_BACKDATE_MONTHS",
    "DEFAULT_CATCHUP_LIMIT",
    "materialize_due",
    "catch_up_safely",
]
