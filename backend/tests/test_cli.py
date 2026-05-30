"""Operator-CLI: Notfall-Recovery für vergessenes Admin-Passwort.

Der CLI-Pfad ist der einzige Ausweg aus einem komplett ausgesperrten
Admin-Account (z.B. Lockout + verlorenes Passwort). Wir testen den
Happy-Path inkl. Session-Invalidierung — die ist sicherheitskritisch,
weil die Force-Change-View die ``current_password``-Verifikation
überspringt und ein noch lebender Session-Hijack sonst das frische
Passwort selbst setzen könnte.
"""
from __future__ import annotations

import uuid

from app import auth, cli, crud, models
from sqlalchemy import select


def test_cli_reset_admin_password_happy_path(db_session, monkeypatch):
    """CLI setzt Passwort, force_change=true, clearet Lockout-State und
    invalidiert alle bestehenden Sessions."""
    user = crud.create_user(
        db_session,
        username=f"cli-admin-{uuid.uuid4().hex[:8]}",
        password="initial-bootstrap-2026",
        is_admin=True,
        force_change_password=False,
    )
    # Lockout-State simulieren (als hätte der User sich gerade ausgesperrt)
    user.failed_login_count = 5
    db_session.commit()
    # Aktive Session anlegen — die muss der CLI killen.
    auth.create_session(db_session, user, remember_me=False, user_agent=None)
    db_session.commit()

    assert db_session.scalar(
        select(models.Session).where(models.Session.user_id == user.id).limit(1)
    ) is not None

    # CLI gegen den Default-SessionLocal patchen, sodass es auf
    # unsere Test-Engine zeigt statt auf die echte App-DB.
    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)

    # In der Test-Suite leben mehrere Admin-Rows parallel — wir geben
    # daher explizit den Username an, damit der CLI nicht abbricht. Der
    # Multi-Admin-Fehlerpfad wird separat geprüft.
    new_password = "Recovery-password-2026"
    rc = cli.main([
        "reset-admin-password",
        "--username", user.username,
        "--password", new_password,
    ])
    assert rc == 0

    db_session.expire_all()
    refreshed = crud.get_user_by_id(db_session, user.id)
    assert refreshed is not None
    assert refreshed.force_change_password is True
    assert refreshed.failed_login_count == 0
    assert refreshed.lockout_until is None
    assert auth.verify_password(new_password, refreshed.password_hash)
    # Sessions weg — das ist der eigentliche Sicherheits-Check.
    assert db_session.scalar(
        select(models.Session).where(models.Session.user_id == user.id).limit(1)
    ) is None


def test_cli_reset_admin_password_too_short_rejected(db_session, monkeypatch, capsys):
    user = crud.create_user(
        db_session,
        username=f"cli-short-{uuid.uuid4().hex[:8]}",
        password="initial-bootstrap-2026",
        is_admin=True,
        force_change_password=False,
    )
    original_hash = user.password_hash

    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)

    rc = cli.main([
        "reset-admin-password",
        "--username", user.username,
        "--password", "too-short",
    ])
    assert rc == 1

    db_session.expire_all()
    refreshed = crud.get_user_by_id(db_session, user.id)
    assert refreshed.password_hash == original_hash


def test_cli_reset_unknown_user_returns_1(db_session, monkeypatch):
    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)
    rc = cli.main([
        "reset-admin-password",
        "--username", f"no-such-user-{uuid.uuid4().hex[:8]}",
        "--password", "Valid-password-2026",
    ])
    assert rc == 1


# ── CLI-Lokalisierung (folgt DEFAULT_LOCALE) ──────────────────────────────


def test_cli_messages_follow_default_locale(monkeypatch):
    """_t übersetzt nach der Deployment-Locale, nicht hart deutsch."""
    monkeypatch.setattr(crud, "DEFAULT_LOCALE", "de-DE")
    assert cli._t("pw_mismatch") == "Passwörter stimmen nicht überein."
    assert "mindestens 12" in cli._t("pw_too_short", n=12)

    monkeypatch.setattr(crud, "DEFAULT_LOCALE", "en-GB")
    assert cli._t("pw_mismatch") == "Passwords do not match."
    assert "at least 12" in cli._t("pw_too_short", n=12)


def test_cli_unknown_user_message_is_english_under_en_locale(
    db_session, monkeypatch, capsys
):
    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(crud, "DEFAULT_LOCALE", "en-GB")
    rc = cli.main([
        "reset-admin-password",
        "--username", f"no-such-user-{uuid.uuid4().hex[:8]}",
        "--password", "Valid-password-2026",
    ])
    assert rc == 1
    err = capsys.readouterr().err
    assert "not found" in err
    assert "nicht gefunden" not in err


