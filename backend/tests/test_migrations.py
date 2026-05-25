"""Static checks on Alembic migration files.

These run against the source on disk, not against a live DB — they catch
problems that SQLite-based integration tests can't (e.g. MariaDB rejecting
``alembic_version.version_num`` writes that exceed the column's
``VARCHAR(32)`` limit, which silently passes on SQLite where VARCHAR
lengths are advisory).
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

# alembic_version.version_num is VARCHAR(32) by default. MariaDB with
# STRICT_TRANS_TABLES rejects oversize writes with error 1406, leaving
# the container in a crash-loop because the DDL itself auto-committed
# but the version row never did. See migration 0007 for the incident.
ALEMBIC_VERSION_NUM_MAX = 32

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations" / "versions"


def _migration_files() -> list[Path]:
    return sorted(p for p in MIGRATIONS_DIR.glob("*.py") if not p.name.startswith("_"))


def _top_level_string_assignments(tree: ast.Module) -> dict[str, str]:
    """Return ``{target_name: literal_value}`` for module-level ``name = "..."``
    or ``name: T = "..."`` statements where the RHS is a plain string literal.
    Anything more complex (Union[...] | None, computed values) is skipped."""
    out: dict[str, str] = {}
    for node in tree.body:
        targets: list[ast.expr]
        value: ast.expr | None
        if isinstance(node, ast.AnnAssign):
            targets, value = [node.target], node.value
        elif isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        else:
            continue
        if not isinstance(value, ast.Constant) or not isinstance(value.value, str):
            continue
        for t in targets:
            if isinstance(t, ast.Name):
                out[t.id] = value.value
    return out


@pytest.mark.parametrize("path", _migration_files(), ids=lambda p: p.name)
def test_revision_id_fits_alembic_version_column(path: Path) -> None:
    tree = ast.parse(path.read_text())
    assignments = _top_level_string_assignments(tree)
    revision = assignments.get("revision")
    assert revision is not None, f"{path.name}: missing top-level `revision = '...'`"
    assert len(revision) <= ALEMBIC_VERSION_NUM_MAX, (
        f"{path.name}: revision id {revision!r} is {len(revision)} chars; "
        f"alembic_version.version_num is VARCHAR({ALEMBIC_VERSION_NUM_MAX}) on MariaDB. "
        "Shorten the id or the container will crash-loop on deploy."
    )
    down = assignments.get("down_revision")
    # down_revision can be None (the very first migration) or a string;
    # only enforce length when it's an actual id.
    if down is not None:
        assert len(down) <= ALEMBIC_VERSION_NUM_MAX, (
            f"{path.name}: down_revision {down!r} is {len(down)} chars; "
            f"alembic_version.version_num is VARCHAR({ALEMBIC_VERSION_NUM_MAX})."
        )
