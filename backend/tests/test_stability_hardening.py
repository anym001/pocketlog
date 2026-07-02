"""Regression guards for the stability-analysis follow-up fixes.

- Session cleanup: ``cleanup_expired_sessions`` existed but was never called
  anywhere, so the ``sessions`` table only ever shrank when the exact
  expired row happened to be looked up again. ``maybe_cleanup_expired_sessions``
  now runs opportunistically (wired into ``GET /api/auth/me``), damped so it's
  at most one DELETE per process per interval, not per request.
- Health check: ``GET /api/health`` used to answer 200 unconditionally, even
  with a dead database, so an orchestrator's HEALTHCHECK could never detect
  that failure mode.
- Unhandled exceptions: previously only ``DomainError`` had a registered
  handler; anything else 500'd without a matching line in the pocketlog.*
  log namespace.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app import auth, models


def test_maybe_cleanup_expired_sessions_is_damped(db_session, regular_user):
    auth._last_session_cleanup_at = None  # isolate from other tests/requests

    now = datetime.now(UTC)
    expired = models.Session(
        user_id=regular_user.id,
        token_hash="a" * 64,
        csrf_token="b" * 64,
        created_at=now - timedelta(days=2),
        last_seen_at=now - timedelta(days=2),
        expires_at=now - timedelta(days=1),
        absolute_expires_at=now - timedelta(days=1),
        remember_me=False,
    )
    db_session.add(expired)
    db_session.commit()
    expired_id = expired.id  # grab before commit() below expires the instance

    removed = auth.maybe_cleanup_expired_sessions(db_session)
    assert removed == 1
    assert db_session.get(models.Session, expired_id) is None

    # A second expired row shows up right after — the damper must skip it
    # until SESSION_CLEANUP_INTERVAL_SECONDS has passed.
    expired2 = models.Session(
        user_id=regular_user.id,
        token_hash="c" * 64,
        csrf_token="d" * 64,
        created_at=now - timedelta(days=2),
        last_seen_at=now - timedelta(days=2),
        expires_at=now - timedelta(days=1),
        absolute_expires_at=now - timedelta(days=1),
        remember_me=False,
    )
    db_session.add(expired2)
    db_session.commit()
    expired2_id = expired2.id

    assert auth.maybe_cleanup_expired_sessions(db_session) == 0
    assert db_session.get(models.Session, expired2_id) is not None

    auth._last_session_cleanup_at = None  # don't leak state to later tests


def test_auth_me_triggers_session_cleanup(authed_client, db_session, regular_user):
    auth._last_session_cleanup_at = None

    now = datetime.now(UTC)
    stale = models.Session(
        user_id=regular_user.id,
        token_hash="e" * 64,
        csrf_token="f" * 64,
        created_at=now - timedelta(days=30),
        last_seen_at=now - timedelta(days=30),
        expires_at=now - timedelta(days=29),
        absolute_expires_at=now - timedelta(days=29),
        remember_me=False,
    )
    db_session.add(stale)
    db_session.commit()
    stale_id = stale.id

    r = authed_client.get("/api/auth/me")
    assert r.status_code == 200

    # The DELETE happened on a different SQLAlchemy Session (the request's
    # own, via get_db) — refresh this one's identity map before checking.
    db_session.expire_all()
    assert db_session.get(models.Session, stale_id) is None
    auth._last_session_cleanup_at = None


def test_health_endpoint_reports_ok_when_db_is_up(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_health_endpoint_reports_503_when_db_is_unreachable(app, client):
    from app.deps import DB

    def _broken_db():
        class _Broken:
            def execute(self, *a, **kw):
                from sqlalchemy.exc import OperationalError

                raise OperationalError("SELECT 1", {}, Exception("db down"))

        yield _Broken()

    app.dependency_overrides[DB.__metadata__[0].dependency] = _broken_db
    try:
        r = client.get("/api/health")
        assert r.status_code == 503
        assert r.json() == {"status": "error", "database": "unreachable"}
    finally:
        app.dependency_overrides.clear()


def test_unhandled_exception_returns_generic_500(app):
    from fastapi.testclient import TestClient

    @app.get("/api/__test_boom")
    def _boom():
        raise ValueError("kaboom")

    try:
        # Starlette's ServerErrorMiddleware re-raises the original exception
        # after dispatching it to our handler (so dev tools/tracebacks stay
        # visible) — TestClient's default raise_server_exceptions=True would
        # surface that as a test failure even though the client actually
        # receives our JSON 500. Disable it here to assert on the response.
        no_raise_client = TestClient(app, raise_server_exceptions=False)
        r = no_raise_client.get("/api/__test_boom")
        assert r.status_code == 500
        assert r.json() == {"detail": "internal_error"}
        assert "kaboom" not in r.text
    finally:
        app.router.routes = [
            route
            for route in app.router.routes
            if getattr(route, "path", None) != "/api/__test_boom"
        ]
