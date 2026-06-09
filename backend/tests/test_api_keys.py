"""Tests for API key management and Bearer-token import auth.

Covers:
- Create / list / revoke via the /api/api-keys endpoints
- Auth validation: invalid key, expired key, wrong scope
- POST /api/import/csv accessible via Bearer token with 'import' scope
- Import deduplication: second identical import returns deduped count
- Audit log events for create and revoke
"""

from __future__ import annotations

import csv
import io
import logging
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app import crud

AUDIT = "pocketlog.audit"


@pytest.fixture(autouse=True)
def _capture_audit(caplog):
    caplog.set_level(logging.INFO, logger="pocketlog")
    plog = logging.getLogger("pocketlog")
    plog.addHandler(caplog.handler)
    try:
        yield
    finally:
        plog.removeHandler(caplog.handler)


# ── helpers ──────────────────────────────────────────────────────────────────


def _make_csv(rows: list[dict]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["date", "type", "amount", "description", "category", "tags"])
    for r in rows:
        writer.writerow([r["date"], r["type"], r["amount"], r["desc"], "", ""])
    return buf.getvalue().encode()


_SAMPLE_ROW = {"date": "2024-01-15", "type": "out", "amount": "12.50", "desc": "coffee"}


# ── CRUD layer ────────────────────────────────────────────────────────────────


def test_create_api_key_returns_raw_key(db_session, regular_user):
    key, raw = crud.create_api_key(db_session, regular_user.id, "test-key", ["import"])
    assert raw.startswith("plk_")
    assert len(raw) > 10
    assert key.key_hash != raw
    assert key.name == "test-key"
    assert key.scopes == '["import"]'
    assert key.user_id == regular_user.id


def test_list_api_keys(db_session, regular_user):
    crud.create_api_key(db_session, regular_user.id, "k1", ["import"])
    crud.create_api_key(db_session, regular_user.id, "k2", ["read"])
    keys = crud.list_api_keys(db_session, regular_user.id)
    names = {k.name for k in keys}
    assert {"k1", "k2"}.issubset(names)


def test_revoke_api_key(db_session, regular_user):
    key, _ = crud.create_api_key(db_session, regular_user.id, "to-revoke", ["import"])
    assert crud.revoke_api_key(db_session, regular_user.id, key.id)
    assert crud.get_api_key_by_hash(db_session, key.key_hash) is None


def test_revoke_wrong_user_returns_false(db_session, regular_user, admin_user):
    key, _ = crud.create_api_key(db_session, regular_user.id, "my-key", ["import"])
    assert not crud.revoke_api_key(db_session, admin_user.id, key.id)


# ── HTTP endpoints ─────────────────────────────────────────────────────────────


def test_list_keys_empty(authed_client):
    res = authed_client.get("/api/api-keys")
    assert res.status_code == 200
    # result may contain keys from other tests; just check it's a list
    assert isinstance(res.json(), list)


def test_create_key_endpoint(authed_client):
    res = authed_client.post(
        "/api/api-keys", json={"name": "ci-tool", "scopes": ["import"]}
    )
    assert res.status_code == 201
    data = res.json()
    assert data["name"] == "ci-tool"
    assert "import" in data["scopes"]
    assert data["key"].startswith("plk_")
    assert "id" in data
    assert "created_at" in data


def test_create_key_appears_in_list(authed_client):
    res = authed_client.post(
        "/api/api-keys", json={"name": "list-test", "scopes": ["read"]}
    )
    assert res.status_code == 201
    key_id = res.json()["id"]

    listed = authed_client.get("/api/api-keys").json()
    ids = {k["id"] for k in listed}
    assert key_id in ids
    # raw key is NOT exposed in list
    for k in listed:
        assert "key" not in k


def test_revoke_key_endpoint(authed_client):
    create_res = authed_client.post(
        "/api/api-keys", json={"name": "revoke-me", "scopes": ["import"]}
    )
    key_id = create_res.json()["id"]

    del_res = authed_client.delete(f"/api/api-keys/{key_id}")
    assert del_res.status_code == 204

    listed = authed_client.get("/api/api-keys").json()
    assert key_id not in {k["id"] for k in listed}


def test_revoke_nonexistent_returns_404(authed_client):
    res = authed_client.delete("/api/api-keys/999999")
    assert res.status_code == 404


def test_create_key_requires_at_least_one_scope(authed_client):
    res = authed_client.post(
        "/api/api-keys", json={"name": "no-scope", "scopes": []}
    )
    assert res.status_code == 422


def test_create_key_requires_name(authed_client):
    res = authed_client.post(
        "/api/api-keys", json={"name": "", "scopes": ["import"]}
    )
    assert res.status_code == 422


# ── Bearer-token import ────────────────────────────────────────────────────────


def test_import_csv_via_bearer(app, db_session, regular_user):
    _, raw = crud.create_api_key(db_session, regular_user.id, "bearer-test", ["import"])
    client = TestClient(app)

    csv_bytes = _make_csv([_SAMPLE_ROW])
    res = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["imported"] >= 1
    assert data["deduped"] == 0


def test_import_csv_invalid_bearer_returns_401(app):
    client = TestClient(app)
    csv_bytes = _make_csv([_SAMPLE_ROW])
    res = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers={"Authorization": "Bearer plk_totally_fake"},
    )
    assert res.status_code == 401


def test_import_csv_wrong_scope_returns_403(app, db_session, regular_user):
    _, raw = crud.create_api_key(db_session, regular_user.id, "read-only", ["read"])
    client = TestClient(app)
    csv_bytes = _make_csv([_SAMPLE_ROW])
    res = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 403


def test_import_csv_expired_key_returns_401(app, db_session, regular_user):
    key, raw = crud.create_api_key(db_session, regular_user.id, "expired", ["import"])
    # Manually expire the key
    key.expires_at = datetime(2000, 1, 1, tzinfo=UTC).replace(tzinfo=None)
    db_session.commit()

    client = TestClient(app)
    csv_bytes = _make_csv([_SAMPLE_ROW])
    res = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 401


def test_import_csv_admin_scope_grants_import_access(app, db_session, regular_user):
    _, raw = crud.create_api_key(db_session, regular_user.id, "admin-key", ["admin"])
    client = TestClient(app)
    csv_bytes = _make_csv([_SAMPLE_ROW])
    res = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 200


# ── Import deduplication ──────────────────────────────────────────────────────


def test_import_dedup_second_run_skips_duplicates(app, db_session, regular_user):
    _, raw = crud.create_api_key(db_session, regular_user.id, "dedup-test", ["import"])
    client = TestClient(app)

    rows = [
        {"date": "2024-03-01", "type": "out", "amount": "5.00", "desc": "dedup-a"},
        {"date": "2024-03-02", "type": "in", "amount": "100.00", "desc": "dedup-b"},
    ]
    csv_bytes = _make_csv(rows)
    headers = {"Authorization": f"Bearer {raw}"}

    # First import — both rows created
    r1 = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers=headers,
    )
    assert r1.status_code == 200
    assert r1.json()["imported"] == 2
    assert r1.json()["deduped"] == 0

    # Second import — both rows are duplicates
    r2 = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers=headers,
    )
    assert r2.status_code == 200
    assert r2.json()["imported"] == 0
    assert r2.json()["deduped"] == 2


def test_import_dedup_within_same_file(app, db_session, regular_user):
    _, raw = crud.create_api_key(
        db_session, regular_user.id, "dedup-within", ["import"]
    )
    client = TestClient(app)

    # CSV with one duplicate row
    row = {
        "date": "2024-04-01",
        "type": "out",
        "amount": "9.99",
        "desc": "intrafile-dup",
    }
    csv_bytes = _make_csv([row, row])
    res = client.post(
        "/api/import/csv",
        files={"file": ("test.csv", csv_bytes, "text/csv")},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert res.status_code == 200
    assert res.json()["imported"] == 1
    assert res.json()["deduped"] == 1


# ── Audit logging ─────────────────────────────────────────────────────────────


def test_api_key_create_audit_event(authed_client, caplog):
    authed_client.post(
        "/api/api-keys", json={"name": "audit-create", "scopes": ["import"]}
    )
    messages = [r.message for r in caplog.records if r.name == AUDIT]
    assert any("api_key.create" in m for m in messages)


def test_api_key_revoke_audit_event(authed_client, caplog):
    res = authed_client.post(
        "/api/api-keys", json={"name": "audit-revoke", "scopes": ["import"]}
    )
    key_id = res.json()["id"]
    authed_client.delete(f"/api/api-keys/{key_id}")
    messages = [r.message for r in caplog.records if r.name == AUDIT]
    assert any("api_key.revoke" in m for m in messages)


def test_audit_does_not_log_raw_key(authed_client, caplog):
    res = authed_client.post(
        "/api/api-keys", json={"name": "secret-check", "scopes": ["import"]}
    )
    raw_key = res.json()["key"]
    all_messages = " ".join(r.message for r in caplog.records)
    assert raw_key not in all_messages
