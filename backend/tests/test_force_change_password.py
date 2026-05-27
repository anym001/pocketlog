"""Force-Change-Password-Pfad: blockt App-Endpoints, löst Flag nach
erfolgreichem Change, invalidiert andere Sessions."""
from __future__ import annotations

from sqlalchemy import select as sa_select
from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def _force_pw_client(app, db_session):
    """Pro Aufruf einen frischen User — UUID im Namen, damit Tests in
    derselben Suite nicht über die UNIQUE-Constraint kollidieren."""
    import uuid

    from app import crud

    user = crud.create_user(
        db_session,
        username=f"must-change-{uuid.uuid4().hex[:8]}",
        password=TEST_PASSWORD,
        force_change_password=True,
    )
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200
    csrf = res.json()["user"]["csrf_token"]
    client.headers["X-CSRF-Token"] = csrf
    return client, user


def test_force_change_blocks_normal_endpoints(app, db_session):
    client, _ = _force_pw_client(app, db_session)
    # /api/categories liegt hinter require_active_password → 403.
    res = client.get("/api/categories")
    assert res.status_code == 403
    assert res.json()["detail"] == "password_change_required"


def test_force_change_allows_me_and_change_password(app, db_session):
    """me und change-password müssen erreichbar bleiben, damit das
    Frontend das Flag überhaupt erkennen und auflösen kann."""
    client, _ = _force_pw_client(app, db_session)

    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["force_change_password"] is True


def test_change_password_clears_flag_and_unlocks_api(app, db_session):
    client, user = _force_pw_client(app, db_session)

    new_pw = "a-fresh-strong-password-2026"
    res = client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": new_pw},
    )
    assert res.status_code == 204

    db_session.refresh(user)
    assert user.force_change_password is False
    # Jetzt funktioniert /api/categories.
    res = client.get("/api/categories")
    assert res.status_code == 200


def test_change_password_invalidates_other_sessions(app, db_session):
    """Ein parallel eingeloggter Tab (Session B) muss nach dem
    Password-Change in Session A einen 401 sehen."""
    from app import auth, crud, models

    user = crud.create_user(
        db_session,
        username="multi-session-user",
        password=TEST_PASSWORD,
        force_change_password=False,
    )
    # Session A
    a = TestClient(app)
    a.post("/api/auth/login", json={"username": user.username, "password": TEST_PASSWORD})
    a.headers["X-CSRF-Token"] = a.cookies["pocketlog_csrf"]

    # Session B
    b = TestClient(app)
    b.post("/api/auth/login", json={"username": user.username, "password": TEST_PASSWORD})

    # Beide klappen gerade noch
    assert a.get("/api/categories").status_code == 200
    assert b.get("/api/categories").status_code == 200

    # In A das Passwort ändern.
    res = a.post(
        "/api/auth/change-password",
        json={
            "current_password": TEST_PASSWORD,
            "new_password": "rotated-password-9999",
        },
    )
    assert res.status_code == 204

    # B sollte jetzt aus sein.
    assert b.get("/api/categories").status_code == 401


def test_change_password_rejects_short_new_password(app, db_session):
    client, _ = _force_pw_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "tooshort"},
    )
    assert res.status_code == 422


def test_change_password_rejects_wrong_current(app, db_session):
    client, _ = _force_pw_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={
            "current_password": "definitely-wrong",
            "new_password": "valid-password-2026",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "current_password_wrong"


def test_change_password_rejects_reused_password(app, db_session):
    client, _ = _force_pw_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={
            "current_password": TEST_PASSWORD,
            "new_password": TEST_PASSWORD,
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "password_reused"
