"""Admin-Endpoints: User-Liste, anlegen, Passwort-Reset, deaktivieren,
löschen — inklusive Self-/Admin-Schutz."""
from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def test_admin_list_users_includes_self(admin_client, admin_user):
    res = admin_client.get("/api/admin/users")
    assert res.status_code == 200
    users = res.json()
    usernames = [u["username"] for u in users]
    assert admin_user.username in usernames


def test_admin_list_users_requires_admin(authed_client):
    """Normaler User → 403."""
    res = authed_client.get("/api/admin/users")
    assert res.status_code == 403
    assert res.json()["detail"] == "admin_required"


def test_admin_create_user_sets_force_change_password(admin_client, db_session):
    from app import crud

    username = f"new-{uuid.uuid4().hex[:8]}"
    res = admin_client.post(
        "/api/admin/users",
        json={"username": username, "password": "initial-password-2026"},
    )
    assert res.status_code == 201
    body = res.json()
    assert body["username"] == username
    assert body["is_admin"] is False
    assert body["is_active"] is True
    assert body["force_change_password"] is True

    user = crud.get_user_by_username(db_session, username)
    assert user is not None
    assert user.force_change_password is True


def test_admin_create_user_rejects_duplicate(admin_client, regular_user):
    res = admin_client.post(
        "/api/admin/users",
        json={
            "username": regular_user.username,
            "password": "any-valid-password",
        },
    )
    assert res.status_code == 409
    assert res.json()["detail"] == "username_taken"


def test_admin_reset_password_forces_change_and_kills_sessions(
    app, admin_client, regular_user, db_session
):
    """Reset durch Admin: Passwort neu, force_change=true, alle
    Sessions des Ziel-Users werden gekillt."""
    from sqlalchemy import select as sa_select
    from app import models

    # Regular-User loggt sich ein, hat danach eine Session.
    user_client = TestClient(app)
    user_client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert user_client.get("/api/categories").status_code == 200

    # Admin resettet.
    res = admin_client.post(
        f"/api/admin/users/{regular_user.id}/reset-password",
        json={"new_password": "reset-by-admin-1234"},
    )
    assert res.status_code == 204

    db_session.refresh(regular_user)
    assert regular_user.force_change_password is True

    # User-Session ist tot.
    assert user_client.get("/api/categories").status_code == 401

    # Mit neuem Passwort kommt der User rein, aber landet im Force-PW-View.
    fresh = TestClient(app)
    res = fresh.post(
        "/api/auth/login",
        json={
            "username": regular_user.username,
            "password": "reset-by-admin-1234",
        },
    )
    assert res.status_code == 200
    assert res.json()["user"]["force_change_password"] is True


def test_admin_cannot_delete_self(admin_client, admin_user):
    res = admin_client.delete(f"/api/admin/users/{admin_user.id}")
    assert res.status_code == 403
    assert res.json()["detail"] == "cannot_modify_self"


def test_admin_cannot_deactivate_self(admin_client, admin_user):
    res = admin_client.post(f"/api/admin/users/{admin_user.id}/deactivate")
    assert res.status_code == 403


def test_admin_cannot_reset_own_password(admin_client, admin_user):
    """Würde den Admin sofort in den Force-Change-View dumpen UND alle
    eigenen Sessions wegwerfen — UX-Falle. Self-Service-Pfad ist dafür da."""
    res = admin_client.post(
        f"/api/admin/users/{admin_user.id}/reset-password",
        json={"new_password": "shiny-new-password-2026"},
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "cannot_modify_self"


def test_admin_cannot_delete_other_admin(app, admin_client, db_session):
    """Symmetrisch zu deactivate: ein zweiter Admin darf nicht per
    DELETE entfernt werden."""
    from app import crud

    other_admin = crud.create_user(
        db_session,
        username=f"second-admin-del-{uuid.uuid4().hex[:8]}",
        password=TEST_PASSWORD,
        is_admin=True,
        force_change_password=False,
    )

    res = admin_client.delete(f"/api/admin/users/{other_admin.id}")
    assert res.status_code == 403
    assert res.json()["detail"] == "cannot_modify_admin"


def test_admin_cannot_deactivate_other_admin(app, admin_client, db_session):
    """Der eine Admin kann keine anderen Admins deaktivieren — Schutz
    gegen versehentliches Aussperren des einzigen Admin-Accounts. (Im
    Plan: genau ein Admin, kein Role-Wechsel; dieser Test sichert die
    Regel auch gegen direkt manipulierte DB-Stände ab.)"""
    from app import crud

    # Zweiter Admin manuell in die DB (außerhalb des API-Pfads, da das
    # /api/admin/users-POST per Konvention immer non-admin anlegt).
    other_admin = crud.create_user(
        db_session,
        username=f"second-admin-{uuid.uuid4().hex[:8]}",
        password=TEST_PASSWORD,
        is_admin=True,
        force_change_password=False,
    )

    res = admin_client.post(f"/api/admin/users/{other_admin.id}/deactivate")
    assert res.status_code == 403
    assert res.json()["detail"] == "cannot_modify_admin"


def test_admin_deactivate_then_activate_restores_login(
    app, admin_client, regular_user
):
    # Deaktivieren
    res = admin_client.post(f"/api/admin/users/{regular_user.id}/deactivate")
    assert res.status_code == 204

    fresh = TestClient(app)
    res = fresh.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 401

    # Reaktivieren
    res = admin_client.post(f"/api/admin/users/{regular_user.id}/activate")
    assert res.status_code == 204

    fresh = TestClient(app)
    res = fresh.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200


def test_admin_delete_user_cascades_data(
    admin_client, regular_user, db_session
):
    """Löschen des Users cascadet auf seine Kategorien/Buchungen/Sessions
    (FK ON DELETE CASCADE) — die Row im users-table ist weg, und mindestens
    eine Child-Row, die vorher existiert hat, ist es auch."""
    from app import auth, crud, models
    from sqlalchemy import select

    target_id = regular_user.id
    # Eine Session und mindestens eine Kategorie liegen über
    # ``create_user`` schon an. Wir zählen vor und nach.
    auth.create_session(db_session, regular_user, remember_me=False, user_agent=None)
    db_session.commit()

    categories_before = db_session.scalar(
        select(models.Category).where(models.Category.user_id == target_id).limit(1)
    )
    sessions_before = db_session.scalar(
        select(models.Session).where(models.Session.user_id == target_id).limit(1)
    )
    assert categories_before is not None
    assert sessions_before is not None

    res = admin_client.delete(f"/api/admin/users/{target_id}")
    assert res.status_code == 204

    db_session.expire_all()
    assert crud.get_user_by_id(db_session, target_id) is None
    assert db_session.scalar(
        select(models.Category).where(models.Category.user_id == target_id).limit(1)
    ) is None
    assert db_session.scalar(
        select(models.Session).where(models.Session.user_id == target_id).limit(1)
    ) is None


def test_admin_delete_unknown_user_is_404(admin_client):
    res = admin_client.delete("/api/admin/users/9999999")
    assert res.status_code == 404
