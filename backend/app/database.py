import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


def _build_url() -> str:
    """Resolve the SQLAlchemy URL.

    ``DATABASE_URL`` wins when set (used for the SQLite dev/CI backend and
    for any future override). Otherwise the URL is composed from the
    ``DB_*`` envs as in the original MariaDB-only setup.
    """
    explicit = os.environ.get("DATABASE_URL", "").strip()
    if explicit:
        return explicit

    user = os.environ["DB_USER"]
    password = quote_plus(os.environ["DB_PASSWORD"])
    host = os.environ.get("DB_HOST", "mariadb")
    port = os.environ.get("DB_PORT", "3306")
    name = os.environ["DB_NAME"]
    return f"mysql+pymysql://{user}:{password}@{host}:{port}/{name}?charset=utf8mb4"


DATABASE_URL = _build_url()


def _make_engine(url: str):
    if url.startswith("sqlite"):
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


# SQLite ignores ON DELETE CASCADE / RESTRICT unless foreign keys are
# explicitly enabled per connection — without this, deleting a user
# would orphan their categories and transactions on SQLite.
if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(Engine, "connect")
    def _sqlite_fk_pragma(dbapi_connection, connection_record):  # pragma: no cover
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
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
