"""Tests for client_op_id idempotency on POST /api/transactions.

The offline outbox replays a queued create by re-sending the exact body,
including the client-generated ``client_op_id``. If the first (timed-out)
attempt already reached the server, the replay must return that same row
instead of inserting a duplicate — the ``UNIQUE(user_id, client_op_id)``
guard.

Invariants under test:
- Same op-id, same user → one row; the second POST returns the first id.
- No op-id (or distinct op-ids) → independent rows, as before.
- The guard is user-scoped: the same op-id for two users yields two rows.
- ``client_op_id`` is never exposed on read.
"""

from __future__ import annotations

from .conftest import other_client


def _create(client, op_id=None, *, desc="t", amount="1.00"):
    body = {
        "amount": amount,
        "desc": desc,
        "category_id": client.get("/api/categories").json()[0]["id"],
        "date": "2026-05-20",
        "type": "out",
        "tags": [],
    }
    if op_id is not None:
        body["client_op_id"] = op_id
    return client.post("/api/transactions", json=body)


def _month(client):
    return client.get("/api/transactions?year=2026&month=5").json()


def test_same_op_id_deduplicates(client):
    first = _create(client, "op-abc", desc="first")
    assert first.status_code == 201, first.text

    # Replay: same op-id, even with a different payload, returns the original
    # row and creates nothing new.
    replay = _create(client, "op-abc", desc="second-should-be-ignored")
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == first.json()["id"]

    kept = ("first", "second-should-be-ignored")
    rows = [t for t in _month(client) if t["desc"] in kept]
    assert len(rows) == 1
    assert rows[0]["desc"] == "first"


def test_distinct_op_ids_create_separate_rows(client):
    a = _create(client, "op-1", desc="a")
    b = _create(client, "op-2", desc="b")
    assert a.json()["id"] != b.json()["id"]


def test_missing_op_id_never_deduplicates(client):
    a = _create(client, None, desc="dup")
    b = _create(client, None, desc="dup")
    # No op-id → NULLs are distinct → two independent rows.
    assert a.json()["id"] != b.json()["id"]


def test_op_id_guard_is_user_scoped(client, app, db_session):
    mine = _create(client, "shared-op", desc="mine")
    assert mine.status_code == 201, mine.text

    theirs_client = other_client(app, db_session)
    theirs = _create(theirs_client, "shared-op", desc="theirs")
    # Same op-id, different user → a real second row, not a cross-user dedup.
    assert theirs.status_code == 201, theirs.text
    assert theirs.json()["id"] != mine.json()["id"]


def test_op_id_not_exposed_on_read(client):
    _create(client, "op-hidden", desc="hidden")
    row = next(t for t in _month(client) if t["desc"] == "hidden")
    assert "client_op_id" not in row
