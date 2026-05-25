"""add index on transactions.category_id for FK lookups

Revision ID: 0007_tx_category_idx
Revises: 0006_user_settings_on_update
Create Date: 2026-05-25

Without an explicit index on ``transactions.category_id`` every
category DELETE triggers a full table scan on ``transactions`` for the
InnoDB FK-RESTRICT check. With growing transaction volume this becomes
a noticeable latency issue on what should be a cheap admin operation.

NOTE on the revision ID: alembic's bookkeeping table
``alembic_version.version_num`` is ``VARCHAR(32)`` by default. The
previous revision in this slot used a 35-char ID, which MariaDB rejected
under STRICT_TRANS_TABLES with error 1406 — leaving the index created
(DDL auto-commits) but the version-row never written, so the container
crash-looped on every restart. Hence: ID kept well under 32 chars, and
the CREATE INDEX is idempotent so it tolerates the half-applied state
left over on already-running deployments.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0007_tx_category_idx"
down_revision: Union[str, None] = "0006_user_settings_on_update"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

INDEX_NAME = "ix_transactions_category_id"
TABLE_NAME = "transactions"


def _index_exists(bind, table_name: str, index_name: str) -> bool:
    insp = sa.inspect(bind)
    return any(ix["name"] == index_name for ix in insp.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    if _index_exists(bind, TABLE_NAME, INDEX_NAME):
        # Left over from a previous half-applied 0007 run (MariaDB DDL
        # auto-commits, so the index survived the version-num write that
        # failed afterwards). Treat as already-applied.
        return
    op.create_index(INDEX_NAME, TABLE_NAME, ["category_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if not _index_exists(bind, TABLE_NAME, INDEX_NAME):
        return
    op.drop_index(INDEX_NAME, table_name=TABLE_NAME)
