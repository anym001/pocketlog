"""CSV import error reporting (Phase 3).

Per-row errors are stable machine codes + params (no localized prose), and
rows without a category fall back to the user's locale-appropriate bucket.
"""


def _import(client, body: str):
    return client.post(
        "/api/import/csv",
        files={"file": ("import.csv", body.encode("utf-8"), "text/csv")},
    )


def test_unrecognised_date_emits_code_and_value(client):
    body = (
        "date;type;amount;description;category;tags\n"
        "2026-13-99;out;1.00;bad date;Sonstiges;\n"
    )
    r = _import(client, body)
    assert r.status_code == 200
    errs = r.json()["errors"]
    assert errs and errs[0]["code"] == "date_unrecognised"
    assert errs[0]["params"]["value"] == "2026-13-99"


def test_unrecognised_amount_emits_code(client):
    body = (
        "date;type;amount;description;category;tags\n"
        "2026-05-01;out;not-a-number;bad amount;Sonstiges;\n"
    )
    errs = _import(client, body).json()["errors"]
    assert errs and errs[0]["code"] == "amount_unrecognised"
    assert errs[0]["params"]["value"] == "not-a-number"


def test_missing_amount_column_value_emits_code(client):
    body = (
        "date;type;amount;description;category;tags\n"
        "2026-05-01;out;;no amount;Sonstiges;\n"
    )
    errs = _import(client, body).json()["errors"]
    assert errs and errs[0]["code"] == "amount_missing"


def test_no_german_prose_in_error_codes(client):
    body = (
        "date;type;amount;description;category;tags\n"
        "2026-13-99;out;1.00;bad;Sonstiges;\n"
    )
    errs = _import(client, body).json()["errors"]
    # codes are ascii machine tokens, never localized sentences
    for e in errs:
        assert " " not in e["code"]
        assert e["code"].isascii()


def test_missing_category_uses_locale_fallback_en(client):
    # Switch this user to an English locale, import a row without a category.
    # (The user was seeded de-DE, so existing German defaults stay — categories
    # are user data; only the import fallback follows the current locale.)
    client.put("/api/settings", json={"locale": "en-GB"})
    body = "date;type;amount;description\n2026-05-01;out;1.00;no category\n"
    r = _import(client, body)
    assert r.status_code == 200
    assert r.json()["imported"] == 1
    names = {c["name"] for c in client.get("/api/categories").json()}
    # Clean up the imported transaction first so the shared session DB never
    # keeps a tx→category reference that would trip the bulk user-delete in the
    # setup-mode tests (FK RESTRICT on transactions.category_id) — even if the
    # assertion below were to fail.
    client.delete("/api/admin/transactions")
    assert "Other" in names      # import fallback used the en bundle, not "Sonstiges"
