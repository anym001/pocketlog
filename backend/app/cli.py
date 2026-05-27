"""Operator-CLI für Notfall-Recovery.

Aufruf im laufenden Container:

    docker exec -it pocketlog python -m app.cli reset-admin-password
    docker exec -it pocketlog python -m app.cli clear-force-change-password

``reset-admin-password`` setzt für den einen Admin (oder den explizit
benannten User) ein neues Passwort, leert den Brute-Force-Counter und
setzt ``force_change_password=true`` — beim nächsten Login muss ein
eigenes Passwort vergeben werden.

``clear-force-change-password`` löst nur das ``force_change_password``-
Flag ohne Passwortwechsel. Notfall-Ausweg, wenn ein User in der
Force-Change-View festhängt (z. B. weil der alte Service Worker eine
veraltete ``/api/auth/me``-Response cached oder der HTTP-Roundtrip auf
dem Pfad sonstwie verloren geht) und sich nicht über die UI selbst
herausziehen kann.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from . import auth, crud, schemas
from .database import SessionLocal


def _resolve_target_user(db, username: str | None):
    """Lädt den Ziel-User für ein CLI-Kommando.

    Ohne ``--username``: nur erfolgreich, wenn genau ein Admin existiert.
    Diese Regel teilt sich der ``reset-admin-password``- und der
    ``clear-force-change-password``-Pfad."""
    if username:
        user = crud.get_user_by_username(db, username)
        if user is None:
            print(
                f"User '{username}' nicht gefunden.", file=sys.stderr
            )
            return None
        return user

    admins = [u for u in crud.list_all_users(db) if u.is_admin]
    if not admins:
        print(
            "Kein Admin in der Datenbank. Setup-Modus aufrufen "
            "(GET /api/auth/setup-status).",
            file=sys.stderr,
        )
        return None
    if len(admins) > 1:
        names = ", ".join(a.username for a in admins)
        print(
            "Mehrere Admins gefunden: "
            f"{names}. Bitte --username angeben.",
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

        user.password_hash = auth.hash_password(password)
        user.force_change_password = True
        user.failed_login_count = 0
        user.lockout_until = None
        db.commit()
        # Bestehende Sessions wegwerfen — sonst könnte ein Angreifer mit
        # gestohlenem Cookie die relaxed-current-password-Regel im
        # Force-Change-Pfad ausnutzen, bevor der legitime Operator sich
        # neu einloggt.
        revoked = auth.revoke_all_user_sessions(db, user.id)
        print(
            f"OK: Passwort für '{user.username}' gesetzt. "
            f"{revoked} aktive Session(s) invalidiert. "
            "Beim nächsten Login muss ein eigenes Passwort vergeben werden."
        )
        return 0
    finally:
        db.close()


def _cmd_clear_force_change_password(args: argparse.Namespace) -> int:
    """Löst nur das ``force_change_password``-Flag — kein Passwortwechsel,
    keine Session-Invalidierung. Soll absichtlich nicht-destruktiv sein,
    damit ein operator den festhängenden Self-Admin entsperren kann,
    ohne dabei einen lebendigen Browser-Tab abzuschießen."""
    db = SessionLocal()
    try:
        user = _resolve_target_user(db, args.username)
        if user is None:
            return 1

        if not user.force_change_password:
            print(
                f"User '{user.username}' hat das Flag bereits nicht "
                "gesetzt. Keine Aktion nötig."
            )
            return 0

        user.force_change_password = False
        db.commit()
        print(
            f"OK: force_change_password-Flag für '{user.username}' "
            "gelöscht. Der nächste API-Roundtrip landet direkt in der App."
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

    p_clear = sub.add_parser(
        "clear-force-change-password",
        help=(
            "force_change_password-Flag eines Users löschen, ohne sein "
            "Passwort zu ändern."
        ),
    )
    p_clear.add_argument(
        "--username",
        help=(
            "Username des Ziel-Accounts. Optional, wenn genau ein Admin "
            "existiert."
        ),
    )
    p_clear.set_defaults(func=_cmd_clear_force_change_password)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
