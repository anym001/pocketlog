"""Setup-Modus: bootstrap des ersten Admins via Setup-View."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient


def _fresh_client(app):
    return TestClient(app)


def test_setup_status_reports_done_when_admin_exists(client):
    """Eine Suite mit ``regular_user``/``admin_user``-Fixtures hat
    immer einen Admin in der DB. Der Status muss ``needs_setup=False``
    melden."""
    res = client.get("/api/auth/setup-status")
    assert res.status_code == 200
    body = res.json()
    assert body["needs_setup"] is False
    assert body["suggested_username"] is None


def test_setup_is_blocked_after_admin_exists(app, admin_user):
    """Doppel-Setup-Versuch: sobald ein Admin angelegt ist, antwortet
    das Backend mit 409 (auch wenn der Aufrufer nicht eingeloggt ist).
    Ohne diese Sperre könnte ein zweiter Setup-Aufruf einen Fremd-Admin
    überschreiben."""
    fresh = _fresh_client(app)
    res = fresh.post(
        "/api/auth/setup",
        json={"username": "intruder", "password": "Another-good-pw-1234"},
    )
    assert res.status_code == 409
    assert res.json()["detail"] == "setup_already_done"


def test_setup_password_min_length(app, db_session):
    """Auch im Setup gilt die 12-Zeichen-Mindestlänge."""
    # Setup-Modus simulieren: bestehende User entfernen, damit
    # needs_setup wieder true wird. Frischer Run gegen leere DB.
    from app import models

    db_session.query(models.User).delete()
    db_session.commit()

    fresh = _fresh_client(app)
    res = fresh.post(
        "/api/auth/setup",
        json={"username": "newadmin", "password": "short"},
    )
    assert res.status_code == 422


def test_setup_fresh_install_creates_admin_and_logs_in(app, db_session):
    """Komplettpfad: leere DB → Setup-Status → POST /setup → eingeloggt
    als Admin."""
    from app import crud, models

    db_session.query(models.User).delete()
    db_session.commit()

    fresh = _fresh_client(app)
    status = fresh.get("/api/auth/setup-status").json()
    assert status["needs_setup"] is True
    assert status["suggested_username"] is None

    username = f"first-admin-{uuid.uuid4().hex[:8]}"
    res = fresh.post(
        "/api/auth/setup",
        json={"username": username, "password": "Valid-password-1234"},
    )
    assert res.status_code == 200
    # Session-Cookie ist gesetzt.
    assert "pocketlog_session" in fresh.cookies
    assert "pocketlog_csrf" in fresh.cookies

    # me sieht den frischen Admin.
    me = fresh.get("/api/auth/me")
    assert me.status_code == 200
    body = me.json()
    assert body["username"] == username
    assert body["is_admin"] is True
    assert body["force_change_password"] is False

    # Default-Kategorien sind geseedet (Setup-Pfad triggert
    # _seed_default_categories über crud.create_user).
    user = crud.get_user_by_username(db_session, username)
    assert user is not None
    cats = crud.list_categories(db_session, user.id)
    assert len(cats) >= 1


def test_setup_for_pending_admin_assigns_password(app, db_session):
    """Migrationspfad: Bestandsuser ohne Passwort wurde zum Admin
    promoviert und muss im Setup nur sein Passwort vergeben. Der
    Username ist DB-seitig fix — wir akzeptieren, was der Server
    vorschlägt."""
    from app import auth, models

    db_session.query(models.User).delete()
    db_session.commit()

    # Migrierter User: kein Passwort-Hash, force_change_password=true,
    # admin promoviert.
    user = models.User(
        username="legacy-user",
        password_hash=None,
        is_admin=True,
        is_active=True,
        force_change_password=True,
    )
    db_session.add(user)
    db_session.commit()

    fresh = _fresh_client(app)
    status = fresh.get("/api/auth/setup-status").json()
    assert status["needs_setup"] is True
    assert status["suggested_username"] == "legacy-user"

    # Wir schicken den vorgeschlagenen Username samt Passwort.
    res = fresh.post(
        "/api/auth/setup",
        json={
            "username": "legacy-user",
            "password": "Set-on-first-login-9876",
        },
    )
    assert res.status_code == 200

    db_session.refresh(user)
    assert user.password_hash is not None
    assert user.force_change_password is False
    assert auth.verify_password("Set-on-first-login-9876", user.password_hash)
