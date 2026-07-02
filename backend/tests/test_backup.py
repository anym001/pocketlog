"""JSON full-account backup: export shape, restore round-trip, the
not-empty guard, stable error codes and the auth split (read keys may
export, restore is session-only)."""

from __future__ import annotations

import io
import json

from .conftest import new_category, other_client


def _seed_account(client):
    """Populate one of everything through the public API."""
    cat_id = new_category(client, "Backup-Cat")
    goal_cat_id = new_category(client, "Backup-Goal-Cat")
    budget_cat_id = new_category(client, "Backup-Budget-Cat")

    r = client.post(
        "/api/transactions",
        json={
            "amount": "12.34",
            "desc": "Backup tx",
            "category_id": cat_id,
            "date": "2026-05-01",
            "type": "out",
            "tags": ["Backup-Tag"],
        },
    )
    assert r.status_code == 201, r.text

    r = client.post(
        "/api/goals",
        json={
            "name": "Backup Goal",
            "direction": "save_up",
            "category_id": goal_cat_id,
            "target_amount": "500.00",
            "start_date": "2026-01-01",
        },
    )
    assert r.status_code == 201, r.text

    r = client.post(
        "/api/budgets",
        json={"category_id": budget_cat_id, "amount": "100.00", "frequency": "monthly"},
    )
    assert r.status_code == 201, r.text

    r = client.post(
        "/api/recurring",
        json={
            "name": "Backup Rule",
            "amount": "9.99",
            "type": "out",
            "category_id": cat_id,
            "desc": "Sub",
            "tags": ["Backup-Tag"],
            "frequency": "monthly",
            "day_of_month": 1,
            "start_date": "2026-06-01",
        },
    )
    assert r.status_code == 201, r.text


def _upload(client, payload: dict | bytes, filename="backup.json"):
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    return client.post(
        "/api/import/json",
        files={"file": (filename, io.BytesIO(raw), "application/json")},
    )


def test_export_shape_and_headers(authed_client):
    _seed_account(authed_client)
    res = authed_client.get("/api/export/json")
    assert res.status_code == 200
    assert "pocketlog-backup.json" in res.headers.get("content-disposition", "")
    body = res.json()
    assert body["format"] == "pocketlog-backup"
    assert body["version"] == 1
    assert len(body["transactions"]) >= 1
    tx = body["transactions"][0]
    # Amounts must be strings (Decimal precision), desc uses the alias.
    assert isinstance(tx["amount"], str)
    assert "desc" in tx
    assert body["settings"]["locale"]
    assert any(c["name"] == "Backup-Cat" for c in body["categories"])
    assert "Backup-Tag" in body["tags"]
    assert len(body["goals"]) == 1
    assert len(body["budgets"]) == 1
    assert len(body["recurring_rules"]) == 1
    # Rule cursor state travels with the backup.
    assert body["recurring_rules"][0]["next_occurrence_date"] is not None


def test_restore_round_trip(app, authed_client, db_session):
    _seed_account(authed_client)
    backup = authed_client.get("/api/export/json").json()

    fresh = other_client(app, db_session)
    res = _upload(fresh, backup)
    assert res.status_code == 200, res.text
    counts = res.json()
    assert counts["transactions"] == len(backup["transactions"])
    assert counts["recurring_rules"] == 1

    # Re-export from the restored account and compare the data payloads.
    restored = fresh.get("/api/export/json").json()
    for key in ("transactions", "goals", "budgets", "recurring_rules", "tags"):
        assert restored[key] == backup[key], key
    # Categories: the restored account keeps its seeded defaults plus
    # everything from the backup.
    restored_names = {c["name"] for c in restored["categories"]}
    assert {c["name"] for c in backup["categories"]} <= restored_names
    assert restored["settings"] == backup["settings"]

    # The rule↔transaction link survived: the restored tx carries the
    # restored rule's id.
    txs = fresh.get("/api/transactions").json()
    rules = fresh.get("/api/recurring").json()
    rule_ids = {r["id"] for r in rules}
    linked = [t for t in txs if t.get("source_rule_id")]
    # The seeded rule is backdated, so the source account materialized
    # occurrences that travelled through the backup with their rule link.
    assert linked, "expected restored transactions linked to the restored rule"
    assert all(t["source_rule_id"] in rule_ids for t in linked)


def test_restore_refused_when_ledger_not_empty(authed_client):
    _seed_account(authed_client)
    backup = authed_client.get("/api/export/json").json()
    res = _upload(authed_client, backup)
    assert res.status_code == 409
    assert res.json()["detail"] == "restore_not_empty"


def test_restore_rejects_garbage_and_wrong_version(app, db_session):
    client = other_client(app, db_session)

    res = _upload(client, b"not json at all {{{")
    assert res.status_code == 400
    assert res.json()["detail"] == "backup_invalid"

    res = _upload(client, {"format": "something-else", "version": 1})
    assert res.status_code == 400
    assert res.json()["detail"] == "backup_invalid"

    res = _upload(client, {"format": "pocketlog-backup", "version": 99})
    assert res.status_code == 400
    assert res.json()["detail"] == "backup_unsupported_version"

    # Schema-invalid content (negative amount) → stable code, not a 422.
    res = _upload(
        client,
        {
            "format": "pocketlog-backup",
            "version": 1,
            "transactions": [
                {
                    "date": "2026-01-01",
                    "type": "out",
                    "amount": "-5.00",
                    "category": "X",
                }
            ],
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "backup_invalid"


def test_restore_conflict_rolls_back(app, db_session):
    """Duplicate rule names violate the UNIQUE constraint → 409 and the
    account stays empty (single-transaction restore)."""
    client = other_client(app, db_session)
    rule = {
        "name": "Twice",
        "amount": "1.00",
        "type": "out",
        "category": "X",
        "frequency": "monthly",
        "day_of_month": 1,
        "start_date": "2026-01-01",
    }
    res = _upload(
        client,
        {
            "format": "pocketlog-backup",
            "version": 1,
            "recurring_rules": [rule, dict(rule)],
        },
    )
    assert res.status_code == 409
    assert res.json()["detail"] == "restore_conflict"
    assert client.get("/api/recurring").json() == []


def test_restore_is_session_only(app, authed_client, db_session):
    """A write-scoped API key can export but must never restore."""
    r = authed_client.post(
        "/api/api-keys", json={"name": "backup-key", "scopes": ["write"]}
    )
    assert r.status_code == 201, r.text
    raw_key = r.json()["key"]

    from fastapi.testclient import TestClient

    bearer = TestClient(app)
    bearer.headers["Authorization"] = f"Bearer {raw_key}"

    assert bearer.get("/api/export/json").status_code == 200

    res = bearer.post(
        "/api/import/json",
        files={
            "file": (
                "b.json",
                io.BytesIO(
                    json.dumps({"format": "pocketlog-backup", "version": 1}).encode()
                ),
                "application/json",
            )
        },
    )
    # No session cookie → the session-only dependency rejects it.
    assert res.status_code == 401


def test_upload_size_cap_rejects_oversized_csv(authed_client):
    """The chunked reader aborts with 413 once the cap is crossed."""
    big = b"date;type;amount\n" + b"x" * (5 * 1024 * 1024 + 1)
    res = authed_client.post(
        "/api/import/csv",
        files={"file": ("big.csv", io.BytesIO(big), "text/csv")},
    )
    assert res.status_code == 413
