"""Regression guards for the P2 review fixes (2026-05-23).

Only the backend-side items with non-trivial behaviour get tests here:

- P2-10 — User.__table_args__ carries an explicitly-named UniqueConstraint
  so alembic --autogenerate stops proposing a "drop and recreate" of the
  username uniqueness just to give it a deterministic name.

- P2-17 — main.py refuses to start when AUTH_SECRET contains the
  SWAG sample placeholder ``REPLACE-ME``, since that string can't be a
  real shared secret and silently accepting it would defeat the entire
  point of the X-Auth-Secret header.

Frontend P2 items (manifest colors, sw.js precache ordering, CSS hover
guards, copy fixes, vendor provenance) stay uncovered — they're either
markup/CSS-level or asset-level and would need Playwright/Vitest to
verify mechanically.
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from sqlalchemy import UniqueConstraint


BACKEND_DIR = Path(__file__).resolve().parent.parent


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


# ── P2-17 ────────────────────────────────────────────────────────────────────


def _spawn_backend(env_overrides: dict[str, str]) -> subprocess.CompletedProcess:
    """Spawn `python -c 'import app.main'` in a fresh process so the
    module-level guard runs exactly once with the given env, then exits.
    Capturing the exit code + stderr gives us a clean assertion surface
    without polluting the in-process app.main already imported by other
    tests."""
    env = os.environ.copy()
    env.update(env_overrides)
    # The test conftest leaves DB_USER/PASSWORD/NAME set; make sure they
    # don't accidentally satisfy a different startup branch.
    env.setdefault("DATABASE_URL", "sqlite:///:memory:")
    return subprocess.run(
        [sys.executable, "-c", "import app.main"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


def test_auth_secret_rejects_replace_me_placeholder():
    """If the operator forgot to swap the SWAG sample placeholder for a
    real secret, the backend must refuse to start. Silently accepting
    `REPLACE-ME-WITH-OPENSSL-RAND-HEX-32` would let anyone who has
    read the public sample config impersonate SWAG."""
    proc = _spawn_backend({"AUTH_SECRET": "REPLACE-ME-WITH-OPENSSL-RAND-HEX-32"})
    assert proc.returncode != 0, (
        "Backend started despite REPLACE-ME placeholder in AUTH_SECRET "
        f"— stderr was:\n{proc.stderr}\nstdout was:\n{proc.stdout}"
    )
    combined = proc.stderr + proc.stdout
    assert "REPLACE-ME" in combined or "placeholder" in combined.lower(), (
        "Refusal message must mention the placeholder so the operator "
        f"knows what to fix. Got: {combined!r}"
    )


def test_auth_secret_real_value_starts_normally():
    """Sanity check: a real-looking secret does NOT trip the placeholder
    guard. This protects against the regex / substring check accidentally
    being too broad."""
    proc = _spawn_backend(
        {"AUTH_SECRET": "0123456789abcdef" * 4}  # 64-hex-char fake secret
    )
    assert proc.returncode == 0, (
        "Backend refused to start with a normal-looking AUTH_SECRET — "
        f"the placeholder guard is too broad. stderr:\n{proc.stderr}"
    )
