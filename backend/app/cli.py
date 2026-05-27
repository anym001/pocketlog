"""Operator-CLI für Notfall-Recovery.

Aufruf im laufenden Container:

    docker exec -it pocketlog python -m app.cli reset-admin-password

Setzt für den einen Admin (oder den explizit benannten User) ein neues
Passwort, leert den Brute-Force-Counter und setzt
``force_change_password=true`` — beim nächsten Login muss ein eigenes
Passwort vergeben werden.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from . import crud, schemas
from .auth import hash_password
from .database import SessionLocal


def _cmd_reset_admin_password(args: argparse.Namespace) -> int:
    db = SessionLocal()
    try:
        if args.username:
            user = crud.get_user_by_username(db, args.username)
            if user is None:
                print(
                    f"User '{args.username}' nicht gefunden.", file=sys.stderr
                )
                return 1
        else:
            admins = [u for u in crud.list_all_users(db) if u.is_admin]
            if not admins:
                print(
                    "Kein Admin in der Datenbank. Setup-Modus aufrufen "
                    "(GET /api/auth/setup-status).",
                    file=sys.stderr,
                )
                return 1
            if len(admins) > 1:
                names = ", ".join(a.username for a in admins)
                print(
                    "Mehrere Admins gefunden: "
                    f"{names}. Bitte --username angeben.",
                    file=sys.stderr,
                )
                return 1
            user = admins[0]

        password = args.password
        if password is None:
            password = getpass.getpass("Neues Passwort: ")
            confirm = getpass.getpass("Wiederholen:   ")
            if password != confirm:
                print("Passwörter stimmen nicht überein.", file=sys.stderr)
                return 1

        if len(password) < schemas.MIN_PASSWORD_LENGTH:
            print(
                f"Passwort zu kurz (mindestens "
                f"{schemas.MIN_PASSWORD_LENGTH} Zeichen).",
                file=sys.stderr,
            )
            return 1
        if len(password) > schemas.MAX_PASSWORD_LENGTH:
            print(
                f"Passwort zu lang (höchstens "
                f"{schemas.MAX_PASSWORD_LENGTH} Zeichen).",
                file=sys.stderr,
            )
            return 1

        user.password_hash = hash_password(password)
        user.force_change_password = True
        user.failed_login_count = 0
        user.lockout_until = None
        db.commit()
        print(
            f"OK: Passwort für '{user.username}' gesetzt. "
            "Beim nächsten Login muss ein eigenes Passwort vergeben werden."
        )
        return 0
    finally:
        db.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    p_reset = sub.add_parser(
        "reset-admin-password",
        help="Admin-Passwort + Lockout zurücksetzen.",
    )
    p_reset.add_argument(
        "--username",
        help=(
            "Username des Ziel-Accounts. Optional, wenn genau ein Admin "
            "existiert."
        ),
    )
    p_reset.add_argument(
        "--password",
        help=(
            "Neues Passwort. Wird sonst interaktiv abgefragt. Achtung: "
            "Übergabe via Kommandozeile ist in der Shell-History sichtbar."
        ),
    )
    p_reset.set_defaults(func=_cmd_reset_admin_password)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
