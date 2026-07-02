"""Shared fixtures for the test suite.

The whole suite runs against a file-backed SQLite database. The database
URL is set before any ``app.*`` module is imported, so the engine in
``app.database`` resolves to SQLite. ``SESSION_COOKIE_SECURE=0`` is set
so test cookies survive the HTTP TestClient (which doesn't speak TLS).
"""

import os
import uuid
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_DB_PATH = BACKEND_DIR / "test-pocketlog.db"
TEST_PASSWORD = "Test-password-1234"

# Must run before any `from app...` import elsewhere.
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
# Without this, the Secure cookie flag would prevent the httpx TestClient
# (HTTP-only) from echoing the cookie back on subsequent requests.
os.environ.setdefault("SESSION_COOKIE_SECURE", "0")
# Required keys the production builder reads — ignored on the SQLite path
# but ``app.database._build_url`` is only consulted when ``DATABASE_URL``
# is empty, so technically these aren't needed. We set them anyway to keep
# the test environment robust if someone clears DATABASE_URL accidentally.
os.environ.setdefault("DB_USER", "test")
os.environ.setdefault("DB_PASSWORD", "test")
os.environ.setdefault("DB_NAME", "test")


@pytest.fixture(scope="session", autouse=True)
def _prepare_database():
    """Wipe any stale test DB and run migrations once per session."""
    if TEST_DB_PATH.exists():
        TEST_DB_PATH.unlink()

    from alembic import command
    from alembic.config import Config

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    command.upgrade(cfg, "head")

    yield

    if TEST_DB_PATH.exists():
        TEST_DB_PATH.unlink()


@pytest.fixture(scope="session")
def app(_prepare_database):
    """Import the FastAPI app once the DB is ready."""
    from app.main import app as _app

    return _app


@pytest.fixture
def db_session(app):
    """Open SQLAlchemy session for direct CRUD calls in fixtures.

    Used to set up users without going through the public API (which
    is itself under test). Each test gets its own session so commits
    inside the test become visible to the TestClient request via the
    shared SQLite file.
    """
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _reset_ip_rate_limit():
    """The per-IP login throttle keeps process-global state, and every
    TestClient request comes from the same synthetic peer ("testclient") —
    without a reset, failed-login tests would bleed 429s into each other."""
    from app import rate_limit

    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture
def username():
    """Unique username per test — guarantees data isolation without
    truncating tables between tests, since every CRUD query in the
    backend is filtered by ``user_id``."""
    return f"test-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def regular_user(db_session, username):
    """Pre-created non-admin user with a known password."""
    from app import crud

    return crud.create_user(
        db_session,
        username=username,
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )


@pytest.fixture
def admin_user(db_session):
    """Pre-created admin user. Idempotent at the test-DB level — at
    most one admin exists in the bootstrap state, and this fixture
    promotes the first run to that role.
    """
    from app import crud

    name = f"admin-{uuid.uuid4().hex[:12]}"
    return crud.create_user(
        db_session,
        username=name,
        password=TEST_PASSWORD,
        is_admin=True,
        force_change_password=False,
    )


def _login_client(app, user, *, password=TEST_PASSWORD, remember_me=False):
    """Helper: returns a TestClient with a valid session cookie set.

    Goes through the real login endpoint so the full Set-Cookie / CSRF
    machinery is exercised. The CSRF token from the JSON response is
    added to the client's default headers so subsequent state-changing
    requests pass the CSRF check automatically.
    """
    from fastapi.testclient import TestClient

    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={
            "username": user.username,
            "password": password,
            "remember_me": remember_me,
        },
    )
    assert res.status_code == 200, res.text
    csrf = res.json()["user"]["csrf_token"]
    client.headers["X-CSRF-Token"] = csrf
    return client


def new_category(client, name: str | None = None) -> int:
    """Create a category through the API and return its id (unique name
    per call so tests never trip the per-user UNIQUE constraint)."""
    name = name or f"Cat-{uuid.uuid4().hex[:8]}"
    r = client.post(
        "/api/categories",
        json={"name": name, "icon": "house", "color": "#123456"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def other_client(app, db_session):
    """A TestClient logged in as a freshly created second user — the
    counterpart for cross-user isolation tests."""
    from app import crud

    other = crud.create_user(
        db_session,
        username=f"other-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    return _login_client(app, other)


@pytest.fixture
def authed_client(app, regular_user):
    """TestClient pre-authenticated as a normal user."""
    return _login_client(app, regular_user)


@pytest.fixture
def admin_client(app, admin_user):
    """TestClient pre-authenticated as an admin."""
    return _login_client(app, admin_user)


@pytest.fixture
def client(app, regular_user):
    """Legacy alias for ``authed_client`` — used by tests that pre-date
    the app-auth refactor (test_smoke, test_validation, …)."""
    return _login_client(app, regular_user)
