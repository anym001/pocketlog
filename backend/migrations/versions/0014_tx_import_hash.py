"""add import_hash to transactions for CSV import deduplication

Revision ID: 0014_tx_import_hash
Revises: 0013_api_keys
Create Date: 2026-06-09

Adds ``transactions.import_hash`` — a SHA-256 hex fingerprint of
``date|amount|description.lower()|type`` set only by the CSV import path.
Manual transactions carry ``NULL``. The ``UNIQUE(user_id, import_hash)``
constraint excludes ``NULL`` values in both SQLite and MariaDB, so manual
transactions are unaffected by the idempotency guard.

Guarded by ``sa.inspect()`` for partial-run tolerance; the UNIQUE
constraint is applied via ``batch_alter_table`` on SQLite (direct
``op.create_unique_constraint`` cannot alter a SQLite table in place).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0014_tx_import_hash"
down_revision: Union[str, None] = "0013_api_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TX = "transactions"
COL = "import_hash"
UQ_NAME = "uq_tx_user_import_hash"


def _column_exists(bind, table_name: str, column_name: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    return any(c["name"] == column_name for c in insp.get_columns(table_name))


def _unique_exists(bind, table_name: str, uq_name: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    return any(
        uq.get("name") == uq_name for uq in insp.get_unique_constraints(table_name)
    )


def upgrade() -> None:
    bind = op.get_bind()
    is_sqlite = bind.dialect.name == "sqlite"

    needs_col = not _column_exists(bind, TX, COL)
    needs_uq = not _unique_exists(bind, TX, UQ_NAME)

    if is_sqlite:
        if needs_col or needs_uq:
            with op.batch_alter_table(TX) as batch:
                if needs_col:
                    batch.add_column(sa.Column(COL, sa.String(64), nullable=True))
                if needs_uq:
                    batch.create_unique_constraint(UQ_NAME, ["user_id", COL])
    else:
        if needs_col:
            op.add_column(TX, sa.Column(COL, sa.String(64), nullable=True))
        if needs_uq:
            op.create_unique_constraint(UQ_NAME, TX, ["user_id", COL])


def downgrade() -> None:
    bind = op.get_bind()
    is_sqlite = bind.dialect.name == "sqlite"

    has_uq = _unique_exists(bind, TX, UQ_NAME)
    has_col = _column_exists(bind, TX, COL)

    if is_sqlite:
        if has_uq or has_col:
            with op.batch_alter_table(TX) as batch:
                if has_uq:
                    batch.drop_constraint(UQ_NAME, type_="unique")
                if has_col:
                    batch.drop_column(COL)
    else:
        if has_uq:
            op.drop_constraint(UQ_NAME, TX, type_="unique")
        if has_col:
            op.drop_column(TX, COL)
