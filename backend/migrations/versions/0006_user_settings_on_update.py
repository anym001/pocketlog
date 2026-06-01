"""fix user_settings.updated_at to emit ON UPDATE CURRENT_TIMESTAMP

Revision ID: 0006_user_settings_on_update
Revises: 0005_category_icon_ids
Create Date: 2026-05-24

Migration 0004 used ``server_onupdate=sa.text("CURRENT_TIMESTAMP")``,
which SQLAlchemy treats as a Python-side marker and does NOT translate
into DDL. As a result MariaDB never received the ``ON UPDATE`` clause
and ``updated_at`` was only refreshed by ORM writes — direct SQL
UPDATEs (e.g. from migrations or the MySQL CLI) left the timestamp
stale. The combined ``CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP``
expression has to be passed via ``server_default`` for the DDL to
actually contain it.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0006_user_settings_on_update"
down_revision: Union[str, None] = "0005_category_icon_ids"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _dialect_is_sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


def upgrade() -> None:
    # ``ON UPDATE CURRENT_TIMESTAMP`` is MariaDB/MySQL DDL and has no
    # SQLite equivalent. On the SQLite backend the column is instead kept
    # fresh by the ORM ``onupdate=func.current_timestamp()`` (see
    # models.UserSettings), so skip the ALTER here.
    if _dialect_is_sqlite():
        return
    op.alter_column(
        "user_settings",
        "updated_at",
        existing_type=sa.TIMESTAMP(),
        existing_nullable=False,
        server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
        existing_server_default=sa.text("CURRENT_TIMESTAMP"),
    )


def downgrade() -> None:
    if _dialect_is_sqlite():
        return
    op.alter_column(
        "user_settings",
        "updated_at",
        existing_type=sa.TIMESTAMP(),
        existing_nullable=False,
        server_default=sa.text("CURRENT_TIMESTAMP"),
        existing_server_default=sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"),
    )
