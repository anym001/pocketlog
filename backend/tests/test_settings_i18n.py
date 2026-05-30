"""Language & currency settings.

Covers the new ``user_settings.language`` / ``currency`` columns: the
PUT/GET roundtrip, validation of unsupported values, language-aware
default-category seeding, and the admin-create inheritance path.
"""


def test_settings_defaults_language_currency(client):
    s = client.get("/api/settings").json()
    assert s["language"] == "de"
    assert s["currency"] == "EUR"


def test_settings_update_language_and_currency(client):
    r = client.put("/api/settings", json={"language": "en", "currency": "USD"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["language"] == "en"
    assert s["currency"] == "USD"
    # Persisted across reads.
    assert client.get("/api/settings").json()["currency"] == "USD"


def test_settings_currency_is_normalised_uppercase(client):
    r = client.put("/api/settings", json={"currency": "chf"})
    assert r.status_code == 200, r.text
    assert r.json()["currency"] == "CHF"


def test_settings_rejects_unknown_currency(client):
    r = client.put("/api/settings", json={"currency": "XYZ"})
    assert r.status_code == 422


def test_settings_rejects_unknown_language(client):
    r = client.put("/api/settings", json={"language": "fr"})
    assert r.status_code == 422


def test_partial_update_leaves_other_fields_untouched(client):
    client.put("/api/settings", json={"language": "en", "currency": "GBP"})
    client.put("/api/settings", json={"theme": "dark"})
    s = client.get("/api/settings").json()
    assert s["language"] == "en"
    assert s["currency"] == "GBP"
    assert s["theme"] == "dark"


def test_create_user_seeds_categories_in_chosen_language(db_session):
    import uuid

    from app import crud, models

    user = crud.create_user(
        db_session,
        username=f"en-{uuid.uuid4().hex[:12]}",
        password="Test-password-1234",
        language="en",
        currency="USD",
    )
    names = {
        c.name
        for c in db_session.query(models.Category).filter_by(user_id=user.id)
    }
    assert "Groceries" in names
    assert "Lebensmittel" not in names
    settings = crud.get_or_create_settings(db_session, user.id)
    assert settings.language == "en"
    assert settings.currency == "USD"


def test_create_user_defaults_to_german_categories(db_session):
    import uuid

    from app import crud, models

    user = crud.create_user(
        db_session,
        username=f"de-{uuid.uuid4().hex[:12]}",
        password="Test-password-1234",
    )
    names = {
        c.name
        for c in db_session.query(models.Category).filter_by(user_id=user.id)
    }
    assert "Lebensmittel" in names


def test_admin_created_user_inherits_admin_locale(admin_client, db_session):
    from app import models

    # Admin switches to English / USD …
    admin_client.put("/api/settings", json={"language": "en", "currency": "USD"})
    # … then creates a user, who should inherit both.
    r = admin_client.post(
        "/api/admin/users",
        json={"username": "inherit-en", "password": "Test-password-1234"},
    )
    assert r.status_code == 201, r.text
    new_id = r.json()["id"]

    settings = db_session.query(models.UserSettings).filter_by(user_id=new_id).one()
    assert settings.language == "en"
    assert settings.currency == "USD"
    names = {
        c.name
        for c in db_session.query(models.Category).filter_by(user_id=new_id)
    }
    assert "Groceries" in names
