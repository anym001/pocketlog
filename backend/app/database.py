import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Variables that signal an opt-in to the MariaDB backend. The mere presence
# of any one of them switches PocketLog away from the default SQLite file.
_DB_ENV_VARS = ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD")
_DEFAULT_SQLITE_PATH = "/config/db/pocketlog.db"


def _build_url() -> str:
    """Resolve the SQLAlchemy URL. Backend selection is implicit:

    1. ``DATABASE_URL`` wins when set — used by the test suite and Alembic
       (SQLite), and as an advanced override (custom driver, SSL, socket).
    2. otherwise, if any ``DB_*`` var is set, **MariaDB** is selected.
       ``DB_PASSWORD`` is then required; ``DB_NAME``/``DB_USER`` default to
       ``pocketlog``, ``DB_HOST`` to ``mariadb``, ``DB_PORT`` to ``3306``.
    3. otherwise **SQLite** at ``SQLITE_PATH`` (default ``/config/db/pocketlog.db``).
    """
    explicit = os.environ.get("DATABASE_URL", "").strip()
    if explicit:
        return explicit

    if any(os.environ.get(k, "").strip() for k in _DB_ENV_VARS):
        # MariaDB opt-in. Keyed on *any* DB_* var (not just DB_HOST) so a
        # half-configured setup — e.g. DB_NAME set but DB_HOST forgotten —
        # fails loudly instead of silently falling back to SQLite.
        password = os.environ.get("DB_PASSWORD", "").strip()
        if not password:
            raise RuntimeError(
                "MariaDB backend selected (a DB_* variable is set) but "
                "DB_PASSWORD is missing. Set DB_PASSWORD, or unset all DB_* "
                "variables to use the default SQLite backend."
            )
        user = os.environ.get("DB_USER", "").strip() or "pocketlog"
        host = os.environ.get("DB_HOST", "").strip() or "mariadb"
        port = os.environ.get("DB_PORT", "").strip() or "3306"
        name = os.environ.get("DB_NAME", "").strip() or "pocketlog"
        return (
            f"mysql+pymysql://{user}:{quote_plus(password)}@{host}:{port}/{name}"
            "?charset=utf8mb4"
        )

    path = os.environ.get("SQLITE_PATH", "").strip() or _DEFAULT_SQLITE_PATH
    return f"sqlite:///{path}"


DATABASE_URL = _build_url()


def _make_engine(url: str):
    if url.startswith("sqlite"):
        # Ensure the parent directory exists before SQLite tries to open the
        # file. The container entrypoint already creates /config/db, but this
        # keeps a bare ``python -m`` dev run working too.
        db_path = make_url(url).database
        if db_path and db_path != ":memory:":
            os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        # SQLite is single-process; the pool-recycle / pool-pre-ping knobs
        # MariaDB needs don't apply. check_same_thread=False lets FastAPI
        # share a single in-memory DB across the request thread and the
        # TestClient worker thread.
        return create_engine(
            url,
            future=True,
            connect_args={"check_same_thread": False},
        )
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=3600,
        future=True,
    )


engine = _make_engine(DATABASE_URL)


# Per-connection PRAGMAs for the SQLite backend:
# - foreign_keys=ON: SQLite ignores ON DELETE CASCADE / RESTRICT unless
#   enabled per connection — without it, deleting a user would orphan their
#   categories and transactions.
# - journal_mode=WAL: lets readers and a single writer work concurrently —
#   relevant when several devices sync against the PWA at once.
# - busy_timeout=5000: wait up to 5s for a lock instead of failing fast with
#   "database is locked" under load.
if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(Engine, "connect")
    def _sqlite_pragmas(dbapi_connection, connection_record):  # pragma: no cover
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
