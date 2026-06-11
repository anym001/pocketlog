"""Pure date math for the recurring engine.

These functions compute occurrence dates from a ``RecurringRule``'s
frequency, interval, anchor day and end conditions. They read rule
attributes but never touch the database — ``app.recurring`` builds the
side-effecting materialization engine on top. Keeping the math here
(import-cycle-free: only ``models`` is imported) lets ``crud.recurring``
use it via plain top-level imports and keeps it testable in isolation
(``tests/test_recurring_dates.py``).
"""

from __future__ import annotations

import calendar
import logging
from datetime import date as date_type

from . import models

logger = logging.getLogger("pocketlog.api")


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
    return rule.max_occurrences is not None and count >= rule.max_occurrences


def _terminated_by_date(rule: models.RecurringRule, candidate: date_type) -> bool:
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


def next_occurrence(rule: models.RecurringRule, after: date_type) -> date_type | None:
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
                rule.id,
                cursor,
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


__all__ = [
    "_clamp_day",
    "first_occurrence_on_or_after",
    "next_occurrence",
    "occurrences_until",
]
