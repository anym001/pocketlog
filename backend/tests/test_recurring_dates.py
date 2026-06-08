"""Pure date math for the recurring engine.

Tests in this file do NOT touch the DB — they construct a minimal
``RecurringRule`` directly and call the helpers in ``app.recurring``.
This is the right isolation level for clamp-day / advance / end-condition
behaviour where SQL has nothing to do with the answer.
"""

from __future__ import annotations

from datetime import date

from app import models, recurring


def _rule(**kwargs) -> models.RecurringRule:
    """Construct a transient rule with sensible defaults for these
    tests. Not added to the session — the helpers under test are pure."""
    defaults = dict(
        user_id=1,
        name="t",
        amount=10,
        type="out",
        category_id=1,
        description="",
        frequency="monthly",
        interval=1,
        weekday=None,
        day_of_month=1,
        start_date=date(2026, 1, 1),
        end_date=None,
        max_occurrences=None,
        next_occurrence_date=date(2026, 1, 1),
        occurrences_count=0,
        active=True,
    )
    defaults.update(kwargs)
    return models.RecurringRule(**defaults)


# ---- _clamp_day ----


def test_clamp_day_31_in_february_non_leap():
    assert recurring._clamp_day(2026, 2, 31) == date(2026, 2, 28)


def test_clamp_day_31_in_february_leap():
    assert recurring._clamp_day(2024, 2, 31) == date(2024, 2, 29)


def test_clamp_day_31_in_april():
    assert recurring._clamp_day(2026, 4, 31) == date(2026, 4, 30)


def test_clamp_day_29_in_february_non_leap():
    assert recurring._clamp_day(2026, 2, 29) == date(2026, 2, 28)


def test_clamp_day_15_in_april_passes_through():
    assert recurring._clamp_day(2026, 4, 15) == date(2026, 4, 15)


# ---- next_occurrence: monthly ----


def test_monthly_advance_keeps_anchor_day():
    r = _rule(frequency="monthly", day_of_month=15, interval=1)
    assert recurring.next_occurrence(r, date(2026, 1, 15)) == date(2026, 2, 15)


def test_monthly_advance_clamps_day_31():
    r = _rule(frequency="monthly", day_of_month=31, interval=1)
    # Jan 31 → Feb 28 (non-leap).
    assert recurring.next_occurrence(r, date(2026, 1, 31)) == date(2026, 2, 28)


def test_interval_2_monthly_skips_a_month():
    r = _rule(frequency="monthly", day_of_month=1, interval=2)
    assert recurring.next_occurrence(r, date(2026, 3, 1)) == date(2026, 5, 1)


# ---- next_occurrence: quarterly / yearly ----


def test_quarterly_adds_three_months():
    r = _rule(frequency="quarterly", day_of_month=15, interval=1)
    assert recurring.next_occurrence(r, date(2026, 1, 15)) == date(2026, 4, 15)


def test_yearly_feb_29_clamps_off_leap():
    r = _rule(
        frequency="yearly",
        day_of_month=29,
        interval=1,
        start_date=date(2024, 2, 29),
    )
    # 2024 → 2025 (non-leap) ⇒ Feb 28.
    assert recurring.next_occurrence(r, date(2024, 2, 29)) == date(2025, 2, 28)


# ---- next_occurrence: weekly ----


def test_weekly_advance_respects_weekday():
    # weekday=2 means Wednesday. start: Wed 2026-01-07.
    r = _rule(
        frequency="weekly",
        weekday=2,
        day_of_month=None,
        interval=1,
        start_date=date(2026, 1, 7),
    )
    assert recurring.next_occurrence(r, date(2026, 1, 7)) == date(2026, 1, 14)


def test_weekly_advance_interval_2():
    r = _rule(
        frequency="weekly",
        weekday=0,
        day_of_month=None,
        interval=2,
        start_date=date(2026, 1, 5),
    )
    # start Mon 2026-01-05 → +14 days
    assert recurring.next_occurrence(r, date(2026, 1, 5)) == date(2026, 1, 19)


# ---- next_occurrence: daily ----


def test_daily_interval_n():
    r = _rule(frequency="daily", day_of_month=None, interval=3)
    assert recurring.next_occurrence(r, date(2026, 1, 1)) == date(2026, 1, 4)


# ---- end conditions ----


def test_end_date_terminates_returns_none():
    r = _rule(
        frequency="monthly",
        day_of_month=1,
        interval=1,
        end_date=date(2026, 2, 28),
    )
    # next would be 2026-03-01 — past end_date.
    assert recurring.next_occurrence(r, date(2026, 2, 1)) is None


def test_max_occurrences_terminates_returns_none():
    r = _rule(
        frequency="daily",
        day_of_month=None,
        interval=1,
        max_occurrences=3,
        occurrences_count=3,
    )
    assert recurring.next_occurrence(r, date(2026, 1, 1)) is None


# ---- first_occurrence_on_or_after ----


def test_first_occurrence_in_future_returns_start_date_clamped():
    r = _rule(frequency="monthly", day_of_month=15, start_date=date(2026, 6, 15))
    assert recurring.first_occurrence_on_or_after(r, date(2026, 6, 1)) == date(
        2026, 6, 15
    )


def test_first_occurrence_on_anchor_returns_anchor_for_daily():
    r = _rule(frequency="daily", day_of_month=None)
    assert recurring.first_occurrence_on_or_after(r, date(2026, 6, 7)) == date(
        2026, 6, 7
    )


def test_first_occurrence_advances_when_dom_already_past_in_anchor_month():
    # day_of_month=5 anchored to 2026-06-20 → 2026-07-05.
    r = _rule(frequency="monthly", day_of_month=5)
    assert recurring.first_occurrence_on_or_after(r, date(2026, 6, 20)) == date(
        2026, 7, 5
    )


def test_first_occurrence_returns_none_when_max_already_consumed():
    r = _rule(max_occurrences=2, occurrences_count=2)
    assert recurring.first_occurrence_on_or_after(r, date(2026, 1, 1)) is None


# ---- occurrences_until ----


def test_occurrences_until_respects_today():
    r = _rule(
        frequency="monthly", day_of_month=1, next_occurrence_date=date(2026, 1, 1)
    )
    dates = recurring.occurrences_until(r, date(2026, 3, 15), limit=10, skips=set())
    assert dates == [date(2026, 1, 1), date(2026, 2, 1), date(2026, 3, 1)]


def test_occurrences_until_skips_filtered_date():
    r = _rule(
        frequency="monthly", day_of_month=1, next_occurrence_date=date(2026, 1, 1)
    )
    dates = recurring.occurrences_until(
        r,
        date(2026, 3, 15),
        limit=10,
        skips={date(2026, 2, 1)},
    )
    assert dates == [date(2026, 1, 1), date(2026, 3, 1)]


def test_occurrences_until_caps_at_limit():
    r = _rule(
        frequency="daily", day_of_month=None, next_occurrence_date=date(2026, 1, 1)
    )
    dates = recurring.occurrences_until(r, date(2026, 12, 31), limit=5, skips=set())
    assert len(dates) == 5
    assert dates[0] == date(2026, 1, 1)


def test_occurrences_until_returns_empty_when_paused():
    r = _rule(active=False, next_occurrence_date=date(2026, 1, 1))
    assert recurring.occurrences_until(r, date(2026, 3, 1), limit=10, skips=set()) == []


def test_occurrences_until_returns_empty_when_cursor_none():
    r = _rule(next_occurrence_date=None)
    assert recurring.occurrences_until(r, date(2026, 3, 1), limit=10, skips=set()) == []


# ---- year-rollover (the _add_months idx // 12 path) ----


def test_monthly_advance_crosses_year_boundary():
    r = _rule(frequency="monthly", day_of_month=15, interval=1)
    assert recurring.next_occurrence(r, date(2026, 12, 15)) == date(2027, 1, 15)


def test_quarterly_advance_crosses_year_boundary():
    r = _rule(frequency="quarterly", day_of_month=15, interval=1)
    # Nov 15 + 3 months → Feb 15 of the next year.
    assert recurring.next_occurrence(r, date(2026, 11, 15)) == date(2027, 2, 15)


def test_monthly_interval_12_lands_one_year_later():
    r = _rule(frequency="monthly", day_of_month=10, interval=12)
    assert recurring.next_occurrence(r, date(2026, 6, 10)) == date(2027, 6, 10)


# ---- crud._subtract_months (backdate-cap helper) ----


def test_subtract_months_feb29_clamps_off_leap():
    from app.crud import _subtract_months

    # 2028-02-29 minus 12 months → 2027-02-28 (non-leap)
    assert _subtract_months(date(2028, 2, 29), 12) == date(2027, 2, 28)


def test_subtract_months_preserves_day_when_target_month_has_it():
    from app.crud import _subtract_months

    assert _subtract_months(date(2026, 6, 15), 6) == date(2025, 12, 15)


def test_subtract_months_jan_to_prev_year_dec():
    """Edge case: anchor Jan 15 minus 1 month → Dec 15 of prev year.
    Pins the (total_months // 12, % 12) wraparound on the negative
    side of zero."""
    from app.crud import _subtract_months

    assert _subtract_months(date(2026, 1, 15), 1) == date(2025, 12, 15)
