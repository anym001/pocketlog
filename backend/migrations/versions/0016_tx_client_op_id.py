"""add client_op_id to transactions for offline create deduplication

Revision ID: 0016_tx_client_op_id
Revises: 0015_budgets
Create Date: 2026-07-01

Adds ``transactions.client_op_id`` — a client-generated idempotency key
(UUID) sent by the offline outbox. When a queued create is replayed after
the first (timed-out) attempt already reached the server, the
``UNIQUE(user_id, client_op_id)`` constraint lets the API return the
existing row instead of inserting a duplicate. Online creates that send no
op-id carry ``NULL``; NULLs are distinct in both SQLite and MariaDB, so
they are unaffected by the guard.

Mirrors ``0014_tx_import_hash``: ``sa.inspect()`` guards make it tolerant of
partial runs, and the UNIQUE constraint goes through ``batch_alter_table``
on SQLite (a direct ``op.create_unique_constraint`` cannot alter a SQLite
table in place).
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0016_tx_client_op_id"
down_revision: Union[str, None] = "0015_budgets"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TX = "transactions"
COL = "client_op_id"
UQ_NAME = "uq_tx_user_client_op"


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
