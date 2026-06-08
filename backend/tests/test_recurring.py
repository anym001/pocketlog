"""Recurring transactions — API + ownership + catch-up coverage.

Mirrors the structure of ``test_goals.py``. Materialization tests
construct rules with a backdated ``start_date`` so the create call
triggers the catch-up in the same transaction; ``materialized_count``
in the response is the contract we verify.

Date freezing: most tests just pass a ``start_date`` close to today
and let the real ``date.today()`` drive materialization. Tests that
care about the exact number of materialized rows compute the expected
count from the same anchor.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def _new_category(client, name: str | None = None) -> int:
    name = name or f"Cat-{uuid.uuid4().hex[:8]}"
    r = client.post(
        "/api/categories",
        json={"name": name, "icon": "house", "color": "#123456"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _other_client(app, db_session):
    """Return a TestClient logged in as a freshly created second user."""
    from app import crud

    other = crud.create_user(
        db_session,
        username=f"other-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    c = TestClient(app)
    res = c.post(
        "/api/auth/login",
        json={"username": other.username, "password": TEST_PASSWORD},
    )
    c.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]
    return c


def _rule_payload(category_id: int, **over) -> dict:
    body = {
        "name": f"Rule-{uuid.uuid4().hex[:8]}",
        "amount": "12.50",
        "type": "out",
        "category_id": category_id,
        "desc": "",
        "tags": [],
        "frequency": "monthly",
        "interval": 1,
        "day_of_month": 1,
        "start_date": (date.today() + timedelta(days=30)).isoformat(),
        "active": True,
    }
    body.update(over)
    return body


# ---- CRUD roundtrip ----

def test_recurring_crud_roundtrip(client):
    cat = _new_category(client)
    create = client.post("/api/recurring", json=_rule_payload(cat))
    assert create.status_code == 201, create.text
    body = create.json()
    assert "rule" in body and "materialized_count" in body
    rule_id = body["rule"]["id"]
    # No backdate → nothing materialized.
    assert body["materialized_count"] == 0

    listed = client.get("/api/recurring").json()
    assert any(r["id"] == rule_id for r in listed)

    update = client.put(
        f"/api/recurring/{rule_id}",
        json=_rule_payload(cat, name="Renamed", day_of_month=15,
                           start_date=(date.today() + timedelta(days=60)).isoformat()),
    )
    assert update.status_code == 200, update.text
    assert update.json()["name"] == "Renamed"

    assert client.delete(f"/api/recurring/{rule_id}").status_code == 204
    assert all(r["id"] != rule_id for r in client.get("/api/recurring").json())


# ---- materialization on backdated create ----

def test_create_rule_with_backdated_start_materializes(client):
    cat = _new_category(client)
    # 90 days back, monthly on the 1st → 3-4 occurrences depending on
    # today's day-of-month. We compute the expected count locally so
    # the test is date-independent.
    today = date.today()
    start = today - timedelta(days=90)
    # Walk: first occurrence on/after start_date with day_of_month=1.
    if start.day == 1:
        first = start
    else:
        # next month, day 1
        y, m = (start.year, start.month + 1) if start.month < 12 else (start.year + 1, 1)
        first = date(y, m, 1)
    expected = 0
    cur = first
    while cur <= today:
        expected += 1
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)

    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=1, start_date=start.isoformat()),
    )
    assert create.status_code == 201, create.text
    assert create.json()["materialized_count"] == expected

    txs = client.get("/api/transactions").json()
    rule_id = create.json()["rule"]["id"]
    booked = [t for t in txs if t.get("source_rule_id") == rule_id]
    assert len(booked) == expected
    # All booked rows on the 1st.
    assert all(date.fromisoformat(t["date"]).day == 1 for t in booked)


# ---- validation ----

def test_backdate_too_far_returns_422(client):
    cat = _new_category(client)
    # 40 months back > MAX_BACKDATE_MONTHS=36.
    far_back = date.today() - timedelta(days=40 * 31)
    r = client.post(
        "/api/recurring",
        json=_rule_payload(cat, start_date=far_back.isoformat()),
    )
    assert r.status_code == 422


def test_weekly_requires_weekday_422(client):
    cat = _new_category(client)
    body = _rule_payload(cat, frequency="weekly", day_of_month=None)
    # No weekday key.
    r = client.post("/api/recurring", json=body)
    assert r.status_code == 422


def test_monthly_requires_day_of_month_422(client):
    cat = _new_category(client)
    body = _rule_payload(cat, frequency="monthly")
    body.pop("day_of_month")
    r = client.post("/api/recurring", json=body)
    assert r.status_code == 422


def test_end_date_before_start_date_422(client):
    cat = _new_category(client)
    r = client.post(
        "/api/recurring",
        json=_rule_payload(
            cat,
            start_date=(date.today() + timedelta(days=30)).isoformat(),
            end_date=(date.today()).isoformat(),
        ),
    )
    assert r.status_code == 422


def test_unique_rule_name_per_user_409(client):
    cat = _new_category(client)
    name = f"Unique-{uuid.uuid4().hex[:8]}"
    first = client.post("/api/recurring", json=_rule_payload(cat, name=name))
    assert first.status_code == 201
    dup = client.post("/api/recurring", json=_rule_payload(cat, name=name))
    assert dup.status_code == 409


# ---- ownership / isolation ----

def test_recurring_rules_are_user_scoped(app, client, db_session):
    cat = _new_category(client)
    mine = client.post("/api/recurring", json=_rule_payload(cat))
    rid = mine.json()["rule"]["id"]
    other = _other_client(app, db_session)
    assert other.get("/api/recurring").json() == []
    assert other.delete(f"/api/recurring/{rid}").status_code == 404
    assert (
        other.put(
            f"/api/recurring/{rid}",
            json=_rule_payload(_new_category(other)),
        ).status_code
        == 404
    )


def test_recurring_post_requires_csrf(app, regular_user):
    cat_client = TestClient(app)
    res = cat_client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    csrf = res.json()["user"]["csrf_token"]
    cat_client.headers["X-CSRF-Token"] = csrf
    cat_id = _new_category(cat_client)

    # Strip the CSRF header for the POST under test.
    bare = TestClient(app)
    bare.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert bare.post("/api/recurring", json=_rule_payload(cat_id)).status_code == 403


# ---- delete keeps history ----

def test_delete_rule_keeps_materialized_transactions(client):
    cat = _new_category(client)
    start = date.today() - timedelta(days=40)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=1, start_date=start.isoformat()),
    )
    rid = create.json()["rule"]["id"]
    booked_before = [
        t for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert booked_before, "expected backdated materialization"

    assert client.delete(f"/api/recurring/{rid}").status_code == 204

    # Rows still there, but source_rule_id is null (ON DELETE SET NULL).
    remaining = [
        t for t in client.get("/api/transactions").json()
        if t["date"] in {b["date"] for b in booked_before}
    ]
    assert len(remaining) == len(booked_before)
    assert all(t["source_rule_id"] is None for t in remaining)


# ---- skip-next ----

def test_skip_next_advances_cursor_and_records_skip(client):
    cat = _new_category(client)
    # Future-only rule so no materialization happens; we can introspect
    # next_occurrence_date directly.
    start = date.today() + timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=start.day, start_date=start.isoformat()),
    )
    rid = create.json()["rule"]["id"]
    initial = client.get("/api/recurring").json()
    next_before = [r for r in initial if r["id"] == rid][0]["next_occurrence_date"]

    skip = client.post(f"/api/recurring/{rid}/skip-next")
    assert skip.status_code == 200, skip.text
    body = skip.json()
    assert body["skipped_date"] == next_before
    assert body["next_occurrence_date"] != next_before

    # Skip is recorded in the rule body.
    listed = client.get("/api/recurring").json()
    rule = [r for r in listed if r["id"] == rid][0]
    assert next_before in rule["skips"]


def test_skip_next_prevents_materialization_on_that_date(client):
    """Backdated rule where the next due date gets skipped → no row
    inserted for it on the next catch-up."""
    cat = _new_category(client)
    # Daily rule, 5 days back. Materializes 6 rows immediately (incl
    # today). After skipping the *next* (= tomorrow), the next /auth/me
    # call won't insert tomorrow.
    start = date.today() - timedelta(days=5)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(
            cat, frequency="daily", day_of_month=None,
            start_date=start.isoformat(),
        ),
    )
    rid = create.json()["rule"]["id"]
    # Skip the next (tomorrow).
    sk = client.post(f"/api/recurring/{rid}/skip-next").json()
    skipped = date.fromisoformat(sk["skipped_date"])
    # After advancing — no transaction exists on the skipped date yet.
    booked_dates = {
        t["date"]
        for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    }
    assert skipped.isoformat() not in booked_dates


def test_skip_next_on_unknown_rule_returns_404(client):
    assert client.post("/api/recurring/99999999/skip-next").status_code == 404


def test_remove_skip_endpoint(client):
    cat = _new_category(client)
    start = date.today() + timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=start.day, start_date=start.isoformat()),
    )
    rid = create.json()["rule"]["id"]
    sk = client.post(f"/api/recurring/{rid}/skip-next").json()
    skipped = sk["skipped_date"]
    # Listed → skip present.
    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    assert skipped in rule["skips"]
    # Remove → 204, skip disappears.
    assert client.delete(f"/api/recurring/{rid}/skip/{skipped}").status_code == 204
    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    assert skipped not in rule["skips"]


# ---- end conditions ----

def test_max_occurrences_caps_materialization(client):
    cat = _new_category(client)
    start = date.today() - timedelta(days=60)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(
            cat, day_of_month=1, start_date=start.isoformat(),
            max_occurrences=2,
        ),
    )
    assert create.json()["materialized_count"] == 2
    rid = create.json()["rule"]["id"]
    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    # Hit max → cursor cleared, paused.
    assert rule["next_occurrence_date"] is None
    assert rule["active"] is False


def test_end_date_caps_materialization(client):
    cat = _new_category(client)
    start = date.today() - timedelta(days=90)
    end = date.today() - timedelta(days=30)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(
            cat, day_of_month=1, start_date=start.isoformat(),
            end_date=end.isoformat(),
        ),
    )
    rid = create.json()["rule"]["id"]
    booked = [
        t for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert booked, "expected at least one materialized row"
    assert all(date.fromisoformat(t["date"]) <= end for t in booked)


# ---- /auth/me banner count ----

def test_auth_me_returns_materialized_count(client):
    cat = _new_category(client)
    start = date.today() - timedelta(days=40)
    client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=1, start_date=start.isoformat()),
    )
    # Backdate already materialized via the create call. A second
    # /auth/me must report zero because the cursor has advanced past
    # today.
    me = client.get("/api/auth/me").json()
    assert me.get("recurring_materialized_count", 0) == 0


# ---- category-delete guard ----

def test_category_in_use_by_recurring_blocks_category_delete(client):
    cat = _new_category(client)
    create = client.post("/api/recurring", json=_rule_payload(cat))
    assert create.status_code == 201
    blocked = client.delete(f"/api/categories/{cat}")
    assert blocked.status_code == 409
    assert "recurring" in blocked.json()["detail"]


# ---- tag handling ----

def test_rule_with_tags_materializes_with_tags(client):
    cat = _new_category(client)
    start = date.today() - timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(
            cat, frequency="daily", day_of_month=None,
            start_date=start.isoformat(), tags=["wohnen", "fix"],
        ),
    )
    rid = create.json()["rule"]["id"]
    booked = [
        t for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert booked
    for t in booked:
        assert set(t["tags"]) == {"wohnen", "fix"}


# ---- update does not change history ----

def test_update_rule_does_not_change_existing_transactions(client):
    cat = _new_category(client)
    start = date.today() - timedelta(days=40)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=1, start_date=start.isoformat(),
                           amount="100.00"),
    )
    rid = create.json()["rule"]["id"]
    before = [
        float(t["amount"])
        for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert before

    # Update amount; PUT must NOT touch existing rows.
    upd = client.put(
        f"/api/recurring/{rid}",
        json=_rule_payload(cat, day_of_month=1, start_date=start.isoformat(),
                           amount="999.00"),
    )
    assert upd.status_code == 200, upd.text
    after = [
        float(t["amount"])
        for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert sorted(after) == sorted(before)


# ---- bulk-reset behaviour ----

def test_reset_transactions_keeps_recurring_rules(client):
    cat = _new_category(client)
    create = client.post("/api/recurring", json=_rule_payload(cat))
    rid = create.json()["rule"]["id"]
    rule_before = [
        r for r in client.get("/api/recurring").json() if r["id"] == rid
    ][0]

    assert client.delete("/api/admin/transactions").status_code == 204

    listed = client.get("/api/recurring").json()
    rule_after = [r for r in listed if r["id"] == rid][0]
    assert rule_after["next_occurrence_date"] == rule_before["next_occurrence_date"]
    assert rule_after["occurrences_count"] == rule_before["occurrences_count"]


def test_reset_all_data_wipes_recurring_rules(client):
    cat = _new_category(client)
    client.post("/api/recurring", json=_rule_payload(cat))
    assert client.get("/api/recurring").json()

    # Must not fail with IntegrityError on the category delete step.
    assert client.delete("/api/admin/all-data").status_code == 204

    assert client.get("/api/recurring").json() == []
    assert client.get("/api/categories").json() == []


# ---- auth / cascade ----

def test_recurring_requires_authentication(app):
    anon = TestClient(app)
    assert anon.get("/api/recurring").status_code == 401
    assert anon.post("/api/recurring", json={}).status_code == 401


def test_user_delete_cascades_recurring(db_session):
    from app import crud, models
    user = crud.create_user(
        db_session,
        username=f"casc-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    cat = crud.list_categories(db_session, user.id)[0]
    from app.schemas import RecurringRuleCreate
    crud.create_recurring_rule(
        db_session, user.id,
        RecurringRuleCreate(
            name="Cascade",
            amount="10.00",
            type="out",
            category_id=cat.id,
            desc="",
            frequency="monthly",
            interval=1,
            day_of_month=1,
            start_date=date.today() + timedelta(days=10),
        ),
        today=date.today(),
    )
    uid = user.id
    assert crud.list_recurring_rules(db_session, uid)
    crud.delete_user(db_session, user)
    db_session.expire_all()
    assert (
        db_session.query(models.RecurringRule)
        .filter(models.RecurringRule.user_id == uid)
        .count()
        == 0
    )


# ---- concurrency idempotency (sequential proxy) ----

def test_update_rule_moves_cursor_to_new_future_start(client):
    """A rule whose start_date is bumped from today+10 to today+30 must
    advance its cursor to the new future anchor, not keep the old one."""
    cat = _new_category(client)
    near = date.today() + timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=near.day, start_date=near.isoformat()),
    )
    rid = create.json()["rule"]["id"]
    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    assert rule["next_occurrence_date"] == near.isoformat()

    far = date.today() + timedelta(days=30)
    upd = client.put(
        f"/api/recurring/{rid}",
        json=_rule_payload(cat, day_of_month=far.day, start_date=far.isoformat()),
    )
    assert upd.status_code == 200, upd.text
    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    assert rule["next_occurrence_date"] == far.isoformat()


def test_update_rule_with_past_start_anchors_on_today_without_rematerialization(client):
    """Edit semantics: bumping start_date into the past must NOT
    trigger backfill of the gap. The cursor anchors on today (or
    later), existing transactions are untouched, no new ones
    materialize for the past gap."""
    cat = _new_category(client)
    future_start = date.today() + timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(
            cat, day_of_month=future_start.day,
            start_date=future_start.isoformat(),
        ),
    )
    rid = create.json()["rule"]["id"]
    txs_before = [
        t for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert txs_before == []

    past = date.today() - timedelta(days=60)
    upd = client.put(
        f"/api/recurring/{rid}",
        json=_rule_payload(
            cat, day_of_month=past.day, start_date=past.isoformat()
        ),
    )
    assert upd.status_code == 200, upd.text
    # No backfill: still zero booked rows.
    txs_after = [
        t for t in client.get("/api/transactions").json()
        if t.get("source_rule_id") == rid
    ]
    assert txs_after == []
    # Cursor sits on/after today, not on the new past start.
    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    assert date.fromisoformat(rule["next_occurrence_date"]) >= date.today()


def test_skip_next_twice_skips_two_distinct_occurrences(client):
    """Calling /skip-next twice in a row skips TWO distinct dates
    (the current cursor first, then the advanced one). Mirrors the
    real UX of a user clicking the button twice — both clicks must
    have an effect, and neither must double-record the same skip."""
    cat = _new_category(client)
    start = date.today() + timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=start.day, start_date=start.isoformat()),
    )
    rid = create.json()["rule"]["id"]

    first = client.post(f"/api/recurring/{rid}/skip-next").json()
    second = client.post(f"/api/recurring/{rid}/skip-next").json()
    assert first["skipped_date"] != second["skipped_date"]
    assert first["next_occurrence_date"] == second["skipped_date"]

    rule = [r for r in client.get("/api/recurring").json() if r["id"] == rid][0]
    assert first["skipped_date"] in rule["skips"]
    assert second["skipped_date"] in rule["skips"]


def test_other_user_cannot_skip_or_remove_skip(app, client, db_session):
    """A second user must get 404 on both /skip-next and
    /skip/{iso} against another user's rule, even when they know the
    rule_id."""
    cat = _new_category(client)
    start = date.today() + timedelta(days=10)
    create = client.post(
        "/api/recurring",
        json=_rule_payload(cat, day_of_month=start.day, start_date=start.isoformat()),
    )
    rid = create.json()["rule"]["id"]
    sk = client.post(f"/api/recurring/{rid}/skip-next").json()
    skipped_iso = sk["skipped_date"]

    other = _other_client(app, db_session)
    assert other.post(f"/api/recurring/{rid}/skip-next").status_code == 404
    assert other.delete(f"/api/recurring/{rid}/skip/{skipped_iso}").status_code == 404


def test_double_catchup_is_idempotent(client):
    """Two consecutive /api/transactions calls must NOT double-book.

    Real concurrent threads on a SQLite TestClient are flaky; the
    uniqueness constraint is what guarantees correctness, and a
    second call after the first must already see an empty due set
    (the cursor advanced). This catches a regression where a missing
    commit between catch-up runs would re-materialize the same date.
    """
    cat = _new_category(client)
    start = date.today() - timedelta(days=10)
    client.post(
        "/api/recurring",
        json=_rule_payload(
            cat, frequency="daily", day_of_month=None,
            start_date=start.isoformat(),
        ),
    )
    first = client.get("/api/transactions").json()
    second = client.get("/api/transactions").json()
    assert len(first) == len(second)
