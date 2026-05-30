"""add language and currency to user_settings

Revision ID: 0010_settings_i18n
Revises: 0009_auth_local
Create Date: 2026-05-30

Adds the two i18n preferences that back the in-app language and currency
pickers. Both carry a server default so existing rows (and rows created
by the lazy ``get_or_create_settings`` path) stay valid without a data
backfill:

* ``language``  — UI language tag, ``'de'`` | ``'en'`` today, kept as a
  short VARCHAR so further languages need no schema change.
* ``currency``  — ISO 4217 code (``'EUR'``, ``'USD'`` …), CHAR(3).

The ADD COLUMN is guarded by ``sa.inspect()`` so a half-applied run (MariaDB
auto-commits DDL) is tolerated, matching the idempotent style of 0007.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0010_settings_i18n"
down_revision: Union[str, None] = "0009_auth_local"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE_NAME = "user_settings"


def _column_exists(bind, table_name: str, column_name: str) -> bool:
    insp = sa.inspect(bind)
    return any(col["name"] == column_name for col in insp.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if not _column_exists(bind, TABLE_NAME, "language"):
        op.add_column(
            TABLE_NAME,
            sa.Column(
                "language",
                sa.String(length=8),
                nullable=False,
                server_default="de",
            ),
        )
    if not _column_exists(bind, TABLE_NAME, "currency"):
        op.add_column(
            TABLE_NAME,
            sa.Column(
                "currency",
                sa.String(length=3),
                nullable=False,
                server_default="EUR",
            ),
        )


def downgrade() -> None:
    bind = op.get_bind()
    if _column_exists(bind, TABLE_NAME, "currency"):
        op.drop_column(TABLE_NAME, "currency")
    if _column_exists(bind, TABLE_NAME, "language"):
        op.drop_column(TABLE_NAME, "language")
