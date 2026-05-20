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


def _dialect_is_sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


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
    # The MariaDB form uses an aliased derived table (`AS u`); SQLite
    # accepts the same subquery without an alias.
    if _dialect_is_sqlite():
        op.execute(
            """
            INSERT INTO users (username)
            SELECT username FROM categories
            UNION
            SELECT username FROM transactions
            """
        )
    else:
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

    # UPDATE … JOIN is MariaDB-only. SQLite needs a correlated subquery.
    if _dialect_is_sqlite():
        op.execute(
            "UPDATE categories SET user_id = "
            "(SELECT id FROM users WHERE users.username = categories.username)"
        )
        op.execute(
            "UPDATE transactions SET user_id = "
            "(SELECT id FROM users WHERE users.username = transactions.username)"
        )
    else:
        op.execute(
            "UPDATE categories c JOIN users u ON u.username = c.username "
            "SET c.user_id = u.id"
        )
        op.execute(
            "UPDATE transactions t JOIN users u ON u.username = t.username "
            "SET t.user_id = u.id"
        )

    # 4. Schema mutations: drop username column + indexes, promote user_id
    # to NOT NULL, recreate per-user indexes / uniqueness, wire FKs.
    # batch_alter_table is mandatory on SQLite (no native DROP CONSTRAINT
    # / ALTER COLUMN); on MariaDB it's a transparent wrapper that emits
    # direct ALTER TABLE statements, so the path is the same for both.
    with op.batch_alter_table("categories") as batch:
        batch.drop_constraint("uq_categories_user_name", type_="unique")
        batch.drop_index("ix_categories_username")
        batch.drop_column("username")
        batch.alter_column(
            "user_id", existing_type=sa.Integer(), nullable=False
        )
        batch.create_index("ix_categories_user_id", ["user_id"])
        batch.create_unique_constraint(
            "uq_categories_user_name", ["user_id", "name"]
        )
        batch.create_foreign_key(
            "fk_categories_user_id_users",
            "users",
            ["user_id"],
            ["id"],
            ondelete="CASCADE",
        )

    with op.batch_alter_table("transactions") as batch:
        batch.drop_index("ix_transactions_user_date")
        batch.drop_column("username")
        batch.alter_column(
            "user_id", existing_type=sa.Integer(), nullable=False
        )
        batch.create_index("ix_transactions_user_date", ["user_id", "date"])
        batch.create_foreign_key(
            "fk_transactions_user_id_users",
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
    if _dialect_is_sqlite():
        op.execute(
            "UPDATE categories SET username = "
            "(SELECT username FROM users WHERE users.id = categories.user_id)"
        )
        op.execute(
            "UPDATE transactions SET username = "
            "(SELECT username FROM users WHERE users.id = transactions.user_id)"
        )
    else:
        op.execute(
            "UPDATE categories c JOIN users u ON u.id = c.user_id "
            "SET c.username = u.username"
        )
        op.execute(
            "UPDATE transactions t JOIN users u ON u.id = t.user_id "
            "SET t.username = u.username"
        )

    # 2. Schema mutations in reverse — see upgrade() for the batch_alter_table
    # rationale.
    with op.batch_alter_table("transactions") as batch:
        batch.alter_column(
            "username", existing_type=sa.String(150), nullable=False
        )
        batch.drop_constraint(
            "fk_transactions_user_id_users", type_="foreignkey"
        )
        batch.drop_index("ix_transactions_user_date")
        batch.drop_column("user_id")
        batch.create_index(
            "ix_transactions_user_date", ["username", "date"]
        )

    with op.batch_alter_table("categories") as batch:
        batch.alter_column(
            "username", existing_type=sa.String(150), nullable=False
        )
        batch.drop_constraint(
            "fk_categories_user_id_users", type_="foreignkey"
        )
        batch.drop_constraint("uq_categories_user_name", type_="unique")
        batch.drop_index("ix_categories_user_id")
        batch.drop_column("user_id")
        batch.create_unique_constraint(
            "uq_categories_user_name", ["username", "name"]
        )
        batch.create_index("ix_categories_username", ["username"])

    # 3. Drop the now-empty users table.
    op.drop_table("users")
