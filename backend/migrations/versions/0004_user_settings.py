"""add user_settings table for UI preferences (theme, default_view)

Revision ID: 0004_user_settings
Revises: 0003_tags_table
Create Date: 2026-05-16

iOS evicts localStorage aggressively (storage pressure, weeks of
inactivity, OS reorganisations) so the PWA forgets the user's chosen
theme and start-view. Persist them server-side as a single row per
user; the frontend still reads localStorage first for an instant
render and only reconciles with the server in the background.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0004_user_settings"
down_revision: Union[str, None] = "0003_tags_table"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.Integer(), primary_key=True),
        sa.Column(
            "theme",
            sa.String(16),
            nullable=False,
            server_default="system",
        ),
        sa.Column(
            "default_view",
            sa.String(32),
            nullable=False,
            server_default="transactions",
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
            server_onupdate=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_settings_user_id_users",
            ondelete="CASCADE",
        ),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade() -> None:
    op.drop_table("user_settings")
