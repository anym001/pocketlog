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


def test_cli_clear_force_change_password_happy_path(db_session, monkeypatch):
    """Clearet das Flag, ohne Passwort oder Sessions anzufassen.

    Das ist der Notfall-Ausweg für einen Self-Admin, der in der
    Force-Change-View festhängt — wenn wir hier Sessions killen würden,
    würde der laufende Browser-Tab des Operators sofort 401 sehen und
    er müsste sich neu einloggen, statt einfach refresh zu drücken."""
    user = crud.create_user(
        db_session,
        username=f"cli-stuck-{uuid.uuid4().hex[:8]}",
        password="stuck-bootstrap-2026",
        is_admin=True,
        force_change_password=True,
    )
    original_hash = user.password_hash
    # Aktive Session — bleibt erhalten.
    auth.create_session(db_session, user, remember_me=False, user_agent=None)
    db_session.commit()

    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)

    rc = cli.main([
        "clear-force-change-password",
        "--username", user.username,
    ])
    assert rc == 0

    db_session.expire_all()
    refreshed = crud.get_user_by_id(db_session, user.id)
    assert refreshed.force_change_password is False
    # Passwort-Hash unverändert — der Operator hat NICHT umgepasswort.
    assert refreshed.password_hash == original_hash
    # Session lebt weiter — der laufende Tab kann einfach refresh drücken.
    assert db_session.scalar(
        select(models.Session).where(models.Session.user_id == user.id).limit(1)
    ) is not None


def test_cli_clear_force_change_password_idempotent(db_session, monkeypatch, capsys):
    """Doppelter Aufruf ist kein Fehler — der zweite Lauf meldet
    nur „bereits gelöst" und exit-0t."""
    user = crud.create_user(
        db_session,
        username=f"cli-already-{uuid.uuid4().hex[:8]}",
        password="already-clean-2026",
        is_admin=True,
        force_change_password=False,
    )

    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)

    rc = cli.main([
        "clear-force-change-password",
        "--username", user.username,
    ])
    assert rc == 0
    out = capsys.readouterr().out
    assert "bereits" in out.lower()


def test_cli_clear_force_change_password_unknown_user(db_session, monkeypatch):
    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)
    rc = cli.main([
        "clear-force-change-password",
        "--username", f"no-such-user-{uuid.uuid4().hex[:8]}",
    ])
    assert rc == 1


def test_cli_clear_force_change_password_default_to_single_admin(
    db_session, monkeypatch
):
    """Ohne ``--username`` greift dieselbe Regel wie bei
    ``reset-admin-password``: genau ein Admin → Treffer. In der Test-Suite
    leben mehrere Admin-Rows parallel, also testen wir nur den
    Mehrere-Admins-Pfad — das ist die Fail-Bedingung, die der Operator
    in der Praxis am ehesten sieht."""
    crud.create_user(
        db_session,
        username=f"cli-a-{uuid.uuid4().hex[:8]}",
        password="bootstrap-2026",
        is_admin=True,
        force_change_password=True,
    )
    crud.create_user(
        db_session,
        username=f"cli-b-{uuid.uuid4().hex[:8]}",
        password="bootstrap-2026",
        is_admin=True,
        force_change_password=True,
    )

    monkeypatch.setattr(cli, "SessionLocal", lambda: db_session)

    rc = cli.main(["clear-force-change-password"])
    assert rc == 1
