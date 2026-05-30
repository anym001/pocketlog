"""Locale & currency settings.

Covers the ``user_settings.locale`` / ``currency`` columns: the PUT/GET
roundtrip, validation, locale-aware default-category seeding (bundle =
primary subtag), and the admin-create inheritance path.
"""


def test_settings_defaults_locale_currency(client):
    s = client.get("/api/settings").json()
    assert s["locale"] == "de-DE"
    assert s["currency"] == "EUR"


def test_settings_update_locale_and_currency(client):
    r = client.put("/api/settings", json={"locale": "en-GB", "currency": "USD"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["locale"] == "en-GB"
    assert s["currency"] == "USD"
    assert client.get("/api/settings").json()["locale"] == "en-GB"


def test_settings_locale_is_normalised(client):
    r = client.put("/api/settings", json={"locale": "de_at"})
    assert r.status_code == 200, r.text
    assert r.json()["locale"] == "de-AT"


def test_settings_currency_is_normalised_uppercase(client):
    r = client.put("/api/settings", json={"currency": "chf"})
    assert r.status_code == 200, r.text
    assert r.json()["currency"] == "CHF"


def test_settings_rejects_unknown_currency(client):
    assert client.put("/api/settings", json={"currency": "XYZ"}).status_code == 422


def test_settings_rejects_unknown_locale(client):
    assert client.put("/api/settings", json={"locale": "fr-FR"}).status_code == 422
    assert client.put("/api/settings", json={"locale": "en"}).status_code == 422


def test_partial_update_leaves_other_fields_untouched(client):
    client.put("/api/settings", json={"locale": "en-US", "currency": "GBP"})
    client.put("/api/settings", json={"theme": "dark"})
    s = client.get("/api/settings").json()
    assert s["locale"] == "en-US"
    assert s["currency"] == "GBP"
    assert s["theme"] == "dark"


def test_create_user_seeds_categories_by_locale_bundle(db_session):
    import uuid

    from app import crud, models

    user = crud.create_user(
        db_session,
        username=f"en-{uuid.uuid4().hex[:12]}",
        password="Test-password-1234",
        locale="en-GB",
        currency="USD",
    )
    names = {
        c.name
        for c in db_session.query(models.Category).filter_by(user_id=user.id)
    }
    assert "Groceries" in names
    assert "Lebensmittel" not in names
    settings = crud.get_or_create_settings(db_session, user.id)
    assert settings.locale == "en-GB"
    assert settings.currency == "USD"


def test_de_at_seeds_german_categories(db_session):
    import uuid

    from app import crud, models

    user = crud.create_user(
        db_session,
        username=f"at-{uuid.uuid4().hex[:12]}",
        password="Test-password-1234",
        locale="de-AT",
    )
    names = {
        c.name
        for c in db_session.query(models.Category).filter_by(user_id=user.id)
    }
    assert "Lebensmittel" in names  # de-AT -> de bundle


def test_admin_created_user_inherits_admin_locale(admin_client, db_session):
    from app import models

    admin_client.put("/api/settings", json={"locale": "en-US", "currency": "USD"})
    r = admin_client.post(
        "/api/admin/users",
        json={"username": "inherit-en", "password": "Test-password-1234"},
    )
    assert r.status_code == 201, r.text
    new_id = r.json()["id"]

    settings = db_session.query(models.UserSettings).filter_by(user_id=new_id).one()
    assert settings.locale == "en-US"
    assert settings.currency == "USD"
    names = {
        c.name
        for c in db_session.query(models.Category).filter_by(user_id=new_id)
    }
    assert "Groceries" in names


def test_setup_status_exposes_default_locale(client):
    # Public endpoint — reachable without the auth the fixture adds.
    s = client.get("/api/auth/setup-status").json()
    assert s["default_locale"] == "de-DE"


def test_env_default_locale_resolver(monkeypatch):
    from app import crud

    monkeypatch.setenv("DEFAULT_LOCALE", "en-gb")  # case-normalised
    assert crud._resolve_default_locale() == "en-GB"
    monkeypatch.setenv("DEFAULT_LOCALE", "klingon")  # invalid -> fallback
    assert crud._resolve_default_locale() == "de-DE"
    monkeypatch.delenv("DEFAULT_LOCALE", raising=False)
    assert crud._resolve_default_locale() == "de-DE"


def test_env_default_currency_resolver(monkeypatch):
    from app import crud

    monkeypatch.setenv("DEFAULT_CURRENCY", "usd")
    assert crud._resolve_default_currency() == "USD"
    monkeypatch.setenv("DEFAULT_CURRENCY", "XXX")
    assert crud._resolve_default_currency() == "EUR"
