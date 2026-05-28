"""initial schema: categories + transactions

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-13

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("username", sa.String(150), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("icon", sa.String(8), nullable=False, server_default="📦"),
        sa.Column("color", sa.CHAR(7), nullable=False, server_default="#9e9b96"),
        sa.UniqueConstraint("username", "name", name="uq_categories_user_name"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_categories_username", "categories", ["username"])

    op.create_table(
        "transactions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("username", sa.String(150), nullable=False),
        sa.Column("amount", sa.DECIMAL(12, 2), nullable=False),
        sa.Column("description", sa.String(255), nullable=False, server_default=""),
        sa.Column(
            "category_id",
            sa.Integer(),
            sa.ForeignKey("categories.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("type", sa.Enum("in", "out", name="tx_type"), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=True),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index(
        "ix_transactions_user_date", "transactions", ["username", "date"]
    )


def downgrade() -> None:
    op.drop_index("ix_transactions_user_date", table_name="transactions")
    op.drop_table("transactions")
    op.drop_index("ix_categories_username", table_name="categories")
    op.drop_table("categories")
