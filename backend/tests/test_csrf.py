"""CSRF-Schutz: Header-Pflicht für non-GET, falscher Token blockt,
Token-Rotation bei Login."""
from __future__ import annotations

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def _logged_in(app, user):
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200
    return client, res.json()["user"]["csrf_token"]


def test_post_without_csrf_header_returns_403(app, regular_user):
    client, _csrf = _logged_in(app, regular_user)
    res = client.post(
        "/api/categories",
        json={"name": "NoCSRF", "icon": "house", "color": "#123456"},
    )
    assert res.status_code == 403
    assert res.json()["detail"] == "csrf_mismatch"


def test_post_with_wrong_csrf_header_returns_403(app, regular_user):
    client, _csrf = _logged_in(app, regular_user)
    res = client.post(
        "/api/categories",
        headers={"X-CSRF-Token": "x" * 64},
        json={"name": "WrongCSRF", "icon": "house", "color": "#123456"},
    )
    assert res.status_code == 403


def test_post_with_correct_csrf_succeeds(app, regular_user):
    client, csrf = _logged_in(app, regular_user)
    res = client.post(
        "/api/categories",
        headers={"X-CSRF-Token": csrf},
        json={"name": "OkCSRF", "icon": "house", "color": "#123456"},
    )
    assert res.status_code == 201


def test_get_does_not_require_csrf(app, regular_user):
    """GET ist idempotent — kein CSRF-Header erforderlich."""
    client, _csrf = _logged_in(app, regular_user)
    res = client.get("/api/categories")
    assert res.status_code == 200


def test_delete_requires_csrf(app, regular_user):
    """Auch DELETE muss CSRF-Token mitbringen."""
    client, csrf = _logged_in(app, regular_user)
    cats = client.get("/api/categories").json()
    cat_id = cats[0]["id"]
    # Ohne Header.
    res = client.delete(f"/api/categories/{cat_id}")
    assert res.status_code == 403
    # Mit Header geht's.
    res = client.delete(
        f"/api/categories/{cat_id}", headers={"X-CSRF-Token": csrf}
    )
    assert res.status_code in (204, 409)


def test_csrf_token_rotates_per_session(app, regular_user):
    """Jeder Login erzeugt eine neue Session mit einem frischen
    CSRF-Token. Eine zweite Anmeldung erzeugt einen anderen Token als
    die erste."""
    a = TestClient(app)
    a_csrf = a.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    ).json()["user"]["csrf_token"]

    b = TestClient(app)
    b_csrf = b.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    ).json()["user"]["csrf_token"]

    assert a_csrf != b_csrf


def test_csrf_cookie_value_matches_returned_token(app, regular_user):
    """``pocketlog_csrf``-Cookie und der ``csrf_token`` aus der
    Login-Response sind identisch — Frontend kann den Token aus dem
    Cookie auch ohne Reload weiterverwenden."""
    client, csrf = _logged_in(app, regular_user)
    assert client.cookies.get("pocketlog_csrf") == csrf
