"""Operator-CLI für Notfall-Recovery.

Aufruf im laufenden Container:

    docker exec -it pocketlog python -m app.cli reset-admin-password

``reset-admin-password`` setzt für den einen Admin (oder den explizit
benannten User) ein neues Passwort, leert den Brute-Force-Counter und
setzt ``force_change_password=true`` — beim nächsten Login muss ein
eigenes Passwort vergeben werden.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from . import auth, crud, schemas
from .database import SessionLocal


# Operator-facing CLI strings. Localised by the deployment locale
# (DEFAULT_LOCALE env, same source that seeds new users) — not per-user, since
# the CLI has no logged-in user. de is the canonical fallback.
CLI_MESSAGES = {
    "de": {
        "user_not_found": "User '{username}' nicht gefunden.",
        "no_admin": (
            "Kein Admin in der Datenbank. Setup-Modus aufrufen "
            "(GET /api/auth/setup-status)."
        ),
        "multiple_admins": (
            "Mehrere Admins gefunden: {names}. Bitte --username angeben."
        ),
        "pw_mismatch": "Passwörter stimmen nicht überein.",
        "pw_too_short": "Passwort zu kurz (mindestens {n} Zeichen).",
        "pw_too_long": "Passwort zu lang (höchstens {n} Zeichen).",
        "pw_policy": schemas.PASSWORD_POLICY_HINT,
        "reset_ok": (
            "OK: Passwort für '{username}' gesetzt. "
            "{revoked} aktive Session(s) invalidiert. "
            "Beim nächsten Login muss ein eigenes Passwort vergeben werden."
        ),
        "prompt_new": "Neues Passwort: ",
        "prompt_repeat": "Wiederholen:   ",
        "help_reset": "Admin-Passwort + Lockout zurücksetzen.",
        "help_username": (
            "Username des Ziel-Accounts. Optional, wenn genau ein Admin "
            "existiert."
        ),
        "help_password": (
            "Neues Passwort. Wird sonst interaktiv abgefragt. Achtung: "
            "Übergabe via Kommandozeile ist in der Shell-History sichtbar."
        ),
    },
    "en": {
        "user_not_found": "User '{username}' not found.",
        "no_admin": (
            "No admin in the database. Use setup mode "
            "(GET /api/auth/setup-status)."
        ),
        "multiple_admins": (
            "Multiple admins found: {names}. Please pass --username."
        ),
        "pw_mismatch": "Passwords do not match.",
        "pw_too_short": "Password too short (at least {n} characters).",
        "pw_too_long": "Password too long (at most {n} characters).",
        "pw_policy": (
            "At least {n} characters, with an uppercase letter, a lowercase "
            "letter, a digit and a special character."
        ),
        "reset_ok": (
            "OK: password set for '{username}'. "
            "{revoked} active session(s) invalidated. "
            "A personal password must be set at next login."
        ),
        "prompt_new": "New password: ",
        "prompt_repeat": "Repeat:       ",
        "help_reset": "Reset admin password + lockout.",
        "help_username": (
            "Username of the target account. Optional if exactly one admin "
            "exists."
        ),
        "help_password": (
            "New password. Otherwise prompted interactively. Note: passing it "
            "on the command line is visible in shell history."
        ),
    },
}


def _t(key: str, **params) -> str:
    """Resolve a CLI string for the deployment locale. Read DEFAULT_LOCALE at
    call time so tests can monkeypatch crud.DEFAULT_LOCALE."""
    bundle = schemas.bundle_for_locale(crud.DEFAULT_LOCALE)
    table = CLI_MESSAGES.get(bundle, CLI_MESSAGES["de"])
    msg = table.get(key) or CLI_MESSAGES["de"][key]
    return msg.format(**params) if params else msg


def _resolve_target_user(db, username: str | None):
    """Lädt den Ziel-User für ein CLI-Kommando.

    Ohne ``--username``: nur erfolgreich, wenn genau ein Admin existiert."""
    if username:
        user = crud.get_user_by_username(db, username)
        if user is None:
            print(_t("user_not_found", username=username), file=sys.stderr)
            return None
        return user

    admins = [u for u in crud.list_all_users(db) if u.is_admin]
    if not admins:
        print(_t("no_admin"), file=sys.stderr)
        return None
    if len(admins) > 1:
        names = ", ".join(a.username for a in admins)
        print(_t("multiple_admins", names=names), file=sys.stderr)
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
            password = getpass.getpass(_t("prompt_new"))
            confirm = getpass.getpass(_t("prompt_repeat"))
            if password != confirm:
                print(_t("pw_mismatch"), file=sys.stderr)
                return 1

        if len(password) < schemas.MIN_PASSWORD_LENGTH:
            print(_t("pw_too_short", n=schemas.MIN_PASSWORD_LENGTH), file=sys.stderr)
            return 1
        if len(password) > schemas.MAX_PASSWORD_LENGTH:
            print(_t("pw_too_long", n=schemas.MAX_PASSWORD_LENGTH), file=sys.stderr)
            return 1
        # validate_password_complexity raises a PydanticCustomError (stable
        # code for the API). The CLI is operator-facing, so print the plain
        # policy hint instead of the machine code.
        if schemas.password_missing_classes(password):
            print(_t("pw_policy", n=schemas.MIN_PASSWORD_LENGTH), file=sys.stderr)
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
        print(_t("reset_ok", username=user.username, revoked=revoked))
        return 0
    finally:
        db.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    p_reset = sub.add_parser(
        "reset-admin-password",
        help=_t("help_reset"),
    )
    p_reset.add_argument("--username", help=_t("help_username"))
    p_reset.add_argument("--password", help=_t("help_password"))
    p_reset.set_defaults(func=_cmd_reset_admin_password)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
