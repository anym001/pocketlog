"""Auth-boundary tests for the SWAG → backend handoff.

Two headers gate every authenticated request:
- X-Auth-Secret: shared secret between SWAG and the backend. Set on
  module import in conftest.py, must match `hmac.compare_digest`.
- X-Authentik-Username: forwarded by SWAG after Authentik validates
  the session. Has to pass the allowlist regex in app.main.

The tests below cover the rejection paths of both headers end-to-end
through the TestClient. Non-ASCII cases that the HTTP stack itself
filters get a unit test against the regex.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

AUTH_SECRET = os.environ["AUTH_SECRET"]


def _client(app, username=None, secret=AUTH_SECRET):
    """TestClient with selectively-set auth headers. Pass `secret=None`
    to omit X-Auth-Secret entirely; the same goes for `username`."""
    headers: dict[str, str] = {}
    if username is not None:
        headers["X-Authentik-Username"] = username
    if secret is not None:
        headers["X-Auth-Secret"] = secret
    return TestClient(app, headers=headers)


def test_missing_username_header_is_rejected(app):
    r = _client(app).get("/api/categories")
    assert r.status_code == 401


def test_missing_auth_secret_is_rejected(app):
    r = _client(app, username="alice", secret=None).get("/api/categories")
    assert r.status_code == 401


def test_wrong_auth_secret_is_rejected(app):
    r = _client(app, username="alice", secret="not-the-real-secret").get(
        "/api/categories"
    )
    assert r.status_code == 401


def test_unauthorized_detail_is_generic(app):
    """Both rejection paths return the same generic detail — a direct
    probe must not learn which header was wrong (would reveal how far
    the request got past the SWAG/Authentik boundary)."""
    wrong_secret = _client(app, username="alice", secret="wrong").get("/api/categories")
    bad_username = _client(app, username="x" * 200, secret=AUTH_SECRET).get(
        "/api/categories"
    )
    assert wrong_secret.status_code == 401
    assert bad_username.status_code == 401
    assert wrong_secret.json().get("detail") == "unauthorized"
    assert bad_username.json().get("detail") == "unauthorized"


@pytest.mark.parametrize(
    "value",
    [
        "",                           # explicitly empty
        " ",                          # whitespace-only
        "   \t  ",                    # tabs and spaces only
        "alice bob",                  # internal whitespace
        "alice\nbob",                 # newline
        "alice\x00bob",               # NUL byte
        "alice/../etc",               # path separator
        "alice\\bob",                 # backslash
        "<script>",                   # HTML control chars
        "a" * 151,                    # one over the VARCHAR(150) limit
    ],
)
def test_malformed_username_is_rejected(app, value):
    r = _client(app, value).get("/api/categories")
    assert r.status_code == 401, f"expected 401 for {value!r}, got {r.status_code}"


@pytest.mark.parametrize(
    "value",
    [
        "alice‍bob",             # zero-width joiner (U+200D)
        "alice‮bob",             # right-to-left override (U+202E)
        "🦊",                          # emoji
        "älice",                       # latin-1 supplement
    ],
)
def test_non_ascii_username_is_rejected_by_regex(value):
    """The HTTP stack (nginx → uvicorn) rejects non-ASCII header bytes
    before they reach the app, so we can't drive these cases through the
    TestClient (httpx enforces ASCII). The regex still has to fail closed
    in case some future stack does pass them through."""
    from app.main import USERNAME_RE

    assert not USERNAME_RE.match(value)


@pytest.mark.parametrize(
    "value",
    [
        "alice",
        "alice.smith",
        "alice_smith",
        "alice-smith",
        "alice+tag@example.com",
        "USER123",
        "a" * 150,                    # exactly at the VARCHAR(150) limit
    ],
)
def test_valid_username_is_accepted(app, value):
    r = _client(app, value).get("/api/categories")
    assert r.status_code == 200, f"expected 200 for {value!r}, got {r.status_code} {r.text}"


def test_username_is_stripped_before_lookup(app):
    """A header with stray whitespace must resolve to the same user as the
    trimmed value — otherwise an Authentik misconfiguration silently
    creates a doppelganger account."""
    base = "stripper-test"
    # Establish the account with the clean value first.
    r1 = _client(app, base).post(
        "/api/categories",
        json={"name": "Marker", "icon": "house", "color": "#123456"},
    )
    assert r1.status_code == 201, r1.text

    # The padded variant must see the same Marker category.
    r2 = _client(app, f"  {base}  ").get("/api/categories")
    assert r2.status_code == 200
    assert any(c["name"] == "Marker" for c in r2.json())


def test_startup_without_auth_secret_refuses(tmp_path):
    """Importing app.main with AUTH_SECRET empty must raise SystemExit
    unless ALLOW_NO_AUTH_SECRET=1 is set. Run in a subprocess so the
    SystemExit doesn't take down the pytest session."""
    import subprocess
    import sys

    env = {
        **os.environ,
        "AUTH_SECRET": "",
        "DATABASE_URL": f"sqlite:///{tmp_path}/probe.db",
    }
    env.pop("ALLOW_NO_AUTH_SECRET", None)

    proc = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0
    assert "AUTH_SECRET is not set" in proc.stderr


def test_startup_without_auth_secret_with_opt_out_succeeds(tmp_path):
    """The escape hatch for local dev: ALLOW_NO_AUTH_SECRET=1 lets the
    app boot without a secret, with a loud warning."""
    import subprocess
    import sys

    env = {
        **os.environ,
        "AUTH_SECRET": "",
        "ALLOW_NO_AUTH_SECRET": "1",
        "DATABASE_URL": f"sqlite:///{tmp_path}/probe.db",
    }

    proc = subprocess.run(
        [sys.executable, "-c", "import app.main"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr


def test_docs_disabled_by_default(client):
    """Swagger UI and the OpenAPI schema leak the full API surface and
    Swagger's "Try it out" issues real backend requests, so both are off
    unless ENABLE_DOCS=1 is set explicitly."""
    assert client.get("/api/docs").status_code == 404
    assert client.get("/api/openapi.json").status_code == 404


def test_docs_enabled_with_opt_in(tmp_path):
    """ENABLE_DOCS=1 mounts both endpoints again — verified by importing
    the module in a subprocess so the current pytest process's already-
    loaded `app` instance isn't disturbed."""
    import subprocess
    import sys

    env = {
        **os.environ,
        "ENABLE_DOCS": "1",
        "DATABASE_URL": f"sqlite:///{tmp_path}/probe.db",
    }
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            "import app.main; print(app.main.app.docs_url); print(app.main.app.openapi_url)",
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip().splitlines() == ["/api/docs", "/api/openapi.json"]
