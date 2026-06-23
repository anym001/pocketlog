"""add budgets table (per-category spending caps)

Revision ID: 0015_budgets
Revises: 0014_tx_import_hash
Create Date: 2026-06-22

Adds the ``budgets`` table backing per-category spending caps. A budget
links 1:1 to a category (``uq_budgets_user_category``) and caps the linked
category's ``out`` spending within the active calendar period — the table
itself stores no aggregate; consumption is derived in the frontend.

* ``frequency``  — ``'monthly'`` | ``'quarterly'`` | ``'yearly'``, the
  calendar-aligned period the cap resets on (no rollover). Native ENUM on
  MariaDB, CHECK-backed VARCHAR on SQLite (handled by ``sa.Enum``, same as
  ``goal_direction``).
* ``category_id`` — FK ON DELETE CASCADE. Category deletion is also blocked
  at the application layer while a budget references it
  (``crud.delete_category``); CASCADE remains the DB-level safety net for
  user deletion. A category may carry both a goal and a budget.

The create_table / create_index calls are guarded by ``sa.inspect()`` so a
half-applied run (MariaDB auto-commits DDL) is tolerated, matching the
idempotent style of 0007/0010/0011.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0015_budgets"
down_revision: Union[str, None] = "0014_tx_import_hash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE_NAME = "budgets"


def _table_exists(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _index_exists(bind, table_name: str, index_name: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    return any(ix["name"] == index_name for ix in insp.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    # ``ON UPDATE CURRENT_TIMESTAMP`` is MariaDB/MySQL DDL with no SQLite
    # equivalent (mirrors 0006/0011). On SQLite the ORM onupdate keeps the
    # column fresh; on MariaDB the combined expression must live in
    # server_default for the DDL to actually carry the ON UPDATE clause.
    updated_default = (
        sa.text("CURRENT_TIMESTAMP")
        if bind.dialect.name == "sqlite"
        else sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")
    )
    if not _table_exists(bind, TABLE_NAME):
        op.create_table(
            TABLE_NAME,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE", name="fk_budgets_user"),
                nullable=False,
            ),
            sa.Column(
                "category_id",
                sa.Integer(),
                sa.ForeignKey(
                    "categories.id",
                    ondelete="CASCADE",
                    name="fk_budgets_category",
                ),
                nullable=False,
            ),
            sa.Column("amount", sa.DECIMAL(12, 2), nullable=False),
            sa.Column(
                "frequency",
                sa.Enum("monthly", "quarterly", "yearly", name="budget_frequency"),
                nullable=False,
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
                server_default=updated_default,
            ),
            sa.UniqueConstraint(
                "user_id", "category_id", name="uq_budgets_user_category"
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )

    if not _index_exists(bind, TABLE_NAME, "ix_budgets_user_id"):
        op.create_index("ix_budgets_user_id", TABLE_NAME, ["user_id"])
    if not _index_exists(bind, TABLE_NAME, "ix_budgets_category_id"):
        op.create_index("ix_budgets_category_id", TABLE_NAME, ["category_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if _index_exists(bind, TABLE_NAME, "ix_budgets_category_id"):
        op.drop_index("ix_budgets_category_id", table_name=TABLE_NAME)
    if _index_exists(bind, TABLE_NAME, "ix_budgets_user_id"):
        op.drop_index("ix_budgets_user_id", table_name=TABLE_NAME)
    if _table_exists(bind, TABLE_NAME):
        op.drop_table(TABLE_NAME)
