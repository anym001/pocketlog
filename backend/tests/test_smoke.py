"""End-to-end smoke tests covering the API surface PocketLog actually ships.

Each test creates a fresh user via the auth-header fixture, exercises a
slice of the API, and trusts the existing data-isolation in CRUD (every
query is filtered by user_id) to keep tests independent.
"""

from __future__ import annotations


def test_health_endpoint(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_version_endpoint(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    assert "version" in r.json()


def test_first_request_seeds_default_categories(client):
    # First request that triggers get_current_user → user row + 7 default
    # categories from crud._seed_default_categories.
    r = client.get("/api/categories")
    assert r.status_code == 200
    cats = r.json()
    assert len(cats) == 7
    names = {c["name"] for c in cats}
    assert "Lebensmittel" in names or "Wohnen" in names


def test_category_crud_roundtrip(client):
    create = client.post(
        "/api/categories",
        json={"name": "Reisen", "icon": "airplane", "color": "#2a78d8"},
    )
    assert create.status_code == 201, create.text
    cat_id = create.json()["id"]

    # Duplicate name → 409
    dup = client.post(
        "/api/categories",
        json={"name": "Reisen", "icon": "airplane", "color": "#000000"},
    )
    assert dup.status_code == 409

    update = client.put(
        f"/api/categories/{cat_id}",
        json={"name": "Urlaub", "icon": "airplane", "color": "#2a78d8"},
    )
    assert update.status_code == 200
    assert update.json()["name"] == "Urlaub"

    delete = client.delete(f"/api/categories/{cat_id}")
    assert delete.status_code == 204


def test_transaction_crud_roundtrip(client):
    cats = client.get("/api/categories").json()
    cat_id = cats[0]["id"]

    create = client.post(
        "/api/transactions",
        json={
            "amount": "12.50",
            "desc": "Bäcker",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["frühstück"],
        },
    )
    assert create.status_code == 201, create.text
    tx = create.json()
    assert tx["desc"] == "Bäcker"
    assert tx["tags"] == ["frühstück"]
    tx_id = tx["id"]

    listed = client.get("/api/transactions?year=2026&month=5").json()
    assert any(t["id"] == tx_id for t in listed)

    update = client.put(
        f"/api/transactions/{tx_id}",
        json={
            "amount": "15.00",
            "desc": "Bäcker",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["frühstück", "wochenende"],
        },
    )
    assert update.status_code == 200
    assert update.json()["amount"] == "15.00"

    delete = client.delete(f"/api/transactions/{tx_id}")
    assert delete.status_code == 204
    assert client.delete(f"/api/transactions/{tx_id}").status_code == 404


def test_category_in_use_cannot_be_deleted(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    tx = client.post(
        "/api/transactions",
        json={
            "amount": "5.00",
            "desc": "Test",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
        },
    )
    assert tx.status_code == 201

    blocked = client.delete(f"/api/categories/{cat_id}")
    assert blocked.status_code == 409


def test_tag_lifecycle_through_transactions(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    client.post(
        "/api/transactions",
        json={
            "amount": "9.99",
            "desc": "Test",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["alpha", "beta"],
        },
    )

    tags = client.get("/api/tags").json()
    names = {t["name"] for t in tags}
    assert {"alpha", "beta"}.issubset(names)

    rename = client.put("/api/tags/alpha", json={"new_name": "gamma"})
    assert rename.status_code == 200

    tags_after = {t["name"] for t in client.get("/api/tags").json()}
    assert "alpha" not in tags_after
    assert "gamma" in tags_after


def test_admin_all_data_clears_user(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": "x",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["foo"],
        },
    )
    assert client.get("/api/transactions?year=2026&month=5").json()
    assert client.get("/api/tags").json()

    # A goal on the same category must be cleared too — not orphaned.
    client.post(
        "/api/goals",
        json={
            "name": "Notgroschen",
            "direction": "save_up",
            "category_id": cat_id,
            "initial_amount": "0.00",
            "target_amount": "500.00",
            "start_date": "2026-01-01",
        },
    )
    assert client.get("/api/goals").json()

    r = client.delete("/api/admin/all-data")
    assert r.status_code == 204

    assert client.get("/api/transactions?year=2026&month=5").json() == []
    assert client.get("/api/tags").json() == []
    assert client.get("/api/categories").json() == []
    assert client.get("/api/goals").json() == []


def test_settings_default_and_update(client):
    settings = client.get("/api/settings").json()
    assert settings["theme"] == "system"
    assert settings["default_view"] == "transactions"

    upd = client.put("/api/settings", json={"theme": "dark"})
    assert upd.status_code == 200
    assert upd.json()["theme"] == "dark"
    # Partial update — default_view stays untouched
    assert upd.json()["default_view"] == "transactions"
