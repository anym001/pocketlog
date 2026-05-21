"""Auth-boundary tests for the X-Authentik-Username header.

The backend trusts SWAG to set this header — but the validation has to
fail closed against malformed values: missing, empty, whitespace-only,
too long, or carrying control / Unicode characters that could make two
distinct header values resolve to the same DB lookup or auto-create a
parallel user row.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


def _client(app, header_value=None):
    """TestClient without the standard auth header, optionally overridden."""
    headers = {} if header_value is None else {"X-Authentik-Username": header_value}
    return TestClient(app, headers=headers)


def test_missing_username_header_is_rejected(app):
    r = _client(app).get("/api/categories")
    assert r.status_code == 401


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
