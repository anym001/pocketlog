"""Input/output validation tests for the CSV pipeline and tag bounds."""
from __future__ import annotations

import pytest


# ── Tag validation (M-1) ─────────────────────────────────────────────────


def _make_tx(tags):
    return {
        "amount": "1.00",
        "desc": "test",
        "date": "2026-05-20",
        "type": "out",
        "tags": tags,
    }


def test_tag_array_capped_at_20(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx([f"t{i}" for i in range(21)])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 422


def test_tag_array_at_exactly_20_works(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx([f"t{i}" for i in range(20)])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 201, r.text
    assert len(r.json()["tags"]) == 20


def test_overlong_tag_is_rejected(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx(["x" * 65])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 422


def test_empty_tag_is_rejected(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx(["valid", ""])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 422


def test_tags_are_stripped_and_deduped(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx(["  alpha  ", "Alpha", "beta"])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 201, r.text
    # First occurrence wins, case-fold dedupe drops "Alpha". Tags are
    # returned alphabetically (M2M order_by since 0008_transaction_tags).
    assert r.json()["tags"] == ["alpha", "beta"]


def test_tags_dedupe_uses_casefold_for_eszett(client):
    """Dedupe must match crud.list_tags (also casefold). ß → ss means
    Straße and STRASSE collapse — otherwise list_tags would show one
    entry but the tx would carry two distinct tags."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx(["Straße", "STRASSE"])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 201, r.text
    assert r.json()["tags"] == ["Straße"]


def test_control_chars_stripped_from_tags(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    payload = _make_tx(["foo\x00bar", "baz\nqux"])
    payload["category_id"] = cat_id
    r = client.post("/api/transactions", json=payload)
    assert r.status_code == 201, r.text
    # Alphabetical (M2M order_by since 0008_transaction_tags).
    assert r.json()["tags"] == ["bazqux", "foobar"]


def test_csv_import_strips_control_chars_from_tags(client):
    body = (
        "date;type;amount;description;category;tags\n"
        "2026-05-20;out;1.00;ctrl-csv;Sonstiges;foo\x00bar,clean\n"
    )
    r = client.post(
        "/api/import/csv",
        files={"file": ("import.csv", body.encode("utf-8"), "text/csv")},
    )
    assert r.status_code == 200
    txs = client.get("/api/transactions?year=2026&month=5").json()
    target = next(t for t in txs if t["desc"] == "ctrl-csv")
    assert target["tags"] == ["clean", "foobar"]


# ── Control chars in description and name (L-1) ───────────────────────────


def test_control_chars_stripped_from_description(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    r = client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": "Café\x00 Bar\nLunch",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["desc"] == "Café BarLunch"


def test_control_chars_stripped_from_category_name(client):
    r = client.post(
        "/api/categories",
        json={"name": "Hello\x00World", "icon": "house", "color": "#123456"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "HelloWorld"


def test_category_name_rejected_when_empty_after_strip(client):
    r = client.post(
        "/api/categories",
        json={"name": "\x00\x01\x02", "icon": "house", "color": "#123456"},
    )
    assert r.status_code == 422


def test_tag_rename_strips_control_chars(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": "for-rename",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["old"],
        },
    )
    r = client.put("/api/tags/old", json={"new_name": "fresh\x00name"})
    assert r.status_code == 200
    tags = {t["name"] for t in client.get("/api/tags").json()}
    assert "freshname" in tags


def test_csv_import_strips_control_chars_from_description(client):
    body = (
        "date;type;amount;description;category;tags\n"
        "2026-05-20;out;1.00;Café\x00 Bar;Sonstiges;\n"
    )
    r = client.post(
        "/api/import/csv",
        files={"file": ("import.csv", body.encode("utf-8"), "text/csv")},
    )
    assert r.status_code == 200
    assert r.json()["imported"] == 1
    txs = client.get("/api/transactions?year=2026&month=5").json()
    assert any(t["desc"] == "Café Bar" for t in txs)


# ── CSV export formula-injection (M-2) ────────────────────────────────────


@pytest.mark.parametrize("payload_field", ["desc"])
def test_csv_export_escapes_formula_chars(client, payload_field):
    """Description / category / tag starting with =,+,-,@ get a single-
    quote prefix on export so Excel/Numbers don't evaluate them."""
    cat_id = client.get("/api/categories").json()[0]["id"]
    client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            payload_field: "=2+5",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
        },
    )
    r = client.get("/api/export/csv")
    assert r.status_code == 200
    # The export contains the prefixed form, never the bare formula start.
    assert "'=2+5" in r.text
    # And the dangerous prefix must not appear at the start of any cell
    # (cells are ;-separated here, but the leading char check is enough).
    for line in r.text.splitlines()[1:]:
        for cell in line.split(";"):
            assert not cell.startswith("="), line


def test_csv_export_escapes_tag_with_formula_prefix(client):
    import csv
    import io

    cat_id = client.get("/api/categories").json()[0]["id"]
    client.post(
        "/api/transactions",
        json={
            "amount": "1.00",
            "desc": "tag-formula",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
            "tags": ["=danger", "safe"],
        },
    )
    r = client.get("/api/export/csv")
    rows = list(csv.DictReader(io.StringIO(r.text), delimiter=";"))
    target = next(row for row in rows if row["description"] == "tag-formula")
    # The tags cell must not start with a formula character; the prefix
    # quote keeps Excel/Numbers from evaluating it.
    assert target["tags"].startswith("'=danger")
    assert not target["tags"].startswith("=")


# ── CSV import row cap (M-3) ──────────────────────────────────────────────


def _import_csv(client, body: str):
    return client.post(
        "/api/import/csv",
        files={"file": ("import.csv", body.encode("utf-8"), "text/csv")},
    )


def test_csv_import_rejects_beyond_row_cap(client, monkeypatch):
    # Lower the cap for the test so we don't have to build a 10k-row CSV.
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "MAX_IMPORT_ROWS", 5)

    rows = ["date;type;amount;description;category;tags"]
    for i in range(8):
        rows.append(f"2026-05-2{i % 10};out;1.00;row{i};Sonstiges;")
    r = _import_csv(client, "\n".join(rows))
    assert r.status_code == 200
    data = r.json()
    assert data["imported"] == 5
    # Truncation surfaces as an error entry, not a silent drop.
    assert any(e["code"] == "row_limit" for e in data["errors"])


def test_csv_import_caps_tags_per_row(client):
    """Tags in the CSV column go through _build_transaction, not the
    Pydantic validator — same caps still have to apply."""
    many = ",".join(f"t{i}" for i in range(40))
    body = (
        "date;type;amount;description;category;tags\n"
        f"2026-05-20;out;1.00;tag-flood;Sonstiges;{many}\n"
    )
    r = _import_csv(client, body)
    assert r.status_code == 200
    assert r.json()["imported"] == 1

    txs = client.get("/api/transactions?year=2026&month=5").json()
    target = next(t for t in txs if t["desc"] == "tag-flood")
    assert len(target["tags"]) == 20


def test_csv_import_drops_overlong_tag(client):
    body = (
        "date;type;amount;description;category;tags\n"
        f"2026-05-20;out;1.00;tag-overlong;Sonstiges;valid,{'x' * 65}\n"
    )
    r = _import_csv(client, body)
    assert r.status_code == 200

    txs = client.get("/api/transactions?year=2026&month=5").json()
    target = next(t for t in txs if t["desc"] == "tag-overlong")
    assert target["tags"] == ["valid"]
