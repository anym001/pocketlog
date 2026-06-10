"""add api_keys table

Revision ID: 0013_api_keys
Revises: 0012_recurring_rules
Create Date: 2026-06-09

Adds the ``api_keys`` table for per-user bearer-token authentication with
configurable scopes.  Each row stores a SHA-256 hash of the raw token
(``plk_<43-char base64url>``), a JSON-serialised ``scopes`` array, and an
optional expiry timestamp.  The raw key is shown exactly once at creation
time and never persisted.

All DDL steps are guarded by ``sa.inspect()`` for the same partial-run
tolerance as 0007/0010/0011.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0013_api_keys"
down_revision: Union[str, None] = "0012_recurring_rules"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE_NAME = "api_keys"


def _table_exists(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _index_exists(bind, table_name: str, index_name: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    return any(ix["name"] == index_name for ix in insp.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _table_exists(bind, TABLE_NAME):
        op.create_table(
            TABLE_NAME,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey(
                    "users.id", ondelete="CASCADE", name="fk_api_keys_user"
                ),
                nullable=False,
            ),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("key_hash", sa.CHAR(64), nullable=False),
            sa.Column(
                "scopes",
                sa.String(255),
                nullable=False,
                server_default='["import"]',
            ),
            sa.Column(
                "created_at",
                sa.TIMESTAMP(),
                nullable=False,
                server_default=sa.func.current_timestamp(),
            ),
            sa.Column("last_used_at", sa.TIMESTAMP(), nullable=True),
            sa.Column("expires_at", sa.TIMESTAMP(), nullable=True),
            sa.UniqueConstraint("key_hash", name="uq_api_keys_key_hash"),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )

    if not _index_exists(bind, TABLE_NAME, "ix_api_keys_user_id"):
        op.create_index("ix_api_keys_user_id", TABLE_NAME, ["user_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if _index_exists(bind, TABLE_NAME, "ix_api_keys_user_id"):
        op.drop_index("ix_api_keys_user_id", table_name=TABLE_NAME)
    if _table_exists(bind, TABLE_NAME):
        op.drop_table(TABLE_NAME)
