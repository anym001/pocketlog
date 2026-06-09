"""Tests for the M2M tag layout introduced by 0008_transaction_tags.

The previous storage kept tag *strings* in transactions.tags (JSON)
alongside canonical names in the standalone tags table. The two could
drift apart — a transaction stored with ``"amazon"`` would keep showing
that casing even after the standalone tag ``"Amazon"`` had been
declared. These tests guard the post-migration invariants:

- Tags resolve case-insensitively against the user's tag row, so the
  same canonical name appears in /api/tags AND on every transaction.
- Rename / delete walk the junction table once; no JSON rewrite per
  transaction, and the change is visible to all linked rows.
- Tag uniqueness is per-user (Authentik usernames don't share tags).
"""

from __future__ import annotations


def _post_tx(client, cat_id, tags, desc="t"):
    return client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": desc,
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": tags,
        },
    )


def test_canonical_casing_wins_for_existing_standalone_tag(client):
    """The original bug: a standalone tag ``"Amazon"`` exists, then a
    transaction is saved with ``"amazon"``. After the fix, the
    transaction reads back as ``"Amazon"`` — the casing canonicalises
    to the tag row's name."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    # Declare the canonical tag first.
    assert client.post("/api/tags", json={"name": "Amazon"}).status_code == 201

    # Save a transaction with the lowercase variant.
    r = _post_tx(client, cat_id, ["amazon"], desc="bug-repro")
    assert r.status_code == 201, r.text

    # The response — and every subsequent read — uses the canonical
    # casing from the tags table, not the input value.
    assert r.json()["tags"] == ["Amazon"]

    listed = client.get("/api/transactions?year=2026&month=5").json()
    target = next(t for t in listed if t["desc"] == "bug-repro")
    assert target["tags"] == ["Amazon"]


def test_first_tag_set_canonical_for_subsequent_variants(client):
    """No standalone tag exists, but the first transaction creates one
    with the supplied casing. Later transactions with case-different
    spellings reuse that same row instead of creating a parallel one."""
    cat_id = client.get("/api/categories").json()[0]["id"]

    r1 = _post_tx(client, cat_id, ["Bäckerei"], desc="first")
    assert r1.status_code == 201
    r2 = _post_tx(client, cat_id, ["BÄCKEREI"], desc="second")
    assert r2.status_code == 201

    # Only one tag exists in the user's tag list.
    tags = [t["name"] for t in client.get("/api/tags").json()]
    assert tags.count("Bäckerei") == 1
    assert "BÄCKEREI" not in tags

    # Both transactions render the same canonical name.
    listed = client.get("/api/transactions?year=2026&month=5").json()
    by_desc = {t["desc"]: t["tags"] for t in listed}
    assert by_desc["first"] == ["Bäckerei"]
    assert by_desc["second"] == ["Bäckerei"]


def test_tag_rename_reflects_on_all_transactions_without_walk(client):
    """Renaming a tag must change its display on every linked
    transaction — and because the M2M layout has a single tag row,
    one UPDATE is enough."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    _post_tx(client, cat_id, ["alpha"], desc="a")
    _post_tx(client, cat_id, ["alpha", "beta"], desc="b")

    r = client.put("/api/tags/alpha", json={"new_name": "gamma"})
    assert r.status_code == 200
    # `affected` counts transactions actually linked to the renamed tag.
    assert r.json()["affected"] == 2

    listed = client.get("/api/transactions?year=2026&month=5").json()
    by_desc = {t["desc"]: t["tags"] for t in listed}
    assert by_desc["a"] == ["gamma"]
    assert by_desc["b"] == ["beta", "gamma"]


def test_tag_rename_collision_merges_into_target(client):
    """Renaming to a name that already exists is a merge: every
    transaction linked to the old tag now points at the target tag,
    and the old row is gone."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    _post_tx(client, cat_id, ["old", "target"], desc="both")
    _post_tx(client, cat_id, ["old"], desc="old-only")

    r = client.put("/api/tags/old", json={"new_name": "target"})
    assert r.status_code == 200
    assert r.json()["affected"] == 2

    # ``old`` no longer exists; ``target`` does.
    tag_names = {t["name"] for t in client.get("/api/tags").json()}
    assert "old" not in tag_names
    assert "target" in tag_names

    listed = client.get("/api/transactions?year=2026&month=5").json()
    by_desc = {t["desc"]: t["tags"] for t in listed}
    # Both rows now show "target" only — no duplicates, no leftover
    # "old".
    assert by_desc["both"] == ["target"]
    assert by_desc["old-only"] == ["target"]


def test_tag_delete_removes_from_all_transactions(client):
    """Deleting a tag drops it from every transaction it was linked
    to. The transaction itself stays; only the tag link is gone."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    _post_tx(client, cat_id, ["doomed", "keep"], desc="tx1")
    _post_tx(client, cat_id, ["doomed"], desc="tx2")

    r = client.delete("/api/tags/doomed")
    assert r.status_code == 204

    tag_names = {t["name"] for t in client.get("/api/tags").json()}
    assert "doomed" not in tag_names

    listed = client.get("/api/transactions?year=2026&month=5").json()
    by_desc = {t["desc"]: t["tags"] for t in listed}
    assert by_desc["tx1"] == ["keep"]
    assert by_desc["tx2"] == []


def test_transaction_delete_cleans_up_junction_only(client):
    """ON DELETE CASCADE removes the junction rows but leaves the
    Tag rows for the user — tags are first-class entities, not owned
    by any single transaction."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    create = _post_tx(client, cat_id, ["solo"], desc="will-be-deleted")
    tx_id = create.json()["id"]

    assert client.delete(f"/api/transactions/{tx_id}").status_code == 204

    # Tag survives the transaction deletion.
    tag_names = {t["name"] for t in client.get("/api/tags").json()}
    assert "solo" in tag_names


def test_update_replaces_tag_set_minimally(client):
    """A PUT with a different tag set must end with the new set, not
    a union with the old one."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    create = _post_tx(client, cat_id, ["a", "b", "c"], desc="three")
    tx_id = create.json()["id"]

    update = client.put(
        f"/api/transactions/{tx_id}",
        json={
            "amount": "1.00",
            "desc": "three",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["b", "d"],
        },
    )
    assert update.status_code == 200
    # Result: just {b, d}, neither a nor c.
    assert update.json()["tags"] == ["b", "d"]
