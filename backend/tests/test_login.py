"""Login-Endpoint: Erfolg, Fehler, Lockout, Cookies, Sliding-Refresh."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def _fresh(app):
    return TestClient(app)


def test_login_success_sets_cookies_and_returns_user(app, regular_user):
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["username"] == regular_user.username
    assert body["user"]["is_admin"] is False
    assert body["user"]["force_change_password"] is False
    csrf = body["user"]["csrf_token"]
    assert len(csrf) == 64

    # Beide Cookies da; Session HttpOnly, CSRF nicht. Der TestClient
    # exponiert nur den Wert, das HttpOnly-Flag ist im Set-Cookie-Header.
    assert "pocketlog_session" in client.cookies
    assert "pocketlog_csrf" in client.cookies

    # Set-Cookie-Header inspizieren auf HttpOnly + SameSite=lax.
    cookies_header = res.headers.get_list("set-cookie")
    session_cookies = [c for c in cookies_header if c.startswith("pocketlog_session=")]
    assert any("HttpOnly" in c for c in session_cookies)
    assert any("samesite=lax" in c.lower() for c in session_cookies)


def test_login_wrong_password_returns_401(app, regular_user):
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": "definitely-wrong-pw"},
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_credentials"


def test_login_unknown_user_returns_401(app):
    """Unbekannter User darf nicht über den Status-Code von „Passwort
    falsch" unterscheidbar sein — beide antworten 401 mit demselben
    Body."""
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": "nobody-by-that-name", "password": "whatever-12345"},
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_credentials"


def test_login_inactive_user_is_rejected(app, db_session, regular_user):
    """Deaktivierte User können sich nicht einloggen."""
    from app import crud

    crud.deactivate_user(db_session, regular_user)

    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 401


def test_login_remember_me_sets_longer_cookie(app, regular_user):
    """remember_me=True liefert eine längere Cookie-Max-Age."""
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={
            "username": regular_user.username,
            "password": TEST_PASSWORD,
            "remember_me": True,
        },
    )
    assert res.status_code == 200

    cookies = res.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookies if c.startswith("pocketlog_session="))
    # Max-Age sollte > 24h sein (≥ 30 Tage default).
    import re

    m = re.search(r"max-age=(\d+)", session_cookie.lower())
    assert m is not None, session_cookie
    assert int(m.group(1)) > 24 * 3600


def test_login_user_with_force_change_password_can_log_in_but_is_blocked(
    app, db_session
):
    """Ein User mit ``force_change_password=true`` darf einloggen, aber
    jeder normale API-Endpoint antwortet mit 403."""
    from app import crud

    user = crud.create_user(
        db_session,
        username="must-change-pw",
        password=TEST_PASSWORD,
        force_change_password=True,
    )

    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["force_change_password"] is True

    # Normaler Endpoint → 403
    res = client.get("/api/categories")
    assert res.status_code == 403
    assert res.json()["detail"] == "password_change_required"


def test_login_lockout_after_five_failures(app, regular_user):
    """Nach 5 Fehlversuchen antwortet das Backend mit 429 + Retry-After.
    Der reguläre User wird zwischen den Tests neu erzeugt, also start
    der Counter bei 0."""
    client = _fresh(app)
    # Vier Versuche – noch kein Lockout
    for _ in range(4):
        res = client.post(
            "/api/auth/login",
            json={"username": regular_user.username, "password": "wrong"},
        )
        assert res.status_code == 401

    # 5. Versuch trippt den Lockout — Antwort ist 429
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": "wrong"},
    )
    assert res.status_code == 429
    assert "Retry-After" in res.headers
    body = res.json()
    assert body["detail"] == "too_many_attempts"
    assert body["retry_after"] >= 1


def test_login_success_clears_lockout_state(app, regular_user, db_session):
    """Erfolgreicher Login resettet failed_login_count + lockout_until."""
    client = _fresh(app)
    # 4 Fehlversuche, dann richtiger Login.
    for _ in range(4):
        client.post(
            "/api/auth/login",
            json={"username": regular_user.username, "password": "nope"},
        )

    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200

    db_session.refresh(regular_user)
    assert regular_user.failed_login_count == 0
    assert regular_user.lockout_until is None


def test_login_with_invalid_payload_returns_422(app):
    client = _fresh(app)
    # Username fehlt
    res = client.post("/api/auth/login", json={"password": "x"})
    assert res.status_code == 422


def test_me_requires_session_cookie(app):
    """``GET /api/auth/me`` ohne Session-Cookie → 401."""
    fresh = TestClient(app)
    res = fresh.get("/api/auth/me")
    assert res.status_code == 401


def test_session_absolute_expiry_kills_session(app, regular_user, db_session):
    """Wenn ``absolute_expires_at`` überschritten ist, ist die Session
    weg — kein Sliding-Refresh kann das verlängern."""
    from app import auth, models

    # Login → Session-Row holen
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200

    session = (
        db_session.scalars(
            models.Session.__table__.select().where(
                models.Session.user_id == regular_user.id
            )
        ).first()
        if False
        else None
    )
    # SQLAlchemy 2.0 API
    from sqlalchemy import select as sa_select

    session = db_session.scalar(
        sa_select(models.Session).where(models.Session.user_id == regular_user.id)
    )
    assert session is not None
    # Absolute Frist auf gerade-eben gesetzt → nächster Request scheitert.
    session.absolute_expires_at = auth._utcnow() - timedelta(seconds=1)
    db_session.commit()

    res = client.get("/api/auth/me")
    assert res.status_code == 401


def test_session_sliding_refresh_extends_expires_at(app, regular_user, db_session):
    """Nach einem authentifizierten Request, der jenseits des
    Refresh-Damper-Fensters liegt, wandert ``expires_at`` nach vorne."""
    from sqlalchemy import select as sa_select

    from app import auth, models

    client = _fresh(app)
    client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    session = db_session.scalar(
        sa_select(models.Session).where(models.Session.user_id == regular_user.id)
    )
    assert session is not None
    original_expires = session.expires_at

    # Schummeln: ``last_seen_at`` weit in die Vergangenheit setzen,
    # damit der Damper greift.
    session.last_seen_at = auth._utcnow() - timedelta(hours=2)
    db_session.commit()

    # GET triggert refresh.
    client.get("/api/auth/me")

    db_session.refresh(session)
    assert session.expires_at > original_expires
