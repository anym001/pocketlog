"""Tests for the usage counts behind the booking modal's tag suggestions.

``GET /api/tags`` returns every tag the user owns, but the ``count`` only
covers the recent window (``crud.TAG_COUNT_WINDOW_DAYS``). The frontend
ranks its suggestion chips by that count, so the window decides which tags
a user is offered when booking. These tests pin the window and the
"names always, counts only when recent" split it rests on.

``count_in``/``count_out`` split the same window by transaction type so the
chooser can rank against the form's current type; ``count`` stays the total.
"""

from __future__ import annotations

from datetime import date, timedelta

from app import crud


def _post_tx(client, cat_id, tags, when, desc="t", tx_type="out"):
    return client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": desc,
            "category_id": cat_id,
            "date": when.isoformat(),
            "type": tx_type,
            "tags": tags,
        },
    )


def _counts(client):
    return {t["name"]: t["count"] for t in client.get("/api/tags").json()}


def test_count_window_is_90_days():
    """Pinned deliberately: widening or narrowing the window changes which
    tags the booking modal suggests, so it should be a conscious edit."""
    assert crud.TAG_COUNT_WINDOW_DAYS == 90


def test_tag_outside_window_is_listed_with_count_zero(client):
    """A stale tag must not vanish from /api/tags — the tag picker still
    offers it — but it drops out of the suggestion ranking."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    stale = date.today() - timedelta(days=crud.TAG_COUNT_WINDOW_DAYS + 1)
    assert _post_tx(client, cat_id, ["stale"], stale).status_code == 201

    assert _counts(client) == {"stale": 0}


def test_cutoff_day_still_counts(client):
    """The window is inclusive at its edge (``date >= cutoff``)."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    edge = date.today() - timedelta(days=crud.TAG_COUNT_WINDOW_DAYS)
    assert _post_tx(client, cat_id, ["edge"], edge).status_code == 201

    assert _counts(client)["edge"] == 1


def test_counts_rank_recent_use_above_stale_use(client):
    """The ranking the frontend relies on: two transactions inside the
    window beat three outside it."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    recent = date.today() - timedelta(days=5)
    stale = date.today() - timedelta(days=crud.TAG_COUNT_WINDOW_DAYS + 30)
    for i in range(2):
        _post_tx(client, cat_id, ["fresh"], recent, desc=f"r{i}")
    for i in range(3):
        _post_tx(client, cat_id, ["old"], stale, desc=f"s{i}")

    counts = _counts(client)
    assert counts["fresh"] == 2
    assert counts["old"] == 0


def test_standalone_tag_has_count_zero(client):
    """A tag created without any transaction is listed, count 0."""
    assert client.post("/api/tags", json={"name": "unused"}).status_code == 201

    assert _counts(client) == {"unused": 0}


def test_counts_split_by_transaction_type(client):
    """The split the type-aware ranking rests on: a tag used on both an
    expense and an income reports each side separately, and ``count``
    stays their sum."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    recent = date.today() - timedelta(days=5)
    for i in range(3):
        _post_tx(client, cat_id, ["both"], recent, desc=f"o{i}", tx_type="out")
    _post_tx(client, cat_id, ["both"], recent, desc="i0", tx_type="in")

    tag = next(t for t in client.get("/api/tags").json() if t["name"] == "both")
    assert tag["count_out"] == 3
    assert tag["count_in"] == 1
    assert tag["count"] == 4


def test_type_counts_respect_the_window(client):
    """A stale booking contributes to neither side, exactly like ``count``."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    stale = date.today() - timedelta(days=crud.TAG_COUNT_WINDOW_DAYS + 1)
    _post_tx(client, cat_id, ["old"], stale, tx_type="in")

    tag = next(t for t in client.get("/api/tags").json() if t["name"] == "old")
    assert (tag["count"], tag["count_in"], tag["count_out"]) == (0, 0, 0)


def test_standalone_tag_has_zero_on_both_sides(client):
    """A tag with no transactions reports zeros rather than omitting the
    fields — the frontend reads them unconditionally."""
    assert client.post("/api/tags", json={"name": "unused2"}).status_code == 201

    tag = next(t for t in client.get("/api/tags").json() if t["name"] == "unused2")
    assert (tag["count"], tag["count_in"], tag["count_out"]) == (0, 0, 0)


def test_total_count_ignores_the_window(client):
    """``count_total`` is what the tag list shows: every booking ever, so a 0
    there means "never used" — a stale tag still counts."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    stale = date.today() - timedelta(days=crud.TAG_COUNT_WINDOW_DAYS + 30)
    _post_tx(client, cat_id, ["kept"], stale, desc="old")
    _post_tx(client, cat_id, ["kept"], date.today(), desc="new", tx_type="in")
    assert client.post("/api/tags", json={"name": "never"}).status_code == 201

    tags = {t["name"]: t for t in client.get("/api/tags").json()}
    assert (tags["kept"]["count"], tags["kept"]["count_total"]) == (1, 2)
    assert tags["never"]["count_total"] == 0
