"""Regression guards for the P2 review fixes (2026-05-23).

Only the backend-side items with non-trivial behaviour get tests here:

- P2-10 — User.__table_args__ carries an explicitly-named UniqueConstraint
  so alembic --autogenerate stops proposing a "drop and recreate" of the
  username uniqueness just to give it a deterministic name.

Frontend P2 items (manifest colors, sw.js precache ordering, CSS hover
guards, copy fixes, vendor provenance) stay uncovered — they're either
markup/CSS-level or asset-level and would need Playwright/Vitest to
verify mechanically.

The original P2-17 (AUTH_SECRET placeholder guard) was removed when
the app moved to its own session-based auth — the X-Auth-Secret header
no longer exists. See migration 0009_auth_local.
"""
from __future__ import annotations

from sqlalchemy import UniqueConstraint


# ── P2-10 ────────────────────────────────────────────────────────────────────


def test_user_unique_constraint_is_named_in_table_args():
    """``unique=True`` on the column lets SQLAlchemy auto-name the
    constraint, which then drifts away from what migration 0002 emitted
    on MariaDB. The explicit named UniqueConstraint in __table_args__
    is the single source of truth — autogenerate stops proposing
    spurious drop/recreate diffs.
    """
    from app.models import User

    names = [
        c.name
        for c in User.__table_args__
        if isinstance(c, UniqueConstraint)
    ]
    assert "uq_users_username" in names, (
        "User.__table_args__ must declare UniqueConstraint('username', "
        "name='uq_users_username') so alembic-autogenerate is stable."
    )

    # And the column itself must NOT carry `unique=True` (otherwise we
    # end up with two unique constraints on the same column).
    username_col = User.__table__.c.username
    assert not username_col.unique, (
        "User.username must not set unique=True at the column level "
        "now that the uniqueness lives in __table_args__ — double "
        "constraint would make autogenerate noisy again."
    )
