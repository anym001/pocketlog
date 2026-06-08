"""Logout-Endpoint: löscht Session, clear-t Cookies, CSRF-Pflicht."""
from __future__ import annotations

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def test_logout_removes_session_and_clears_cookies(app, regular_user, db_session):
    from sqlalchemy import select as sa_select

    from app import models

    client = TestClient(app)
    login = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    csrf = login.json()["user"]["csrf_token"]

    session_row = db_session.scalar(
        sa_select(models.Session).where(
            models.Session.user_id == regular_user.id
        )
    )
    assert session_row is not None

    res = client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
    assert res.status_code == 204

    # Session-Row in der DB ist weg.
    db_session.expire_all()
    after = db_session.scalar(
        sa_select(models.Session).where(
            models.Session.user_id == regular_user.id
        )
    )
    assert after is None

    # Follow-up gegen /me → 401.
    me = client.get("/api/auth/me")
    assert me.status_code == 401


def test_logout_without_csrf_is_rejected(app, regular_user):
    client = TestClient(app)
    client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )

    # Kein X-CSRF-Token gesetzt → 403.
    res = client.post("/api/auth/logout")
    assert res.status_code == 403
    assert res.json()["detail"] == "csrf_mismatch"


def test_logout_is_idempotent_without_session(app):
    """Logout ohne Session liefert 204 — Frontend ruft logout in einem
    Race-Fall (z. B. parallel auf zwei Tabs) doppelt auf."""
    client = TestClient(app)
    res = client.post("/api/auth/logout")
    assert res.status_code == 204
