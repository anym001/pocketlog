"""Passwort-Policy: 12 Zeichen + Großbuchstabe + Kleinbuchstabe + Zahl +
Sonderzeichen. Greift auf jedem „neuen" Passwort (Setup, Self-Change,
Admin-Create, Admin-Reset) — Login-Passwort bleibt absichtlich ungeprüft,
damit das Backend keinen Hinweis leakt, was am Input formal falsch war."""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pydantic_core import PydanticCustomError

from app import schemas

from .conftest import TEST_PASSWORD

# ── Reine Validator-Funktion ──────────────────────────────────────────────


@pytest.mark.parametrize(
    "value",
    [
        "Valid-password-2026",  # Standard-Happy-Case
        "MixedCase123!",  # genau die vier Klassen
        "Pässwörter-für-2026",  # Umlaute zählen als Buchstaben, ß auch
        "AaaaaaaaaaaaaaaA1!",  # exakt 12+ inkl. doppelter Buchstabenklassen
    ],
)
def test_validate_password_complexity_accepts_valid(value):
    assert schemas.validate_password_complexity(value) == value


@pytest.mark.parametrize(
    "value, missing",
    [
        ("nur-kleinbuchstaben-1!", "upper"),
        ("NUR-GROSSBUCHSTABEN-1!", "lower"),
        ("Ohne-Zahl-Wirklich!", "digit"),
        ("OhneSonderzeichen1234", "special"),
    ],
)
def test_validate_password_complexity_rejects_missing_class(value, missing):
    # Stable machine code + missing-class codes in context (no German prose),
    # so the frontend can translate the 422.
    with pytest.raises(PydanticCustomError) as exc:
        schemas.validate_password_complexity(value)
    assert exc.value.type == "password_complexity"
    assert missing in str(exc.value)


def test_validate_password_complexity_lists_all_missing_classes():
    """Wenn mehrere Klassen fehlen, nennt der Kontext alle Klassen-Codes —
    das Frontend kann daraus die passende Meldung bauen."""
    with pytest.raises(PydanticCustomError) as exc:
        schemas.validate_password_complexity("abcdefghijkl")
    msg = str(exc.value)
    assert "upper" in msg
    assert "digit" in msg
    assert "special" in msg


# ── Schema-Integration: NewPassword via SetupRequest ──────────────────────


def test_setup_request_rejects_password_without_uppercase():
    with pytest.raises(ValidationError) as exc:
        schemas.SetupRequest(username="ok", password="nur-klein-1234!")
    # Stable code surfaces in the ValidationError; missing class in context.
    assert "password_complexity" in str(exc.value)
    assert "upper" in str(exc.value)


def test_setup_request_rejects_password_too_short_with_clear_error():
    """Zu kurz hat Vorrang vor der Klassen-Prüfung — Pydantic prüft
    ``Field(min_length=...)`` zuerst. Nicht super wichtig, aber wir
    pinnen das Verhalten, damit zukünftige Refactors es nicht unbemerkt
    drehen."""
    with pytest.raises(ValidationError) as exc:
        schemas.SetupRequest(username="ok", password="Ab1!")
    assert "12" in str(exc.value) or "short" in str(exc.value).lower()


def test_change_password_request_enforces_policy_on_new_password():
    with pytest.raises(ValidationError):
        schemas.ChangePasswordRequest(
            current_password=TEST_PASSWORD,
            new_password="missing-special-class-1234",  # kein Großbuchstabe
        )


def test_admin_user_create_enforces_policy():
    with pytest.raises(ValidationError):
        schemas.AdminUserCreate(username="newone", password="too-simple-pw-1234")


def test_admin_password_reset_enforces_policy():
    with pytest.raises(ValidationError):
        schemas.AdminPasswordReset(new_password="too-simple-pw-1234")


# ── HTTP-Endpoint sieht das auch ──────────────────────────────────────────


def test_setup_endpoint_returns_422_on_weak_password(app, db_session):
    """Defense-in-Depth: der Pydantic-Validator stoppt schwache Passwörter
    bereits am Wire — das Backend bekommt sie gar nicht erst zu sehen."""
    from app import models

    # Setup-Modus aktivieren — alle User löschen.
    db_session.query(models.User).delete()
    db_session.commit()

    fresh = TestClient(app)
    res = fresh.post(
        "/api/auth/setup",
        json={
            "username": f"admin-{uuid.uuid4().hex[:8]}",
            "password": "missing-uppercase-1!",
        },
    )
    assert res.status_code == 422
