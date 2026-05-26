"""End-to-end check on the 0008_transaction_tags backfill.

Conftest already runs ``alembic upgrade head`` once per session against
a fresh DB, so the backfill code has been executed by the time these
tests run. We can't easily replay it on populated legacy data from
inside the suite (the JSON column is already gone), but we *can* fake
the legacy shape and re-run the upgrade in isolation.

The test below downgrades back to 0007 (re-creating the JSON column),
seeds a transaction with a known mixed-case tag set, then upgrades
again and inspects the resulting tags + junction rows.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

BACKEND_DIR = Path(__file__).resolve().parent.parent


@pytest.fixture
def _cycle_migration(_prepare_database):
    """Downgrade to 0007, yield a function that finishes the
    upgrade back to head, then re-upgrade for any tests that run
    after us."""
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))

    command.downgrade(cfg, "0007_tx_category_idx")
    yield cfg
    # Make sure the schema is at head before the next test runs.
    command.upgrade(cfg, "head")


def test_backfill_merges_legacy_json_casing(_cycle_migration):
    """Seed a transaction whose JSON tags carry mixed casing while a
    standalone ``"Amazon"`` row exists. After the upgrade, the junction
    must link the transaction to the canonical row only, and no
    parallel ``"amazon"`` row may exist."""
    from app.database import engine

    with engine.begin() as conn:
        # User + category + standalone tag (canonical name).
        conn.execute(
            sa.text(
                "INSERT INTO users (username) VALUES ('backfill-test-user')"
            )
        )
        user_id = conn.execute(
            sa.text("SELECT id FROM users WHERE username='backfill-test-user'")
        ).scalar_one()
        conn.execute(
            sa.text(
                "INSERT INTO categories (user_id, name, icon, color) "
                "VALUES (:uid, 'Sonstiges', 'package', '#9e9b96')"
            ),
            {"uid": user_id},
        )
        cat_id = conn.execute(
            sa.text(
                "SELECT id FROM categories WHERE user_id=:uid AND name='Sonstiges'"
            ),
            {"uid": user_id},
        ).scalar_one()
        conn.execute(
            sa.text(
                "INSERT INTO tags (user_id, name) VALUES (:uid, 'Amazon')"
            ),
            {"uid": user_id},
        )

        # Legacy JSON-tagged transactions, two of them: one with the
        # canonical casing, one with the historical lowercase variant.
        conn.execute(
            sa.text(
                "INSERT INTO transactions "
                "(user_id, amount, description, category_id, date, type, tags) "
                "VALUES (:uid, 1.00, 'canon', :cid, '2026-05-20', 'out', :tags)"
            ),
            {
                "uid": user_id,
                "cid": cat_id,
                "tags": json.dumps(["Amazon"]),
            },
        )
        conn.execute(
            sa.text(
                "INSERT INTO transactions "
                "(user_id, amount, description, category_id, date, type, tags) "
                "VALUES (:uid, 1.00, 'legacy', :cid, '2026-05-20', 'out', :tags)"
            ),
            {
                "uid": user_id,
                "cid": cat_id,
                "tags": json.dumps(["amazon", "OTHER"]),
            },
        )

    # Run the migration we want to test.
    command.upgrade(_cycle_migration, "0008_transaction_tags")

    with engine.connect() as conn:
        # The casefold dedupe ensures we end up with exactly one row
        # for the ``amazon`` key — the pre-existing canonical "Amazon".
        tag_rows = conn.execute(
            sa.text("SELECT name FROM tags WHERE user_id = :uid"),
            {"uid": user_id},
        ).all()
        names = sorted(r[0] for r in tag_rows)
        assert names == ["Amazon", "OTHER"], names

        # Both transactions are linked to the canonical Amazon tag;
        # the second is additionally linked to OTHER.
        rows = conn.execute(
            sa.text(
                "SELECT tx.description, t.name "
                "FROM transactions tx "
                "JOIN transaction_tags tt ON tt.transaction_id = tx.id "
                "JOIN tags t ON t.id = tt.tag_id "
                "WHERE tx.user_id = :uid "
                "ORDER BY tx.description, t.name"
            ),
            {"uid": user_id},
        ).all()
        assert rows == [
            ("canon", "Amazon"),
            ("legacy", "Amazon"),
            ("legacy", "OTHER"),
        ]


def test_backfill_is_idempotent(_cycle_migration):
    """A second run of the upgrade must not raise (no duplicate-key
    insert on the junction) and must not produce ghost rows."""
    from app.database import engine

    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO users (username) VALUES ('backfill-idempotent')"
            )
        )
        uid = conn.execute(
            sa.text(
                "SELECT id FROM users WHERE username='backfill-idempotent'"
            )
        ).scalar_one()
        conn.execute(
            sa.text(
                "INSERT INTO categories (user_id, name, icon, color) "
                "VALUES (:uid, 'Sonstiges', 'package', '#9e9b96')"
            ),
            {"uid": uid},
        )
        cat_id = conn.execute(
            sa.text(
                "SELECT id FROM categories WHERE user_id=:uid AND name='Sonstiges'"
            ),
            {"uid": uid},
        ).scalar_one()
        conn.execute(
            sa.text(
                "INSERT INTO transactions "
                "(user_id, amount, description, category_id, date, type, tags) "
                "VALUES (:uid, 1.00, 'x', :cid, '2026-05-20', 'out', :tags)"
            ),
            {
                "uid": uid,
                "cid": cat_id,
                "tags": json.dumps(["solo"]),
            },
        )

    # First upgrade — runs the real backfill.
    command.upgrade(_cycle_migration, "0008_transaction_tags")

    with engine.connect() as conn:
        first_pairs = conn.execute(
            sa.text(
                "SELECT tt.transaction_id, tt.tag_id "
                "FROM transaction_tags tt "
                "JOIN transactions tx ON tx.id = tt.transaction_id "
                "WHERE tx.user_id = :uid "
                "ORDER BY tt.transaction_id, tt.tag_id"
            ),
            {"uid": uid},
        ).all()

    # Re-running the migration after the JSON column is already gone
    # must be a no-op — exercises the "column missing → skip backfill"
    # idempotency branch.
    command.upgrade(_cycle_migration, "0008_transaction_tags")

    with engine.connect() as conn:
        second_pairs = conn.execute(
            sa.text(
                "SELECT tt.transaction_id, tt.tag_id "
                "FROM transaction_tags tt "
                "JOIN transactions tx ON tx.id = tt.transaction_id "
                "WHERE tx.user_id = :uid "
                "ORDER BY tt.transaction_id, tt.tag_id"
            ),
            {"uid": uid},
        ).all()

    assert first_pairs == second_pairs
    assert len(first_pairs) == 1
