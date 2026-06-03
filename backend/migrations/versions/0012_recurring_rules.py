"""add recurring rules + skips + tx.source_rule_id

Revision ID: 0012_recurring_rules
Revises: 0011_goals
Create Date: 2026-06-03

Adds the recurring-booking feature. Three new tables plus one new
column on ``transactions``:

* ``recurring_rules`` — the template (amount, type, category, frequency,
  end conditions, cached ``next_occurrence_date`` cursor).
* ``recurring_rule_skips`` — composite-PK list of (rule_id, skip_date)
  the user opted out of. CASCADE on rule delete.
* ``recurring_rule_tags`` — link table to the existing ``tags`` table,
  mirroring ``transaction_tags`` so the tag-rename/merge code path
  walks rule tags transparently.
* ``transactions.source_rule_id`` — nullable FK to ``recurring_rules``
  with ``ON DELETE SET NULL``. Lets the UI render a recurring badge and
  keeps history readable after rule deletion.
* ``uq_transactions_rule_date (source_rule_id, date)`` — idempotency
  guard for the catch-up routine. Concurrent catch-up loops can't
  double-book; the loser hits the unique constraint and skips. Manual
  transactions (source_rule_id IS NULL) are unaffected because every
  DB we target treats NULL as distinct in a UNIQUE.

The catch-up scan (``WHERE active AND next_occurrence_date <= today``)
gets ``ix_recurring_rules_due (active, next_occurrence_date)`` so the
steady-state cost on every authed request is a single index range scan
with zero rows.

All steps are guarded by ``sa.inspect()``-based existence checks for
the same partial-run tolerance as 0007/0010/0011. The unique
constraint on ``transactions`` is added inside a ``batch_alter_table``
on SQLite — ``op.create_unique_constraint`` cannot alter a SQLite
table directly.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0012_recurring_rules"
down_revision: Union[str, None] = "0011_goals"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

RULES = "recurring_rules"
SKIPS = "recurring_rule_skips"
RULE_TAGS = "recurring_rule_tags"
TX = "transactions"

UQ_TX_RULE_DATE = "uq_transactions_rule_date"
IX_TX_SOURCE_RULE = "ix_transactions_source_rule_id"


def _table_exists(bind, table_name: str) -> bool:
    return sa.inspect(bind).has_table(table_name)


def _index_exists(bind, table_name: str, index_name: str) -> bool:
    insp = sa.inspect(bind)
    if not insp.has_table(table_name):
        return False
    return any(ix["name"] == index_name for ix in insp.get_indexes(table_name))


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
    # Mirror 0011: ON UPDATE CURRENT_TIMESTAMP is MariaDB-only DDL; on
    # SQLite the ORM's onupdate keeps the column fresh and the server
    # default carries only the CURRENT_TIMESTAMP.
    updated_default = (
        sa.text("CURRENT_TIMESTAMP")
        if is_sqlite
        else sa.text("CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP")
    )

    if not _table_exists(bind, RULES):
        op.create_table(
            RULES,
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey(
                    "users.id",
                    ondelete="CASCADE",
                    name="fk_recurring_rules_user",
                ),
                nullable=False,
            ),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("amount", sa.DECIMAL(12, 2), nullable=False),
            sa.Column(
                "type",
                sa.Enum("in", "out", name="tx_type"),
                nullable=False,
            ),
            sa.Column(
                "category_id",
                sa.Integer(),
                sa.ForeignKey(
                    "categories.id",
                    ondelete="RESTRICT",
                    name="fk_recurring_rules_category",
                ),
                nullable=False,
            ),
            sa.Column(
                "description",
                sa.String(255),
                nullable=False,
                server_default="",
            ),
            sa.Column(
                "frequency",
                sa.Enum(
                    "daily", "weekly", "monthly", "quarterly", "yearly",
                    name="recurring_freq",
                ),
                nullable=False,
            ),
            sa.Column(
                "interval", sa.Integer(), nullable=False, server_default="1"
            ),
            sa.Column("weekday", sa.Integer(), nullable=True),
            sa.Column("day_of_month", sa.Integer(), nullable=True),
            sa.Column("start_date", sa.Date(), nullable=False),
            sa.Column("end_date", sa.Date(), nullable=True),
            sa.Column("max_occurrences", sa.Integer(), nullable=True),
            sa.Column("next_occurrence_date", sa.Date(), nullable=True),
            sa.Column(
                "occurrences_count",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
            sa.Column(
                "active",
                sa.Boolean(),
                nullable=False,
                server_default="1",
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
                "user_id", "name", name="uq_recurring_rules_user_name"
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )

    if not _index_exists(bind, RULES, "ix_recurring_rules_user_id"):
        op.create_index("ix_recurring_rules_user_id", RULES, ["user_id"])
    if not _index_exists(bind, RULES, "ix_recurring_rules_category_id"):
        op.create_index(
            "ix_recurring_rules_category_id", RULES, ["category_id"]
        )
    if not _index_exists(bind, RULES, "ix_recurring_rules_due"):
        op.create_index(
            "ix_recurring_rules_due",
            RULES,
            ["active", "next_occurrence_date"],
        )

    if not _table_exists(bind, SKIPS):
        op.create_table(
            SKIPS,
            sa.Column(
                "rule_id",
                sa.Integer(),
                sa.ForeignKey(
                    "recurring_rules.id",
                    ondelete="CASCADE",
                    name="fk_recurring_rule_skips_rule",
                ),
                nullable=False,
            ),
            sa.Column("skip_date", sa.Date(), nullable=False),
            sa.PrimaryKeyConstraint(
                "rule_id", "skip_date", name="pk_recurring_rule_skips"
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )

    if not _table_exists(bind, RULE_TAGS):
        op.create_table(
            RULE_TAGS,
            sa.Column(
                "rule_id",
                sa.Integer(),
                sa.ForeignKey(
                    "recurring_rules.id",
                    ondelete="CASCADE",
                    name="fk_recurring_rule_tags_rule",
                ),
                nullable=False,
            ),
            sa.Column(
                "tag_id",
                sa.Integer(),
                sa.ForeignKey(
                    "tags.id",
                    ondelete="CASCADE",
                    name="fk_recurring_rule_tags_tag",
                ),
                nullable=False,
            ),
            sa.PrimaryKeyConstraint(
                "rule_id", "tag_id", name="pk_recurring_rule_tags"
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )

    if not _index_exists(bind, RULE_TAGS, "ix_recurring_rule_tags_tag_id"):
        op.create_index(
            "ix_recurring_rule_tags_tag_id", RULE_TAGS, ["tag_id"]
        )

    # transactions.source_rule_id + uniqueness on (source_rule_id, date).
    # On SQLite both an FK-bearing ADD COLUMN and a CREATE UNIQUE on an
    # existing table require the batch (copy-and-move) strategy.
    # MariaDB does both inline.
    needs_col = not _column_exists(bind, TX, "source_rule_id")
    needs_uq = not _unique_exists(bind, TX, UQ_TX_RULE_DATE)

    if is_sqlite:
        if needs_col or needs_uq:
            with op.batch_alter_table(TX) as batch:
                if needs_col:
                    batch.add_column(
                        sa.Column(
                            "source_rule_id",
                            sa.Integer(),
                            sa.ForeignKey(
                                "recurring_rules.id",
                                ondelete="SET NULL",
                                name="fk_transactions_source_rule",
                            ),
                            nullable=True,
                        )
                    )
                if needs_uq:
                    batch.create_unique_constraint(
                        UQ_TX_RULE_DATE, ["source_rule_id", "date"]
                    )
    else:
        if needs_col:
            op.add_column(
                TX,
                sa.Column(
                    "source_rule_id",
                    sa.Integer(),
                    sa.ForeignKey(
                        "recurring_rules.id",
                        ondelete="SET NULL",
                        name="fk_transactions_source_rule",
                    ),
                    nullable=True,
                ),
            )
        if needs_uq:
            op.create_unique_constraint(
                UQ_TX_RULE_DATE, TX, ["source_rule_id", "date"]
            )

    if not _index_exists(bind, TX, IX_TX_SOURCE_RULE):
        op.create_index(IX_TX_SOURCE_RULE, TX, ["source_rule_id"])


def downgrade() -> None:
    bind = op.get_bind()
    is_sqlite = bind.dialect.name == "sqlite"

    if _unique_exists(bind, TX, UQ_TX_RULE_DATE):
        if is_sqlite:
            with op.batch_alter_table(TX) as batch:
                batch.drop_constraint(UQ_TX_RULE_DATE, type_="unique")
        else:
            op.drop_constraint(UQ_TX_RULE_DATE, TX, type_="unique")

    if _index_exists(bind, TX, IX_TX_SOURCE_RULE):
        op.drop_index(IX_TX_SOURCE_RULE, table_name=TX)

    if _column_exists(bind, TX, "source_rule_id"):
        with op.batch_alter_table(TX) as batch:
            batch.drop_column("source_rule_id")

    if _index_exists(bind, RULE_TAGS, "ix_recurring_rule_tags_tag_id"):
        op.drop_index("ix_recurring_rule_tags_tag_id", table_name=RULE_TAGS)
    if _table_exists(bind, RULE_TAGS):
        op.drop_table(RULE_TAGS)

    if _table_exists(bind, SKIPS):
        op.drop_table(SKIPS)

    if _index_exists(bind, RULES, "ix_recurring_rules_due"):
        op.drop_index("ix_recurring_rules_due", table_name=RULES)
    if _index_exists(bind, RULES, "ix_recurring_rules_category_id"):
        op.drop_index(
            "ix_recurring_rules_category_id", table_name=RULES
        )
    if _index_exists(bind, RULES, "ix_recurring_rules_user_id"):
        op.drop_index("ix_recurring_rules_user_id", table_name=RULES)
    if _table_exists(bind, RULES):
        op.drop_table(RULES)
