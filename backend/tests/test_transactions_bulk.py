"""Tests for POST /api/transactions/bulk — the multi-select bulk actions
(set_category, add_tags, remove_tags, delete).

Invariants under test:
- Every action is strictly user-scoped: ids belonging to another user never
  match and are silently ignored (no leak, no error, no mutation).
- matched counts owned rows; updated counts rows that actually changed.
- Tag semantics: add = union (case-insensitive, existing kept), remove =
  drop by case-insensitive name, both idempotent.
- A foreign category on set_category is a 400 (unknown_category).
- Shape validation: empty / oversized id lists and empty tag lists are 422.
"""

from __future__ import annotations

from .conftest import new_category, other_client


def _post_tx(client, cat_id, *, tags=None, desc="t", date="2026-05-20", type="out"):
    r = client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": desc,
            "category_id": cat_id,
            "date": date,
            "type": type,
            "tags": tags or [],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _list(client):
    return client.get("/api/transactions?year=2026&month=5").json()


def _by_id(client, tx_id):
    return next(t for t in _list(client) if t["id"] == tx_id)


# ── set_category ──────────────────────────────────────────────────────────────


def test_bulk_set_category_reassigns_owned_rows(client):
    src = client.get("/api/categories").json()[0]["id"]
    dst = new_category(client, "Target")
    ids = [_post_tx(client, src, desc=f"t{i}") for i in range(3)]

    r = client.post(
        "/api/transactions/bulk",
        json={"action": "set_category", "ids": ids, "category_id": dst},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"matched": 3, "updated": 3}
    assert all(_by_id(client, i)["category_id"] == dst for i in ids)


def test_bulk_set_category_counts_only_actual_changes(client):
    src = client.get("/api/categories").json()[0]["id"]
    dst = new_category(client, "Target")
    already = _post_tx(client, dst, desc="already")
    moving = _post_tx(client, src, desc="moving")

    r = client.post(
        "/api/transactions/bulk",
        json={"action": "set_category", "ids": [already, moving], "category_id": dst},
    )
    # Both owned, but only one row actually changed category.
    assert r.json() == {"matched": 2, "updated": 1}


def test_bulk_set_category_rejects_foreign_category(client, app, db_session):
    src = client.get("/api/categories").json()[0]["id"]
    tx = _post_tx(client, src)
    foreign_cat = new_category(other_client(app, db_session), "Foreign")

    r = client.post(
        "/api/transactions/bulk",
        json={"action": "set_category", "ids": [tx], "category_id": foreign_cat},
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "unknown_category"
    # No mutation happened.
    assert _by_id(client, tx)["category_id"] == src


# ── add_tags ──────────────────────────────────────────────────────────────────


def test_bulk_add_tags_is_union_and_case_insensitive(client):
    cat = client.get("/api/categories").json()[0]["id"]
    a = _post_tx(client, cat, tags=["keep"], desc="a")
    b = _post_tx(client, cat, tags=["Food"], desc="b")

    r = client.post(
        "/api/transactions/bulk",
        json={"action": "add_tags", "ids": [a, b], "tags": ["food", "Travel"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == 2
    # a gains both; b only gains Travel (food already present, case-folded).
    assert set(_by_id(client, a)["tags"]) == {"keep", "Food", "Travel"}
    assert set(_by_id(client, b)["tags"]) == {"Food", "Travel"}


def test_bulk_add_tags_idempotent(client):
    cat = client.get("/api/categories").json()[0]["id"]
    tx = _post_tx(client, cat, tags=["x"])
    body = {"action": "add_tags", "ids": [tx], "tags": ["x"]}
    assert client.post("/api/transactions/bulk", json=body).json()["updated"] == 0


# ── remove_tags ───────────────────────────────────────────────────────────────


def test_bulk_remove_tags_drops_matching_names(client):
    cat = client.get("/api/categories").json()[0]["id"]
    a = _post_tx(client, cat, tags=["Food", "keep"], desc="a")
    b = _post_tx(client, cat, tags=["other"], desc="b")

    r = client.post(
        "/api/transactions/bulk",
        json={"action": "remove_tags", "ids": [a, b], "tags": ["food"]},
    )
    assert r.status_code == 200, r.text
    # Only a actually changed (case-insensitive match on "Food").
    assert r.json() == {"matched": 2, "updated": 1}
    assert _by_id(client, a)["tags"] == ["keep"]
    assert _by_id(client, b)["tags"] == ["other"]


def test_bulk_remove_tags_idempotent(client):
    cat = client.get("/api/categories").json()[0]["id"]
    tx = _post_tx(client, cat, tags=["gone"])
    body = {"action": "remove_tags", "ids": [tx], "tags": ["gone"]}
    assert client.post("/api/transactions/bulk", json=body).json()["updated"] == 1
    # Second pass: nothing left to remove.
    assert client.post("/api/transactions/bulk", json=body).json()["updated"] == 0


# ── delete ────────────────────────────────────────────────────────────────────


def test_bulk_delete_removes_owned_rows(client):
    cat = client.get("/api/categories").json()[0]["id"]
    ids = [_post_tx(client, cat, desc=f"d{i}") for i in range(3)]

    r = client.post("/api/transactions/bulk", json={"action": "delete", "ids": ids})
    assert r.status_code == 200, r.text
    assert r.json() == {"matched": 3, "updated": 3}
    remaining = {t["id"] for t in _list(client)}
    assert remaining.isdisjoint(ids)


# ── ownership isolation ───────────────────────────────────────────────────────


def test_bulk_cannot_touch_another_users_transactions(client, app, db_session):
    other = other_client(app, db_session)
    other_cat = other.get("/api/categories").json()[0]["id"]
    victim = _post_tx(other, other_cat, desc="victim")

    for body in (
        {"action": "delete", "ids": [victim]},
        {"action": "add_tags", "ids": [victim], "tags": ["evil"]},
    ):
        r = client.post("/api/transactions/bulk", json=body)
        assert r.status_code == 200, r.text
        assert r.json() == {"matched": 0, "updated": 0}

    # The victim row is untouched and tag-free for its real owner.
    assert _by_id(other, victim)["tags"] == []


# ── shape validation ──────────────────────────────────────────────────────────


def test_bulk_empty_ids_is_422(client):
    r = client.post("/api/transactions/bulk", json={"action": "delete", "ids": []})
    assert r.status_code == 422


def test_bulk_too_many_ids_is_422(client):
    r = client.post(
        "/api/transactions/bulk",
        json={"action": "delete", "ids": list(range(1, 502))},
    )
    assert r.status_code == 422


def test_bulk_empty_tag_list_is_422(client):
    cat = client.get("/api/categories").json()[0]["id"]
    tx = _post_tx(client, cat)
    r = client.post(
        "/api/transactions/bulk",
        json={"action": "add_tags", "ids": [tx], "tags": []},
    )
    assert r.status_code == 422


def test_bulk_unknown_action_is_422(client):
    r = client.post("/api/transactions/bulk", json={"action": "nope", "ids": [1]})
    assert r.status_code == 422
