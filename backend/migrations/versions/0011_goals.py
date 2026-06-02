"""add goals table (savings + debt trackers)

Revision ID: 0011_goals
Revises: 0010_settings_i18n
Create Date: 2026-06-02

Adds the ``goals`` table backing the unified savings-goal / debt-payoff
tracker. A goal links 1:1 to a category (``uq_goals_user_category``) and
counts the linked category's transactions dated on/after ``start_date``
toward a derived progress value — the table itself stores no aggregate.

* ``direction``  — ``'save_up'`` (count up to ``target_amount``) or
  ``'pay_down'`` (count down from ``initial_amount`` toward
  ``target_amount``). Native ENUM on MariaDB, CHECK-backed VARCHAR on
  SQLite (handled by ``sa.Enum``, same as ``tx_type``).
* ``category_id`` — FK ON DELETE CASCADE. Category deletion is also
  blocked at the application layer while a goal references it
  (``crud.delete_category``); CASCADE remains the DB-level safety net for
  user deletion.

The create_table / create_index calls are guarded by ``sa.inspect()`` so a
half-applied run (MariaDB auto-commits DDL) is tolerated, matching the
idempotent style of 0007/0010.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0011_goals"
down_revision: Union[str, None] = "0010_settings_i18n"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE_NAME = "goals"


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
                    "users.id", ondelete="CASCADE", name="fk_goals_user"
                ),
                nullable=False,
            ),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column(
                "direction",
                sa.Enum("save_up", "pay_down", name="goal_direction"),
                nullable=False,
            ),
            sa.Column(
                "category_id",
                sa.Integer(),
                sa.ForeignKey(
                    "categories.id", ondelete="CASCADE", name="fk_goals_category"
                ),
                nullable=False,
            ),
            sa.Column(
                "initial_amount",
                sa.DECIMAL(12, 2),
                nullable=False,
                server_default="0",
            ),
            sa.Column("target_amount", sa.DECIMAL(12, 2), nullable=False),
            sa.Column("start_date", sa.Date(), nullable=False),
            sa.Column(
                "icon", sa.String(64), nullable=False, server_default="piggy-bank"
            ),
            sa.Column(
                "color", sa.CHAR(7), nullable=False, server_default="#9e9b96"
            ),
            sa.Column(
                "created_at",
                sa.TIMESTAMP(),
                nullable=False,
                server_default=sa.func.current_timestamp(),
            ),
            sa.Column(
                "updated_at",
                sa.TIMESTAMP(),
                nullable=False,
                server_default=sa.func.current_timestamp(),
            ),
            sa.UniqueConstraint(
                "user_id", "category_id", name="uq_goals_user_category"
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )

    if not _index_exists(bind, TABLE_NAME, "ix_goals_user_id"):
        op.create_index("ix_goals_user_id", TABLE_NAME, ["user_id"])
    if not _index_exists(bind, TABLE_NAME, "ix_goals_category_id"):
        op.create_index("ix_goals_category_id", TABLE_NAME, ["category_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if _index_exists(bind, TABLE_NAME, "ix_goals_category_id"):
        op.drop_index("ix_goals_category_id", table_name=TABLE_NAME)
    if _index_exists(bind, TABLE_NAME, "ix_goals_user_id"):
        op.drop_index("ix_goals_user_id", table_name=TABLE_NAME)
    if _table_exists(bind, TABLE_NAME):
        op.drop_table(TABLE_NAME)
