"""App-eigene Session-Auth.

Sammelt Passwort-Hashing, Session-Token-Verwaltung, CSRF-Generierung
und das Brute-Force-Backoff hinter einer schlanken Schnittstelle, damit
``main.py`` und ``crud.py`` schlank bleiben.

Threat-Model siehe ``CLAUDE.md`` und ``docs/SETUP.md``. Kurzfassung:
- SWAG + Authentik schützen die Domain (Forward-Auth). Diese Schicht
  authentifiziert *keinen* PocketLog-Account mehr.
- App-Session läuft über einen HttpOnly-Cookie mit opakem Token. Der
  DB-Eintrag hält nur den sha256-Hash, sodass ein DB-Leak nicht in
  einen Session-Hijack umgemünzt werden kann.
- CSRF-Schutz via Double-Submit-Cookie. Das CSRF-Token ist NICHT
  HttpOnly, JS liest es aus dem Cookie und schickt es als
  ``X-CSRF-Token``-Header bei jedem non-GET zurück.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHash, VerificationError, VerifyMismatchError
from sqlalchemy import delete, select
from sqlalchemy.orm import Session as DbSession

from . import models

# ---------------------------------------------------------------------
# Passwort-Hashing
# ---------------------------------------------------------------------

# Library-Defaults. Argon2-cffi pflegt diese Werte konservativ; bei
# Hardware-Upgrades kann ``needs_rehash`` später eine Migration triggern.
_hasher = PasswordHasher()

# Konstanter Hash für Login-Versuche gegen nicht existente User. Ohne
# diesen Dummy-Verify wäre der Code-Pfad „User existiert" sichtbar
# länger (Argon2 läuft ca. 50ms, der „kein User"-Pfad &lt; 1ms) — was
# Username-Enumeration via Timing trivial macht. Der Wert wird einmal
# beim Modul-Import erzeugt; sein Inhalt ist irrelevant.
_DUMMY_PASSWORD_HASH = _hasher.hash(
    "dummy-password-never-matched-by-real-users-" + secrets.token_hex(16)
)


def hash_password(plain: str) -> str:
    """Argon2id-Hash inkl. eingebetteter Salt und Parameter."""
    return _hasher.hash(plain)


def verify_password(plain: str, hashed: str | None) -> bool:
    """Verifiziert ein Passwort. Gibt ``False`` zurück bei jedem
    Fehlerzustand (NULL-Hash, Format-Fehler, Mismatch). Wirft nicht."""
    if hashed is None:
        return False
    try:
        _hasher.verify(hashed, plain)
        return True
    except (VerifyMismatchError, VerificationError, InvalidHash):
        return False


def verify_password_dummy() -> None:
    """Konstante-Zeit Argon2-Verify gegen einen Dummy-Hash. Wird beim
    Login-Versuch gegen nicht existente User aufgerufen, damit der
    Timing-Pfad gleich teuer ist wie der echte Verify."""
    try:
        _hasher.verify(_DUMMY_PASSWORD_HASH, "definitely-not-a-real-password")
    except (VerifyMismatchError, VerificationError, InvalidHash):
        # Erwartet — der Dummy-Hash matched nie.
        pass


# ---------------------------------------------------------------------
# Session-Tokens
# ---------------------------------------------------------------------


def generate_session_token() -> tuple[str, str]:
    """Erzeugt ein Session-Token. Gibt ``(plain, sha256_hex)`` zurück.

    ``plain`` landet im HttpOnly-Cookie des Clients, ``sha256_hex`` in
    der DB. Bei einem DB-Leak kann ein Angreifer das Klartext-Token
    aus dem Hash nicht rekonstruieren (Pre-Image-Resistenz).
    """
    plain = secrets.token_urlsafe(32)  # 32 random bytes → 43 url-safe chars
    digest = hashlib.sha256(plain.encode("ascii")).hexdigest()
    return plain, digest


def hash_session_token(plain: str) -> str:
    return hashlib.sha256(plain.encode("ascii")).hexdigest()


def generate_csrf_token() -> str:
    return secrets.token_hex(32)


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


# ---------------------------------------------------------------------
# Session-Lifetimes
# ---------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
        return v if v > 0 else default
    except ValueError:
        return default


SESSION_LIFETIME_HOURS = _env_int("SESSION_LIFETIME_HOURS", 24)
SESSION_REMEMBER_DAYS = _env_int("SESSION_REMEMBER_DAYS", 30)
SESSION_ABSOLUTE_DAYS = _env_int("SESSION_ABSOLUTE_DAYS", 7)
SESSION_REMEMBER_ABSOLUTE_DAYS = _env_int("SESSION_REMEMBER_ABSOLUTE_DAYS", 90)

# Schreib-Damper für Sliding-Refresh: erst nach ≥ 5 Minuten Inaktivität
# wird ``last_seen_at`` neu gesetzt. Verhindert einen DB-Write pro
# Request bei aktivem Tab.
REFRESH_GRACE_SECONDS = 5 * 60


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _sliding_lifetime(remember_me: bool) -> timedelta:
    if remember_me:
        return timedelta(days=SESSION_REMEMBER_DAYS)
    return timedelta(hours=SESSION_LIFETIME_HOURS)


def _absolute_lifetime(remember_me: bool) -> timedelta:
    if remember_me:
        return timedelta(days=SESSION_REMEMBER_ABSOLUTE_DAYS)
    return timedelta(days=SESSION_ABSOLUTE_DAYS)


def cookie_max_age_seconds(remember_me: bool) -> int:
    return int(_sliding_lifetime(remember_me).total_seconds())


def create_session(
    db: DbSession,
    user: models.User,
    *,
    remember_me: bool,
    user_agent: str | None,
) -> tuple[models.Session, str]:
    """Legt eine neue Session-Row an und gibt sie samt Klartext-Token
    zurück. Aufrufer setzt den Cookie."""
    plain, digest = generate_session_token()
    now = _utcnow()
    session = models.Session(
        user_id=user.id,
        token_hash=digest,
        csrf_token=generate_csrf_token(),
        created_at=now,
        last_seen_at=now,
        expires_at=now + _sliding_lifetime(remember_me),
        absolute_expires_at=now + _absolute_lifetime(remember_me),
        remember_me=remember_me,
        user_agent=(user_agent or "")[:255] or None,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session, plain


def get_session_by_token(db: DbSession, plain_token: str) -> models.Session | None:
    """Lookup nach Cookie-Wert. Liefert nur gültige (nicht-abgelaufene)
    Sessions; abgelaufene werden gleich beim Lookup verworfen, damit
    sich die ``sessions``-Tabelle nicht stillschweigend aufbläht."""
    if not plain_token:
        return None
    digest = hash_session_token(plain_token)
    session = db.scalar(
        select(models.Session).where(models.Session.token_hash == digest)
    )
    if session is None:
        return None
    now = _utcnow()
    if session.absolute_expires_at <= now or session.expires_at <= now:
        # Räumen wir gleich auf, damit das nächste Lookup nichts findet
        # und der nightly-Cleanup weniger zu tun hat.
        db.delete(session)
        db.commit()
        return None
    return session


def refresh_session_if_needed(db: DbSession, session: models.Session) -> bool:
    """Sliding-Refresh mit 5-Minuten-Damper, respektiert die absolute
    Obergrenze. Gibt zurück, ob sich der ``expires_at``-Wert geändert
    hat (so weiß der Caller, ob er einen neuen ``Set-Cookie`` schicken
    muss)."""
    now = _utcnow()
    if (now - session.last_seen_at).total_seconds() < REFRESH_GRACE_SECONDS:
        return False
    session.last_seen_at = now
    new_expires = min(
        now + _sliding_lifetime(session.remember_me),
        session.absolute_expires_at,
    )
    if new_expires == session.expires_at:
        db.commit()
        return False
    session.expires_at = new_expires
    db.commit()
    return True


def revoke_session(db: DbSession, session: models.Session) -> None:
    db.delete(session)
    db.commit()


def revoke_all_user_sessions(
    db: DbSession, user_id: int, *, except_id: int | None = None
) -> int:
    """Löscht alle Sessions eines Users. Wird bei Passwort-Change und
    Admin-Aktionen (Deaktivieren, Passwort-Reset, Löschen) aufgerufen."""
    stmt = delete(models.Session).where(models.Session.user_id == user_id)
    if except_id is not None:
        stmt = stmt.where(models.Session.id != except_id)
    result = db.execute(stmt)
    db.commit()
    return result.rowcount or 0


def cleanup_expired_sessions(db: DbSession) -> int:
    """Entfernt abgelaufene Sessions. Best-Effort, fehlerlos."""
    now = _utcnow()
    result = db.execute(delete(models.Session).where(models.Session.expires_at <= now))
    db.commit()
    return result.rowcount or 0


# ---------------------------------------------------------------------
# Brute-Force-Backoff
# ---------------------------------------------------------------------

# Erst ab dem N-ten Fehlversuch greift das Backoff. Vorher zählt die
# App nur — damit der gelegentliche „Vertippt"-Fall keinen Lockout
# auslöst.
LOCKOUT_THRESHOLD = 5
# Caps: Backoff verdoppelt sich, bis maximal 60s. Schmal genug um
# legitime User nicht zu blockieren, breit genug um automatisierte
# Probing-Tools auszubremsen.
LOCKOUT_MAX_SECONDS = 60


def current_lockout_seconds(user: models.User) -> int | None:
    """Wie viele Sekunden ist der Login für diesen User noch geblockt?
    ``None`` wenn nicht gesperrt, sonst Restzeit in Sekunden (≥ 1)."""
    if user.lockout_until is None:
        return None
    remaining = (user.lockout_until - _utcnow()).total_seconds()
    if remaining <= 0:
        return None
    return max(1, int(remaining))


def record_failed_login(db: DbSession, user: models.User) -> int | None:
    """Erhöht den Fehlversuchs-Counter und setzt ggf. einen neuen
    Lockout. Gibt die Lockout-Sekunden zurück, falls jetzt eine Sperre
    aktiv ist, sonst ``None``."""
    user.failed_login_count = (user.failed_login_count or 0) + 1
    n = user.failed_login_count
    if n >= LOCKOUT_THRESHOLD:
        # Exponentielles Backoff: 5 → 1s, 6 → 2s, … 11+ → 60s cap.
        seconds = min(LOCKOUT_MAX_SECONDS, 2 ** (n - LOCKOUT_THRESHOLD))
        user.lockout_until = _utcnow() + timedelta(seconds=seconds)
        db.commit()
        return seconds
    db.commit()
    return None


def clear_failed_login(db: DbSession, user: models.User) -> None:
    if user.failed_login_count or user.lockout_until:
        user.failed_login_count = 0
        user.lockout_until = None
        db.commit()
