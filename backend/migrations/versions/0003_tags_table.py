"""add tags table for standalone (declared) tags

Revision ID: 0003_tags_table
Revises: 0002_user_id_fk
Create Date: 2026-05-15

Tags used in transactions still live in transactions.tags (JSON). This
table holds tags the user has *declared* without (yet) attaching them to
a transaction. list_tags() unions both sources.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_tags_table"
down_revision: Union[str, None] = "0002_user_id_fk"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tags",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_tags_user_id_users",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("user_id", "name", name="uq_tags_user_name"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_index("ix_tags_user_id", "tags", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_tags_user_id", table_name="tags")
    op.drop_table("tags")
