"""normalise transaction tags into a junction table

Revision ID: 0008_transaction_tags
Revises: 0007_tx_category_idx
Create Date: 2026-05-26

Until now, ``transactions.tags`` held a JSON array of raw strings while
``tags`` held standalone (declared) tags as canonical names. ``list_tags``
merged the two sources on a case-folded key and let the standalone entry
win. That worked for the tag list but left the JSON array untouched, so
the edit form kept showing the historical casing (``"amazon"``) while
the tag list showed the canonical one (``"Amazon"``).

This migration moves to a junction table ``transaction_tags`` so a tag
exists exactly once per user. The backfill resolves every JSON tag
against the existing standalone tags by case-fold key (and inserts a
new tag row if no match exists). Once the junction table is filled,
the JSON column is dropped.

Idempotency: every step is guarded against a half-applied state, because
MariaDB DDL auto-commits but the ``alembic_version`` write only happens
once the whole ``upgrade()`` returns. A crash between any two steps
must leave a state we can pick up from on the next start.
"""
from __future__ import annotations

import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0008_transaction_tags"
down_revision: Union[str, None] = "0007_tx_category_idx"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JUNCTION_TABLE = "transaction_tags"
TX_TABLE = "transactions"
TAGS_TABLE = "tags"
TX_TAGS_COL = "tags"
JUNCTION_TAG_IDX = "ix_transaction_tags_tag_id"


def _table_exists(insp, name: str) -> bool:
    return name in insp.get_table_names()


def _column_exists(insp, table: str, column: str) -> bool:
    return any(c["name"] == column for c in insp.get_columns(table))


def _index_exists(insp, table: str, name: str) -> bool:
    return any(ix["name"] == name for ix in insp.get_indexes(table))


def _parse_tags(raw) -> list[str]:
    """Return the JSON tags column as a Python list.

    SQLAlchemy's JSON type deserialises on the ORM path, but raw
    ``sa.text(...)`` SELECTs go straight through pymysql / sqlite3
    without the type processor — so the value can arrive as ``list``,
    ``str`` or ``bytes`` depending on the driver. Normalise here.
    """
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return []
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _backfill_user(bind, user_id: int) -> None:
    """Resolve every JSON tag for ``user_id`` to a row in ``tags`` and
    link it via ``transaction_tags``. Re-runnable: already-linked pairs
    are skipped, already-existing tags are reused (case-fold)."""
    # Existing standalone tags — these win on casing per the historical
    # list_tags behaviour.
    by_fold: dict[str, int] = {}
    for tag_id, name in bind.execute(
        sa.text("SELECT id, name FROM tags WHERE user_id = :uid"),
        {"uid": user_id},
    ).all():
        if name:
            by_fold[name.strip().casefold()] = tag_id

    # Existing junction rows for this user — avoid duplicate INSERTs on
    # a re-run.
    existing_pairs: set[tuple[int, int]] = set()
    for row in bind.execute(
        sa.text(
            "SELECT tt.transaction_id, tt.tag_id "
            "FROM transaction_tags tt "
            "JOIN transactions tx ON tx.id = tt.transaction_id "
            "WHERE tx.user_id = :uid"
        ),
        {"uid": user_id},
    ).all():
        existing_pairs.add((row[0], row[1]))

    # All transactions for this user. Even if tags is NULL we don't
    # bother filtering at SQL level — _parse_tags returns [] cheaply.
    tx_rows = bind.execute(
        sa.text(
            "SELECT id, tags FROM transactions "
            "WHERE user_id = :uid AND tags IS NOT NULL"
        ),
        {"uid": user_id},
    ).all()

    pairs_to_insert: list[dict] = []

    for tx_id, tags_raw in tx_rows:
        tags = _parse_tags(tags_raw)
        if not tags:
            continue
        # Dedupe per-tx by case-fold key, same rule as
        # schemas._normalise_tags. Order preserved so the first-seen
        # casing wins when no standalone tag claims the key.
        seen_in_tx: set[str] = set()
        for raw in tags:
            if not isinstance(raw, str):
                continue
            stripped = raw.strip()
            if not stripped:
                continue
            folded = stripped.casefold()
            if folded in seen_in_tx:
                continue
            seen_in_tx.add(folded)

            tag_id = by_fold.get(folded)
            if tag_id is None:
                # No standalone or earlier-seen tag with this fold key —
                # create a new row using the as-stored casing (capped to
                # the column length, matches schemas.MAX_TAG_LENGTH).
                result = bind.execute(
                    sa.text(
                        "INSERT INTO tags (user_id, name) "
                        "VALUES (:uid, :name)"
                    ),
                    {"uid": user_id, "name": stripped[:64]},
                )
                tag_id = result.lastrowid
                by_fold[folded] = tag_id

            pair = (tx_id, tag_id)
            if pair in existing_pairs:
                continue
            existing_pairs.add(pair)
            pairs_to_insert.append({"tx_id": tx_id, "tag_id": tag_id})

    if pairs_to_insert:
        bind.execute(
            sa.text(
                "INSERT INTO transaction_tags (transaction_id, tag_id) "
                "VALUES (:tx_id, :tag_id)"
            ),
            pairs_to_insert,
        )


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Step 1 — create the junction table (idempotent).
    if not _table_exists(insp, JUNCTION_TABLE):
        op.create_table(
            JUNCTION_TABLE,
            sa.Column("transaction_id", sa.Integer(), nullable=False),
            sa.Column("tag_id", sa.Integer(), nullable=False),
            sa.ForeignKeyConstraint(
                ["transaction_id"],
                [f"{TX_TABLE}.id"],
                name="fk_tx_tags_transaction",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["tag_id"],
                [f"{TAGS_TABLE}.id"],
                name="fk_tx_tags_tag",
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint(
                "transaction_id", "tag_id", name="pk_transaction_tags"
            ),
            mysql_engine="InnoDB",
            mysql_charset="utf8mb4",
        )
        # Refresh after DDL so subsequent checks see the new table.
        insp = sa.inspect(bind)

    if not _index_exists(insp, JUNCTION_TABLE, JUNCTION_TAG_IDX):
        # Speeds up reverse lookups (find all transactions for a tag),
        # used by the new rename/delete code paths in crud.py. The
        # composite PK already covers (transaction_id, tag_id) lookups.
        op.create_index(JUNCTION_TAG_IDX, JUNCTION_TABLE, ["tag_id"])
        insp = sa.inspect(bind)

    # Step 2 — backfill from transactions.tags. If the column is gone,
    # we already ran the backfill in a previous attempt.
    if _column_exists(insp, TX_TABLE, TX_TAGS_COL):
        user_ids = [
            row[0]
            for row in bind.execute(sa.text("SELECT id FROM users")).all()
        ]
        for uid in user_ids:
            _backfill_user(bind, uid)

    # Step 3 — drop the JSON column.
    if _column_exists(insp, TX_TABLE, TX_TAGS_COL):
        op.drop_column(TX_TABLE, TX_TAGS_COL)


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # Re-add the JSON column, then materialise the relationships back
    # into it. Casing follows tags.name (the canonical value), so a
    # round-trip up→down→up is lossy w.r.t. historical mixed casing —
    # acceptable for a downgrade path.
    if not _column_exists(insp, TX_TABLE, TX_TAGS_COL):
        op.add_column(TX_TABLE, sa.Column(TX_TAGS_COL, sa.JSON(), nullable=True))
        insp = sa.inspect(bind)

    if _table_exists(insp, JUNCTION_TABLE):
        rows = bind.execute(
            sa.text(
                "SELECT tt.transaction_id, t.name "
                "FROM transaction_tags tt "
                "JOIN tags t ON t.id = tt.tag_id "
                "ORDER BY tt.transaction_id, t.name"
            )
        ).all()
        by_tx: dict[int, list[str]] = {}
        for tx_id, name in rows:
            by_tx.setdefault(tx_id, []).append(name)
        for tx_id, names in by_tx.items():
            bind.execute(
                sa.text(
                    "UPDATE transactions SET tags = :tags WHERE id = :id"
                ),
                {"tags": json.dumps(names, ensure_ascii=False), "id": tx_id},
            )

        if _index_exists(insp, JUNCTION_TABLE, JUNCTION_TAG_IDX):
            op.drop_index(JUNCTION_TAG_IDX, table_name=JUNCTION_TABLE)
        op.drop_table(JUNCTION_TABLE)
