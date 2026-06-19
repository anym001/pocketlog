"""Trusted-proxy resolution (app.proxies) and the Secure-cookie decision it
gates (deps._cookie_secure).

Covers change A (private ranges trusted by default) and change B (the auto
Secure flag honours X-Forwarded-Proto only from a trusted proxy, so a direct
client can't forge it).
"""

from __future__ import annotations

import pytest
from starlette.requests import Request

from app import deps, proxies


def _set_networks(monkeypatch, env: str) -> None:
    """Reparse TRUSTED_PROXIES from *env* and install the result."""
    monkeypatch.setattr(proxies, "_TRUSTED_NETWORKS", proxies._parse(env))


def _make_request(
    *, headers: dict | None = None, client=("203.0.113.7", 5000), scheme="http"
) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": raw,
        "client": client,
        "scheme": scheme,
        "server": ("testserver", 80),
    }
    return Request(scope)


# --------------------------------------------------------------------------
# is_trusted_peer / _parse
# --------------------------------------------------------------------------


def test_default_trusts_private_ranges(monkeypatch):
    _set_networks(monkeypatch, "")
    assert proxies.is_trusted_peer("10.0.0.5")
    assert proxies.is_trusted_peer("172.17.0.1")  # Docker bridge
    assert proxies.is_trusted_peer("192.168.1.50")
    assert proxies.is_trusted_peer("127.0.0.1")
    assert proxies.is_trusted_peer("::1")


def test_default_does_not_trust_public_ip(monkeypatch):
    _set_networks(monkeypatch, "")
    assert not proxies.is_trusted_peer("8.8.8.8")
    assert not proxies.is_trusted_peer("203.0.113.7")


def test_wildcard_trusts_everything(monkeypatch):
    _set_networks(monkeypatch, "*")
    assert proxies.is_trusted_peer("8.8.8.8")
    assert proxies.is_trusted_peer("10.0.0.1")


def test_explicit_list_replaces_defaults(monkeypatch):
    _set_networks(monkeypatch, "172.20.0.0/16")
    assert proxies.is_trusted_peer("172.20.5.5")
    # A private range NOT in the explicit list is no longer trusted.
    assert not proxies.is_trusted_peer("10.0.0.5")


def test_invalid_entry_is_ignored(monkeypatch):
    _set_networks(monkeypatch, "not-an-ip, 192.168.0.0/16")
    assert proxies.is_trusted_peer("192.168.0.9")
    assert not proxies.is_trusted_peer("8.8.8.8")


def test_missing_or_garbage_peer_never_trusted(monkeypatch):
    _set_networks(monkeypatch, "")
    assert not proxies.is_trusted_peer(None)
    assert not proxies.is_trusted_peer("")
    assert not proxies.is_trusted_peer("testclient")


# --------------------------------------------------------------------------
# _cookie_secure (SESSION_COOKIE_SECURE=auto)
# --------------------------------------------------------------------------


@pytest.fixture
def auto_mode(monkeypatch):
    """Force auto mode; the test env pins SESSION_COOKIE_SECURE=0 otherwise."""
    monkeypatch.setattr(deps, "_COOKIE_SECURE_ENV", "auto")


def test_auto_trusted_proxy_https(monkeypatch, auto_mode):
    _set_networks(monkeypatch, "")
    req = _make_request(
        headers={"x-forwarded-proto": "https"}, client=("172.17.0.1", 9000)
    )
    assert deps._cookie_secure(req) is True


def test_auto_trusted_proxy_http(monkeypatch, auto_mode):
    _set_networks(monkeypatch, "")
    req = _make_request(
        headers={"x-forwarded-proto": "http"}, client=("172.17.0.1", 9000)
    )
    assert deps._cookie_secure(req) is False


def test_auto_untrusted_peer_cannot_forge_https(monkeypatch, auto_mode):
    """A direct (untrusted) client sending X-Forwarded-Proto: https must NOT
    flip the Secure flag — we fall back to the raw HTTP request scheme."""
    _set_networks(monkeypatch, "")
    req = _make_request(
        headers={"x-forwarded-proto": "https"},
        client=("203.0.113.7", 5000),
        scheme="http",
    )
    assert deps._cookie_secure(req) is False


def test_auto_direct_https_without_header(monkeypatch, auto_mode):
    _set_networks(monkeypatch, "")
    req = _make_request(client=("203.0.113.7", 5000), scheme="https")
    assert deps._cookie_secure(req) is True


def test_explicit_override_ignores_peer(monkeypatch):
    req = _make_request(
        headers={"x-forwarded-proto": "http"}, client=("203.0.113.7", 5000)
    )
    monkeypatch.setattr(deps, "_COOKIE_SECURE_ENV", "1")
    assert deps._cookie_secure(req) is True
    monkeypatch.setattr(deps, "_COOKIE_SECURE_ENV", "0")
    assert deps._cookie_secure(req) is False
