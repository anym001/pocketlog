"""Operator CLI for emergency recovery and backups.

Run inside the running container via the ``pocketlog`` launcher (a thin
wrapper installed at /usr/local/bin/pocketlog that drops to PUID:PGID and
execs ``python -m app.cli``, see backend/pocketlog-cli.sh):

    docker exec -it pocketlog pocketlog reset-admin-password
    docker exec pocketlog pocketlog backup

Outside Docker (bare dev checkout) the module form works the same:

    python -m app.cli backup

``reset-admin-password`` sets a new password for the single admin (or the
explicitly named user), clears the brute-force counter and sets
``force_change_password=true`` — a personal password must be chosen at next
login.

``backup`` writes a consistent snapshot of the SQLite database via
``VACUUM INTO`` — safe while the app is running (a plain file copy of a
WAL-mode database is not). MariaDB deployments use ``mariadb-dump`` instead.

Output is English only: this is operator tooling, not end-user UI.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from datetime import datetime

from sqlalchemy.engine import make_url

from . import auth, crud, schemas
from .database import DATABASE_URL, SessionLocal, engine


def _resolve_target_user(db, username: str | None):
    """Load the target user for a CLI command.

    Without ``--username``: only succeeds if exactly one admin exists."""
    if username:
        user = crud.get_user_by_username(db, username)
        if user is None:
            print(f"User '{username}' not found.", file=sys.stderr)
            return None
        return user

    admins = [u for u in crud.list_all_users(db) if u.is_admin]
    if not admins:
        print(
            "No admin in the database. Use setup mode (GET /api/auth/setup-status).",
            file=sys.stderr,
        )
        return None
    if len(admins) > 1:
        names = ", ".join(a.username for a in admins)
        print(
            f"Multiple admins found: {names}. Please pass --username.",
            file=sys.stderr,
        )
        return None
    return admins[0]


def _cmd_reset_admin_password(args: argparse.Namespace) -> int:
    db = SessionLocal()
    try:
        user = _resolve_target_user(db, args.username)
        if user is None:
            return 1

        password = args.password
        if password is None:
            password = getpass.getpass("New password: ")
            confirm = getpass.getpass("Repeat:       ")
            if password != confirm:
                print("Passwords do not match.", file=sys.stderr)
                return 1

        if len(password) < schemas.MIN_PASSWORD_LENGTH:
            print(
                f"Password too short (at least "
                f"{schemas.MIN_PASSWORD_LENGTH} characters).",
                file=sys.stderr,
            )
            return 1
        if len(password) > schemas.MAX_PASSWORD_LENGTH:
            print(
                f"Password too long (at most "
                f"{schemas.MAX_PASSWORD_LENGTH} characters).",
                file=sys.stderr,
            )
            return 1
        # validate_password_complexity raises a PydanticCustomError (stable
        # code for the API). The CLI is operator-facing, so print a plain
        # English policy hint instead of the machine code.
        if schemas.password_missing_classes(password):
            print(
                f"At least {schemas.MIN_PASSWORD_LENGTH} characters, with an "
                "uppercase letter, a lowercase letter, a digit and a special "
                "character.",
                file=sys.stderr,
            )
            return 1

        user.password_hash = auth.hash_password(password)
        user.force_change_password = True
        user.failed_login_count = 0
        user.lockout_until = None
        db.commit()
        # Drop existing sessions — otherwise an attacker with a stolen cookie
        # could abuse the relaxed current-password rule in the force-change
        # path before the legitimate operator logs back in.
        revoked = auth.revoke_all_user_sessions(db, user.id)
        print(
            f"OK: password set for '{user.username}'. "
            f"{revoked} active session(s) invalidated. "
            "A personal password must be set at next login."
        )
        return 0
    finally:
        db.close()


def _cmd_backup(args: argparse.Namespace) -> int:
    if not DATABASE_URL.startswith("sqlite"):
        print(
            "The backup command supports the SQLite backend only. For "
            "MariaDB, snapshot with: mariadb-dump --single-transaction "
            "<database>",
            file=sys.stderr,
        )
        return 1

    db_path = make_url(DATABASE_URL).database
    if not db_path or db_path == ":memory:":
        print("No file-backed SQLite database configured.", file=sys.stderr)
        return 1

    dest = args.output
    if dest is None:
        dest_dir = os.path.join(os.path.dirname(db_path) or ".", "backups")
        dest = os.path.join(dest_dir, f"pocketlog-{datetime.now():%Y%m%d-%H%M%S}.db")
    elif os.path.isdir(dest):
        dest = os.path.join(dest, f"pocketlog-{datetime.now():%Y%m%d-%H%M%S}.db")
    if os.path.exists(dest):
        # VACUUM INTO refuses to overwrite too, but fail with a clear message
        # instead of an SQL error.
        print(f"Refusing to overwrite existing file: {dest}", file=sys.stderr)
        return 1
    parent = os.path.dirname(dest)
    if parent:
        os.makedirs(parent, exist_ok=True)

    # VACUUM INTO produces a compacted, consistent snapshot regardless of
    # concurrent writers (WAL). It cannot run inside a transaction, so the
    # connection must be in driver-level autocommit.
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.exec_driver_sql("VACUUM INTO ?", (dest,))

    size = os.path.getsize(dest)
    print(f"OK: backup written to {dest} ({size} bytes).")
    return 0


def main(argv: list[str] | None = None) -> int:
    # Canonical invocation name; `python -m app.cli` remains equivalent.
    parser = argparse.ArgumentParser(prog="pocketlog")
    sub = parser.add_subparsers(dest="command", required=True)

    p_reset = sub.add_parser(
        "reset-admin-password",
        help="Reset admin password + lockout.",
    )
    p_reset.add_argument(
        "--username",
        help="Username of the target account. Optional if exactly one admin exists.",
    )
    p_reset.add_argument(
        "--password",
        help=(
            "New password. Otherwise prompted interactively. Note: passing it "
            "on the command line is visible in shell history."
        ),
    )
    p_reset.set_defaults(func=_cmd_reset_admin_password)

    p_backup = sub.add_parser(
        "backup",
        help="Write a consistent SQLite snapshot (VACUUM INTO).",
    )
    p_backup.add_argument(
        "--output",
        help=(
            "Target file or directory. Defaults to a timestamped file in a "
            "'backups' directory next to the database."
        ),
    )
    p_backup.set_defaults(func=_cmd_backup)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
