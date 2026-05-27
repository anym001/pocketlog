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


def _voluntary_client(app, db_session):
    """User mit ``force_change_password=False`` — Self-Service-Pfad.
    Hier ist die ``current_password``-Verifikation aktiv."""
    import uuid

    from app import crud

    user = crud.create_user(
        db_session,
        username=f"voluntary-{uuid.uuid4().hex[:8]}",
        password=TEST_PASSWORD,
        force_change_password=False,
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


def test_change_password_rejects_short_new_password(app, db_session):
    client, _ = _force_pw_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "tooshort"},
    )
    assert res.status_code == 422


def test_change_password_rejects_wrong_current_in_voluntary_change(app, db_session):
    """Im normalen Self-Service-Pfad (force_change=False) muss
    ``current_password`` stimmen — sonst könnte ein Session-Dieb das
    Passwort umhängen."""
    client, _ = _voluntary_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={
            "current_password": "definitely-wrong",
            "new_password": "valid-password-2026",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "current_password_wrong"


def test_change_password_rejects_reused_password_in_voluntary_change(app, db_session):
    client, _ = _voluntary_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={
            "current_password": TEST_PASSWORD,
            "new_password": TEST_PASSWORD,
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "password_reused"


def test_force_change_skips_current_password_verification(app, db_session):
    """Im Force-Change-Zustand ist das ``current_password`` administrativ
    (Admin-Reset oder CLI-Bootstrap) — die Verifikation würde nichts
    beweisen und nur Migranten/Recovered-User aussperren. Wir nehmen
    einen falschen ``current_password``-Wert hier akzeptiert hin, weil
    der User das Passwort eh sofort ändern MUSS."""
    client, user = _force_pw_client(app, db_session)
    res = client.post(
        "/api/auth/change-password",
        json={
            "current_password": "ignored-because-force-change-is-on",
            "new_password": "valid-password-2026",
        },
    )
    assert res.status_code == 204
    db_session.refresh(user)
    assert user.force_change_password is False


def test_change_password_no_current_password_when_hash_is_null(app, db_session):
    """Migration path: admin has force_change_password=True but password_hash
    IS NULL. Must be able to set a password without providing a current one."""
    import uuid
    from app import crud, models

    # Simulate a migrated user: created without a password.
    user = crud.create_user(
        db_session,
        username=f"migrated-{uuid.uuid4().hex[:8]}",
        password="temporary-bootstrap-pw",
        force_change_password=True,
    )
    # Wipe the password hash to simulate the migration state.
    user.password_hash = None
    db_session.commit()

    # Login is impossible with NULL hash, so we create a session directly.
    from app import auth as auth_mod
    session, plain = auth_mod.create_session(
        db_session, user, remember_me=False, user_agent=None
    )
    client = TestClient(app)
    client.cookies.set("pocketlog_session", plain)
    client.cookies.set("pocketlog_csrf", session.csrf_token)
    client.headers["X-CSRF-Token"] = session.csrf_token

    # /api/auth/me must reflect the force-change state — the frontend
    # uses that to render the force-change view, where the backend then
    # ignores the (missing) current_password.
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["force_change_password"] is True

    # change-password without current_password must succeed.
    res = client.post(
        "/api/auth/change-password",
        json={"current_password": None, "new_password": "brand-new-password-2026"},
    )
    assert res.status_code == 204

    db_session.refresh(user)
    assert user.force_change_password is False
    assert user.password_hash is not None
