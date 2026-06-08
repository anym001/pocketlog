"""Operator CLI for emergency recovery.

Run inside the running container:

    docker exec -it pocketlog python -m app.cli reset-admin-password

``reset-admin-password`` sets a new password for the single admin (or the
explicitly named user), clears the brute-force counter and sets
``force_change_password=true`` — a personal password must be chosen at next
login.

Output is English only: this is operator tooling, not end-user UI.
"""

from __future__ import annotations

import argparse
import getpass
import sys

from . import auth, crud, schemas
from .database import SessionLocal


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
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

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
