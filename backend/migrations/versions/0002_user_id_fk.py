"""add users table; replace username column with user_id FK

Revision ID: 0002_user_id_fk
Revises: 0001_initial
Create Date: 2026-05-14

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_user_id_fk"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Create the users table.
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("username", sa.String(150), nullable=False),
        sa.UniqueConstraint("username", name="uq_users_username"),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )

    # 2. Backfill users from any existing rows in categories/transactions.
    op.execute(
        """
        INSERT INTO users (username)
        SELECT username FROM (
            SELECT username FROM categories
            UNION
            SELECT username FROM transactions
        ) AS u
        """
    )

    # 3. Add nullable user_id columns; populate them from the username link.
    op.add_column("categories", sa.Column("user_id", sa.Integer(), nullable=True))
    op.add_column("transactions", sa.Column("user_id", sa.Integer(), nullable=True))

    op.execute(
        "UPDATE categories c JOIN users u ON u.username = c.username "
        "SET c.user_id = u.id"
    )
    op.execute(
        "UPDATE transactions t JOIN users u ON u.username = t.username "
        "SET t.user_id = u.id"
    )

    # 4. Drop old per-user indexes and the username columns.
    op.drop_constraint("uq_categories_user_name", "categories", type_="unique")
    op.drop_index("ix_categories_username", table_name="categories")
    op.drop_column("categories", "username")

    op.drop_index("ix_transactions_user_date", table_name="transactions")
    op.drop_column("transactions", "username")

    # 5. Promote user_id to NOT NULL now that it is fully populated.
    op.alter_column(
        "categories", "user_id", existing_type=sa.Integer(), nullable=False
    )
    op.alter_column(
        "transactions", "user_id", existing_type=sa.Integer(), nullable=False
    )

    # 6. Recreate per-user indexes/uniqueness on the new column.
    op.create_index("ix_categories_user_id", "categories", ["user_id"])
    op.create_unique_constraint(
        "uq_categories_user_name", "categories", ["user_id", "name"]
    )
    op.create_index(
        "ix_transactions_user_date", "transactions", ["user_id", "date"]
    )

    # 7. Wire FKs to users (cascades clean up a user's data on deletion).
    op.create_foreign_key(
        "fk_categories_user_id_users",
        "categories",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_transactions_user_id_users",
        "transactions",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    # 1. Re-add nullable username columns; backfill from users.
    op.add_column(
        "categories", sa.Column("username", sa.String(150), nullable=True)
    )
    op.add_column(
        "transactions", sa.Column("username", sa.String(150), nullable=True)
    )
    op.execute(
        "UPDATE categories c JOIN users u ON u.id = c.user_id "
        "SET c.username = u.username"
    )
    op.execute(
        "UPDATE transactions t JOIN users u ON u.id = t.user_id "
        "SET t.username = u.username"
    )
    op.alter_column(
        "categories", "username", existing_type=sa.String(150), nullable=False
    )
    op.alter_column(
        "transactions", "username", existing_type=sa.String(150), nullable=False
    )

    # 2. Drop the user_id-based indexes/FKs and the user_id column itself.
    op.drop_constraint(
        "fk_transactions_user_id_users", "transactions", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_categories_user_id_users", "categories", type_="foreignkey"
    )
    op.drop_index("ix_transactions_user_date", table_name="transactions")
    op.drop_constraint("uq_categories_user_name", "categories", type_="unique")
    op.drop_index("ix_categories_user_id", table_name="categories")
    op.drop_column("transactions", "user_id")
    op.drop_column("categories", "user_id")

    # 3. Restore the original per-username indexes/uniqueness.
    op.create_unique_constraint(
        "uq_categories_user_name", "categories", ["username", "name"]
    )
    op.create_index("ix_categories_username", "categories", ["username"])
    op.create_index(
        "ix_transactions_user_date", "transactions", ["username", "date"]
    )

    # 4. Drop the now-empty users table.
    op.drop_table("users")
