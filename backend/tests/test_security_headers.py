"""Security-header middleware: the CSP must stay strict. script-src 'self'
(without 'unsafe-inline') is the main XSS mitigation of the header — the
whole frontend was refactored to declarative data-action attributes to make
that possible, and a regression here would silently re-open inline-script
execution."""

from __future__ import annotations

from fastapi.testclient import TestClient


def _csp_directives(response) -> dict[str, str]:
    csp = response.headers.get("content-security-policy", "")
    assert csp, "CSP header missing"
    out = {}
    for part in csp.split(";"):
        part = part.strip()
        if not part:
            continue
        name, _, value = part.partition(" ")
        out[name] = value.strip()
    return out


def test_csp_script_src_is_self_only(app):
    client = TestClient(app)
    res = client.get("/api/health")
    d = _csp_directives(res)
    assert d["script-src"] == "'self'"
    assert "unsafe-inline" not in d["script-src"]
    assert d["default-src"] == "'self'"
    assert d["frame-ancestors"] == "'none'"
    assert d["object-src"] == "'none'"
    assert d["base-uri"] == "'none'"


def test_auth_endpoints_are_no_store(app):
    client = TestClient(app)
    res = client.get("/api/auth/setup-status")
    assert res.headers.get("cache-control") == "no-store"


def test_shell_paths_revalidate(app):
    client = TestClient(app)
    # No static mount in the test env (404), but the middleware header
    # policy applies to every response on the path.
    res = client.get("/theme-boot.js")
    assert res.headers.get("cache-control") == "no-cache, must-revalidate"
