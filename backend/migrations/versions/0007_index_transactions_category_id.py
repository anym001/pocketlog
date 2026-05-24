"""add index on transactions.category_id for FK lookups

Revision ID: 0007_index_transactions_category_id
Revises: 0006_user_settings_on_update
Create Date: 2026-05-24

Without an explicit index on ``transactions.category_id``, every
category DELETE triggers a full table scan on ``transactions`` for
the InnoDB FK-RESTRICT check. With growing transaction volume this
becomes a noticeable latency issue on what should be a cheap admin
operation.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0007_index_transactions_category_id"
down_revision: Union[str, None] = "0006_user_settings_on_update"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "ix_transactions_category_id",
        "transactions",
        ["category_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_transactions_category_id", table_name="transactions")
