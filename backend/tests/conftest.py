"""Shared fixtures for the smoke-test suite.

The whole suite runs against a file-backed SQLite database. The database
URL and the AUTH_SECRET are set **before** any `app.*` module is
imported, so the engine in `app.database` resolves to SQLite and the
auth middleware doesn't demand a shared secret.
"""
import os
import uuid
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parent.parent
TEST_DB_PATH = BACKEND_DIR / "test-pocketlog.db"

# Must run before any `from app...` import elsewhere.
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
os.environ.setdefault("AUTH_SECRET", "")
# Required keys the production builder reads — ignored on the SQLite path
# but app.database._build_url is only consulted when DATABASE_URL is
# empty, so technically these aren't needed. We set them anyway to keep
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
def username():
    """Unique Authentik username per test — guarantees data isolation
    without truncating tables between tests, since every CRUD query in
    the backend is filtered by user_id."""
    return f"test-{uuid.uuid4().hex[:12]}"


@pytest.fixture
def client(app, username):
    """TestClient pre-loaded with the auth header the backend expects."""
    from fastapi.testclient import TestClient

    return TestClient(app, headers={"X-Authentik-Username": username})
