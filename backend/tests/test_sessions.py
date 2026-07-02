"""Session self-service ("signed-in devices"): list with current marker,
single revoke (own/foreign/current), revoke-others, and the session-only
guarantee — an API key must never reach these routes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD, _login_client


def _login(app, user, ua):
    """Login with a distinct User-Agent so the sessions are tellable apart."""
    client = TestClient(app, headers={"user-agent": ua})
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200, res.text
    client.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]
    return client


def test_list_marks_current_and_orders_by_activity(app, regular_user):
    phone = _login(app, regular_user, "PocketLog-Phone")
    laptop = _login(app, regular_user, "PocketLog-Laptop")

    sessions = laptop.get("/api/auth/sessions").json()
    assert len(sessions) == 2
    current = [s for s in sessions if s["current"]]
    assert len(current) == 1
    assert current[0]["user_agent"] == "PocketLog-Laptop"
    assert {s["user_agent"] for s in sessions} == {
        "PocketLog-Phone",
        "PocketLog-Laptop",
    }
    for s in sessions:
        assert s["created_at"] and s["last_seen_at"]
        assert isinstance(s["remember_me"], bool)

    # The other device sees the same rows, with the marker flipped.
    other_view = phone.get("/api/auth/sessions").json()
    assert [s for s in other_view if s["current"]][0]["user_agent"] == (
        "PocketLog-Phone"
    )


def test_revoke_other_session_logs_that_device_out(app, regular_user):
    phone = _login(app, regular_user, "PocketLog-Phone")
    laptop = _login(app, regular_user, "PocketLog-Laptop")

    phone_id = next(
        s["id"] for s in laptop.get("/api/auth/sessions").json() if not s["current"]
    )
    res = laptop.delete(f"/api/auth/sessions/{phone_id}")
    assert res.status_code == 204

    assert phone.get("/api/auth/me").status_code == 401
    assert laptop.get("/api/auth/me").status_code == 200


def test_revoke_current_session_acts_as_logout(app, regular_user):
    client = _login(app, regular_user, "PocketLog-Solo")
    current_id = next(
        s["id"] for s in client.get("/api/auth/sessions").json() if s["current"]
    )
    res = client.delete(f"/api/auth/sessions/{current_id}")
    assert res.status_code == 204
    # The dead token must not linger in the browser: the response carries
    # cookie-clearing Set-Cookie headers.
    assert res.headers.get_list("set-cookie")
    assert client.get("/api/auth/me").status_code == 401


def test_foreign_session_id_is_a_plain_404(app, regular_user, db_session):
    import uuid

    from app import crud

    client = _login(app, regular_user, "PocketLog-Attacker")

    victim = crud.create_user(
        db_session,
        username=f"victim-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    victim_client = _login_client(app, victim)
    victim_id = victim_client.get("/api/auth/sessions").json()[0]["id"]

    res = client.delete(f"/api/auth/sessions/{victim_id}")
    assert res.status_code == 404
    # Victim's session is untouched.
    assert victim_client.get("/api/auth/me").status_code == 200


def test_revoke_others_keeps_only_current(app, regular_user):
    old1 = _login(app, regular_user, "PocketLog-Old1")
    old2 = _login(app, regular_user, "PocketLog-Old2")
    keeper = _login(app, regular_user, "PocketLog-Keeper")

    res = keeper.delete("/api/auth/sessions")
    assert res.status_code == 200
    assert res.json()["revoked"] == 2

    assert old1.get("/api/auth/me").status_code == 401
    assert old2.get("/api/auth/me").status_code == 401
    sessions = keeper.get("/api/auth/sessions").json()
    assert len(sessions) == 1 and sessions[0]["current"]


def test_sessions_are_never_bearer_reachable(app, authed_client):
    """Even a write-scoped key must not enumerate or kill browser sessions."""
    r = authed_client.post(
        "/api/api-keys", json={"name": "sess-probe", "scopes": ["write"]}
    )
    raw_key = r.json()["key"]
    bearer = TestClient(app, headers={"Authorization": f"Bearer {raw_key}"})

    assert bearer.get("/api/auth/sessions").status_code == 401
    assert bearer.delete("/api/auth/sessions").status_code == 401
    assert bearer.delete("/api/auth/sessions/1").status_code == 401


def test_revoke_requires_csrf(app, regular_user):
    client = _login(app, regular_user, "PocketLog-NoCsrf")
    del client.headers["X-CSRF-Token"]
    res = client.delete("/api/auth/sessions")
    assert res.status_code == 403
    assert res.json()["detail"] == "csrf_mismatch"
