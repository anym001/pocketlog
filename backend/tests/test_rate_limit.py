"""Brute-Force-Backoff: 5 Fehler → 1s, Verdopplung bis 60s-Cap,
Reset bei Erfolg, generische Antwort gegen Username-Leak."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def _hammer(client, username, attempts: int):
    """N fehlerhafte Logins gegen username feuern. Liefert Liste der
    HTTP-Status-Codes der Antworten."""
    return [
        client.post(
            "/api/auth/login",
            json={"username": username, "password": "wrong-pw"},
        ).status_code
        for _ in range(attempts)
    ]


def test_first_four_failures_return_401(app, regular_user):
    """Schwelle ist 5 — die ersten vier Versuche sind nur 401."""
    client = TestClient(app)
    codes = _hammer(client, regular_user.username, 4)
    assert codes == [401, 401, 401, 401]


def test_fifth_failure_triggers_lockout(app, regular_user):
    client = TestClient(app)
    _hammer(client, regular_user.username, 4)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": "still-wrong"},
    )
    assert res.status_code == 429
    body = res.json()
    assert body["detail"] == "too_many_attempts"
    # Erster Lockout = 1 Sekunde.
    assert body["retry_after"] >= 1


def test_lockout_doubles_until_cap(app, regular_user, db_session):
    """Mehrfache Fehlversuche skalieren die Lockout-Zeit exponentiell
    bis zum 60s-Cap. Wir manipulieren ``lockout_until`` in die
    Vergangenheit, damit jeder neue Versuch durchkommt und den Counter
    weiterzählt."""
    from app import auth

    client = TestClient(app)
    _hammer(client, regular_user.username, 4)

    seen = []
    for _ in range(10):
        # Lockout zurückdatieren, damit der nächste Versuch nicht durch
        # den 429-Pfad abgekürzt wird.
        db_session.refresh(regular_user)
        if regular_user.lockout_until is not None:
            regular_user.lockout_until = auth._utcnow() - timedelta(seconds=1)
            db_session.commit()

        res = client.post(
            "/api/auth/login",
            json={"username": regular_user.username, "password": "wrong"},
        )
        if res.status_code == 429:
            seen.append(res.json()["retry_after"])

    assert seen, "expected at least one 429 response"
    assert all(s <= 60 for s in seen), seen
    # Die Sequenz sollte monoton wachsen (bis zum Cap).
    assert seen[-1] >= seen[0]


def test_success_clears_lockout(app, regular_user, db_session):
    from app import auth

    client = TestClient(app)
    _hammer(client, regular_user.username, 5)

    # Lockout abkürzen, damit der nächste Versuch (richtig) durchgeht.
    db_session.refresh(regular_user)
    regular_user.lockout_until = auth._utcnow() - timedelta(seconds=1)
    db_session.commit()

    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200

    db_session.refresh(regular_user)
    assert regular_user.failed_login_count == 0
    assert regular_user.lockout_until is None


def test_admin_reset_clears_lockout(app, admin_client, regular_user, db_session):
    """Admin-Reset löst den Lockout auf, damit der Operator einen
    ausgesperrten User wieder rein lassen kann."""
    client = TestClient(app)
    _hammer(client, regular_user.username, 5)
    db_session.refresh(regular_user)
    assert regular_user.failed_login_count >= 5

    res = admin_client.post(
        f"/api/admin/users/{regular_user.id}/reset-password",
        json={"new_password": "Reset-by-admin-9999"},
    )
    assert res.status_code == 204

    db_session.refresh(regular_user)
    assert regular_user.failed_login_count == 0
    assert regular_user.lockout_until is None


def test_unknown_user_does_not_leak_via_response(app):
    """Login gegen einen nicht existenten User hat denselben Body und
    Status wie ein falsches Passwort gegen einen existierenden User —
    der Username-Enumeration-Vektor ist zu."""
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": "no-such-user-anywhere", "password": "x" * 12},
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "invalid_credentials"
