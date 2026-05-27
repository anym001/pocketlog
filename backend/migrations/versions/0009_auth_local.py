"""local app-auth: add password/role columns and sessions table

Revision ID: 0009_auth_local
Revises: 0008_transaction_tags
Create Date: 2026-05-26

This migration replaces the SWAG-injected `X-Authentik-Username` header
auth with PocketLog's own session-based login. ``users`` grows the
columns needed to hold a password hash, the admin flag, the active flag,
the force-change-password flag, brute-force backoff state and a creation
timestamp. A new ``sessions`` table holds opaque session tokens (stored
as sha256 hex) with both a sliding and an absolute expiry.

Bootstrap rule for existing data:
- If no user is flagged ``is_admin`` yet, promote the oldest user
  (smallest id) — they become the admin who logs in through the setup
  flow once the new frontend ships.
- Every existing user has ``force_change_password`` set so their first
  login forces a password change (necessary because they have no
  password yet — ``password_hash`` stays NULL until an admin assigns
  one, or until the promoted admin sets their own in the setup flow).

Idempotency:
- All DDL is guarded with ``sa.inspect`` so a half-applied state from a
  previous crash can be re-applied.
- The bootstrap UPDATE only runs while no admin exists; once an admin
  is set (either by this migration or by the setup endpoint), re-running
  the migration is a no-op for the promotion step.
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0009_auth_local"
down_revision: Union[str, None] = "0008_transaction_tags"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

USERS_TABLE = "users"
SESSIONS_TABLE = "sessions"
SESSIONS_USER_IDX = "ix_sessions_user_id"
SESSIONS_EXPIRES_IDX = "ix_sessions_expires_at"
SESSIONS_TOKEN_UQ = "uq_sessions_token_hash"


# Each new column on ``users``. Kept here so add and remove paths stay
# in sync without copying SQLAlchemy column definitions twice. ``created_at``
# is split out below because SQLite refuses to ALTER TABLE ADD COLUMN
# with a non-constant default like CURRENT_TIMESTAMP — it has to be
# added without the default and backfilled separately.
_USER_COLUMNS: list[tuple[str, sa.Column]] = [
    ("password_hash", sa.Column("password_hash", sa.String(255), nullable=True)),
    (
        "is_admin",
        sa.Column(
            "is_admin",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    ),
    (
        "is_active",
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    ),
    (
        "force_change_password",
        sa.Column(
            "force_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    ),
    (
        "failed_login_count",
        sa.Column(
            "failed_login_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    ),
    (
        "lockout_until",
        sa.Column("lockout_until", sa.TIMESTAMP(), nullable=True),
    ),
]


def _table_exists(insp, name: str) -> bool:
    return name in insp.get_table_names()


def _column_exists(insp, table: str, column: str) -> bool:
    return any(c["name"] == column for c in insp.get_columns(table))


def _index_exists(insp, table: str, name: str) -> bool:
    return any(ix["name"] == name for ix in insp.get_indexes(table))


def _add_created_at(bind) -> None:
    """Add ``users.created_at`` in a dialect-aware way.

    MariaDB accepts ``ALTER TABLE ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP``
    in one statement and enforces NOT NULL directly. SQLite rejects that
    ("Cannot add a column with non-constant default") and a follow-up
    batch_alter_table to enforce NOT NULL would fail too — the
    table-rebuild it performs drops ``users`` after copying the data,
    and the children's FK constraints (categories, transactions, tags,
    user_settings, sessions) block the drop with
    ``PRAGMA foreign_keys=ON``.

    So on SQLite we add nullable, backfill every existing row, and
    accept that the DB column itself stays nullable. The ORM's
    ``server_default`` keeps new rows non-null, and SQLite is only used
    for tests/dev — the production MariaDB enforces NOT NULL.
    """
    insp = sa.inspect(bind)
    if _column_exists(insp, USERS_TABLE, "created_at"):
        return
    if bind.dialect.name == "sqlite":
        op.add_column(
            USERS_TABLE,
            sa.Column("created_at", sa.TIMESTAMP(), nullable=True),
        )
        bind.execute(
            sa.text(
                f"UPDATE {USERS_TABLE} SET created_at = CURRENT_TIMESTAMP "
                "WHERE created_at IS NULL"
            )
        )
    else:
        op.add_column(
            USERS_TABLE,
            sa.Column(
                "created_at",
                sa.TIMESTAMP(),
                nullable=False,
                server_default=sa.func.current_timestamp(),
            ),
        )


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Step 1 — add the auth-related columns to users, idempotently.
    added_any = False
    for name, column in _USER_COLUMNS:
        if not _column_exists(insp, USERS_TABLE, name):
            op.add_column(USERS_TABLE, column)
            added_any = True
    if added_any:
        insp = sa.inspect(bind)

    # created_at needs a two-stage add for SQLite compatibility.
    _add_created_at(bind)

    # Step 2 — create the sessions table and its indexes, idempotently.
    if not _table_exists(insp, SESSIONS_TABLE):
        op.create_table(
            SESSIONS_TABLE,
            sa.Column("id", sa.Integer(), nullable=False, autoincrement=True),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("token_hash", sa.CHAR(64), nullable=False),
            sa.Column("csrf_token", sa.CHAR(64), nullable=False),
            sa.Column(
                "created_at",
                sa.TIMESTAMP(),
                nullable=False,
                server_default=sa.func.current_timestamp(),
            ),
            sa.Column(
                "last_seen_at",
                sa.TIMESTAMP(),
                nullable=False,
                server_default=sa.func.current_timestamp(),
            ),
            sa.Column("expires_at", sa.TIMESTAMP(), nullable=False),
            sa.Column("absolute_expires_at", sa.TIMESTAMP(), nullable=False),
            sa.Column(
                "remember_me",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            ),
            sa.Column("user_agent", sa.String(255), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.ForeignKeyConstraint(
                ["user_id"],
                [f"{USERS_TABLE}.id"],
                name="fk_sessions_user",
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint("token_hash", name=SESSIONS_TOKEN_UQ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )
        insp = sa.inspect(bind)

    if not _index_exists(insp, SESSIONS_TABLE, SESSIONS_USER_IDX):
        op.create_index(SESSIONS_USER_IDX, SESSIONS_TABLE, ["user_id"])
        insp = sa.inspect(bind)
    if not _index_exists(insp, SESSIONS_TABLE, SESSIONS_EXPIRES_IDX):
        op.create_index(SESSIONS_EXPIRES_IDX, SESSIONS_TABLE, ["expires_at"])
        insp = sa.inspect(bind)

    # Step 3 — bootstrap existing users for the cutover.
    #
    # If there is already an admin, the cutover has happened; do nothing
    # so a re-run after a partial crash is a no-op.
    existing_admin = bind.execute(
        sa.text(f"SELECT id FROM {USERS_TABLE} WHERE is_admin = 1 LIMIT 1")
    ).first()
    if existing_admin is None:
        oldest = bind.execute(
            sa.text(f"SELECT id FROM {USERS_TABLE} ORDER BY id ASC LIMIT 1")
        ).first()
        if oldest is not None:
            bind.execute(
                sa.text(
                    f"UPDATE {USERS_TABLE} "
                    "SET is_admin = 1, force_change_password = 1 "
                    "WHERE id = :id"
                ),
                {"id": oldest[0]},
            )

    # Every existing user without a password gets force_change_password
    # so the first login lands on the change-password screen. Safe on
    # re-run: only flips rows where password_hash IS NULL, and the
    # promoted admin above already has the flag set so the row state
    # doesn't change.
    bind.execute(
        sa.text(
            f"UPDATE {USERS_TABLE} "
            "SET force_change_password = 1 "
            "WHERE password_hash IS NULL"
        )
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _table_exists(insp, SESSIONS_TABLE):
        if _index_exists(insp, SESSIONS_TABLE, SESSIONS_EXPIRES_IDX):
            op.drop_index(SESSIONS_EXPIRES_IDX, table_name=SESSIONS_TABLE)
        if _index_exists(insp, SESSIONS_TABLE, SESSIONS_USER_IDX):
            op.drop_index(SESSIONS_USER_IDX, table_name=SESSIONS_TABLE)
        op.drop_table(SESSIONS_TABLE)
        insp = sa.inspect(bind)

    # Drop columns one at a time so each is independently idempotent.
    # SQLite 3.35+ supports native ALTER TABLE DROP COLUMN; MariaDB
    # has supported it all along. batch_alter_table would rebuild the
    # whole users table, which fails on SQLite because the FKs from
    # categories/transactions/etc. block the DROP TABLE step in the
    # rebuild swap (with PRAGMA foreign_keys=ON).
    if _column_exists(insp, USERS_TABLE, "created_at"):
        op.drop_column(USERS_TABLE, "created_at")
    for name, _ in reversed(_USER_COLUMNS):
        if _column_exists(insp, USERS_TABLE, name):
            op.drop_column(USERS_TABLE, name)
