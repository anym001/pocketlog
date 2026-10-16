"""Tests for the usage counts behind the booking modal's category chooser.

``GET /api/categories`` gained the same shape ``GET /api/tags`` already had:
a ``count`` over a recent window (``crud.CATEGORY_COUNT_WINDOW_DAYS``) plus
``count_in``/``count_out`` splitting it by transaction type.

The chooser shows only the top two rows of chips and reaches the rest through
search, so this ranking is what decides whether the everyday booking is a
single tap. That makes the window and the split worth pinning.
"""

from __future__ import annotations

from datetime import date, timedelta

from app import crud

from .conftest import other_client


def _post_tx(client, cat_id, when, desc="t", tx_type="out"):
    return client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": desc,
            "category_id": cat_id,
            "date": when.isoformat(),
            "type": tx_type,
        },
    )


def _by_name(client):
    return {c["name"]: c for c in client.get("/api/categories").json()}


def test_count_window_matches_the_tag_window():
    """Both choosers rank over the same period — a user should not have to
    hold two different notions of "recent" in their head."""
    assert crud.CATEGORY_COUNT_WINDOW_DAYS == crud.TAG_COUNT_WINDOW_DAYS


def test_unused_category_is_listed_with_zero_counts(client):
    """A category with no bookings must still come back — it is selectable,
    it just ranks last."""
    cats = client.get("/api/categories").json()
    assert cats, "the setup seeds default categories"
    for c in cats:
        assert (c["count"], c["count_in"], c["count_out"]) == (0, 0, 0)


def test_counts_split_by_transaction_type(client):
    """The split the type-aware ranking rests on: booking an expense must
    not be offered the category that only ever carries income."""
    cats = client.get("/api/categories").json()
    spend, earn = cats[0]["id"], cats[1]["id"]
    recent = date.today() - timedelta(days=5)
    for i in range(4):
        _post_tx(client, spend, recent, desc=f"o{i}", tx_type="out")
    for i in range(2):
        _post_tx(client, earn, recent, desc=f"i{i}", tx_type="in")

    fresh = {c["id"]: c for c in client.get("/api/categories").json()}
    counts = lambda c: (c["count"], c["count_out"], c["count_in"])  # noqa: E731
    assert counts(fresh[spend]) == (4, 4, 0)
    assert counts(fresh[earn]) == (2, 0, 2)


def test_stale_bookings_drop_out_of_the_ranking(client):
    """Outside the window the category still lists, with count 0 — the same
    "names always, counts only when recent" split the tags have."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    stale = date.today() - timedelta(days=crud.CATEGORY_COUNT_WINDOW_DAYS + 1)
    assert _post_tx(client, cat_id, stale).status_code == 201

    counted = {c["id"]: c for c in client.get("/api/categories").json()}[cat_id]
    assert (counted["count"], counted["count_out"]) == (0, 0)


def test_cutoff_day_still_counts(client):
    """The window is inclusive at its edge (``date >= cutoff``), matching tags."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    edge = date.today() - timedelta(days=crud.CATEGORY_COUNT_WINDOW_DAYS)
    assert _post_tx(client, cat_id, edge).status_code == 201

    counted = {c["id"]: c for c in client.get("/api/categories").json()}[cat_id]
    assert counted["count"] == 1


def test_created_category_reports_zero_counts(client):
    """POST returns a plain ORM row with no counts computed; the schema
    defaults must fill them rather than omitting the fields, because the
    frontend reads them unconditionally on the optimistic offline path."""
    made = client.post("/api/categories", json={"name": "Frisch"})
    assert made.status_code == 201
    body = made.json()
    assert (body["count"], body["count_in"], body["count_out"]) == (0, 0, 0)


def test_counts_are_scoped_to_the_owner(client, app, db_session):
    """Another user's bookings must not rank this user's categories — the
    GROUP BY runs over a join, which is exactly where a missing user filter
    would leak in unnoticed."""
    stranger = other_client(app, db_session)
    mine = client.get("/api/categories").json()[0]["id"]
    theirs = stranger.get("/api/categories").json()[0]["id"]
    recent = date.today() - timedelta(days=3)
    for i in range(3):
        assert _post_tx(stranger, theirs, recent, desc=f"x{i}").status_code == 201

    counted = {c["id"]: c for c in client.get("/api/categories").json()}[mine]
    assert counted["count"] == 0


def test_total_count_ignores_the_window(client):
    """``count_total`` is what the category list shows: every booking ever,
    so a 0 there means "never used" — a stale category still counts."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    stale = date.today() - timedelta(days=crud.CATEGORY_COUNT_WINDOW_DAYS + 30)
    recent = date.today() - timedelta(days=2)
    assert _post_tx(client, cat_id, stale, desc="old").status_code == 201
    assert _post_tx(client, cat_id, recent, desc="new", tx_type="in").status_code == 201

    counted = {c["id"]: c for c in client.get("/api/categories").json()}[cat_id]
    assert (counted["count"], counted["count_total"]) == (1, 2)


def test_total_count_zero_when_unused_and_owner_scoped(client, app, db_session):
    """Unused categories report 0 rather than omitting the field (also on the
    POST response), and another user's bookings never count."""
    stranger = other_client(app, db_session)
    theirs = stranger.get("/api/categories").json()[0]["id"]
    assert _post_tx(stranger, theirs, date.today()).status_code == 201

    for c in client.get("/api/categories").json():
        assert c["count_total"] == 0
    made = client.post("/api/categories", json={"name": "Neu"}).json()
    assert made["count_total"] == 0
