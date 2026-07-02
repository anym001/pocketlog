"""Per-IP login throttle: complements the per-user lockout — failures
spread across many usernames burn one shared IP budget, blocked IPs get
429 before any user lookup, the window decays, and setup shares the pool."""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import rate_limit

from .conftest import TEST_PASSWORD


@pytest.fixture
def low_threshold(monkeypatch):
    """Shrink the budget so tests don't need 20 requests per case."""
    monkeypatch.setattr(rate_limit, "IP_LOCKOUT_THRESHOLD", 3)
    monkeypatch.setattr(rate_limit, "IP_LOCKOUT_MAX_SECONDS", 60)


def _fail_login(client, username="ghost-user"):
    return client.post(
        "/api/auth/login",
        json={"username": username, "password": "Wrong-password-1"},
    )


def test_failures_across_usernames_share_one_ip_budget(app, low_threshold):
    """Distributing guesses over many (non-existent) usernames doesn't
    dodge the throttle — exactly what the per-user lockout can't catch."""
    client = TestClient(app)
    codes = [_fail_login(client, f"ghost-{i}").status_code for i in range(3)]
    assert codes == [401, 401, 401]

    res = _fail_login(client, "ghost-next")
    assert res.status_code == 429
    body = res.json()
    assert body["detail"] == "too_many_attempts"
    assert body["retry_after"] >= 1
    assert res.headers.get("Retry-After")


def test_blocked_ip_cannot_login_even_with_valid_credentials(
    app, low_threshold, regular_user
):
    """The 429 fires before the user lookup, so a blocked source can't
    keep hammering a known account either (lockout-DoS costs the IP)."""
    client = TestClient(app)
    for i in range(4):
        _fail_login(client, f"ghost-{i}")

    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 429


def test_window_decay_clears_the_budget(app, low_threshold):
    client = TestClient(app)
    for i in range(2):
        _fail_login(client, f"ghost-{i}")

    # Age the recorded failures past the window: the next failure starts a
    # fresh count instead of tripping the threshold.
    with rate_limit._lock:
        for state in rate_limit._states.values():
            state.last_failure_at -= timedelta(
                seconds=rate_limit.IP_FAILURE_WINDOW_SECONDS + 1
            )
    res = _fail_login(client, "ghost-later")
    assert res.status_code == 401


def test_setup_attempts_burn_the_same_budget(app, low_threshold, regular_user):
    """POST /api/auth/setup on an initialised install counts as a failure
    and eventually 429s instead of enumerating forever."""
    client = TestClient(app)
    codes = [
        client.post(
            "/api/auth/setup",
            json={"username": f"probe-{i}", "password": "Probe-password-99!"},
        ).status_code
        for i in range(4)
    ]
    assert codes[:3] == [409, 409, 409]
    assert codes[3] == 429


def test_successful_logins_unaffected_without_failures(app, regular_user):
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200


def test_limiter_ip_prefers_rightmost_forwarded_entry():
    """The throttle key must come from the trusted proxy's own appended
    entry — the first XFF value is client-seedable."""

    class _Req:
        class client:
            host = "127.0.0.1"  # trusted (loopback default)

        headers = {"x-forwarded-for": "6.6.6.6, 203.0.113.7"}

    assert rate_limit.limiter_ip(_Req()) == "203.0.113.7"

    class _ReqUntrusted:
        class client:
            host = "198.51.100.9"  # public peer — not a trusted proxy

        headers = {"x-forwarded-for": "6.6.6.6"}

    assert rate_limit.limiter_ip(_ReqUntrusted()) == "198.51.100.9"
