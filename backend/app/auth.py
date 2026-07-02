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
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session as DbSession

from . import models
from .constants import LOCKOUT_MAX_SECONDS, LOCKOUT_THRESHOLD
from .db_retry import is_retryable_operational_error

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


def maybe_rehash_password(db: DbSession, user: models.User, plain: str) -> bool:
    """Transparenter Hash-Upgrade nach einem *erfolgreichen* Verify.

    ``check_needs_rehash`` vergleicht die im Hash eingebetteten Parameter
    (time/memory cost, Parallelität, Salz-/Hash-Länge) mit den aktuellen
    Library-Defaults. Hebt argon2-cffi seine Defaults an, wandern Bestands-
    Hashes so beim nächsten Login auf die neuen Kosten — ohne diesen Hook
    blieben sie für immer auf den alten. Nur hier ist das Klartext-Passwort
    legitim verfügbar. Gibt zurück, ob neu gehasht wurde."""
    if user.password_hash is None:
        return False
    try:
        if not _hasher.check_needs_rehash(user.password_hash):
            return False
    except InvalidHash:
        # Kaputtes Format hätte verify_password bereits abgelehnt; hier
        # defensiv, damit der Login-Pfad nie an Housekeeping scheitert.
        return False
    user.password_hash = _hasher.hash(plain)
    db.commit()
    return True


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
    changed = new_expires != session.expires_at
    if changed:
        session.expires_at = new_expires
    try:
        db.commit()
    except OperationalError as exc:
        # Best-effort sliding refresh. This UPDATE targets the caller's own
        # session row and runs on *every* request, so under a burst of
        # concurrent requests — the offline outbox reconnecting and replaying
        # queued writes is the classic trigger — an optimistic-locking engine
        # (Galera and friends) can raise a transient row-conflict (1020) here.
        # Housekeeping must never fail the request: skip this refresh, keep
        # the still-valid session, and let the next request try again. A real
        # (non-transient) DB error still propagates.
        if not is_retryable_operational_error(exc):
            raise
        db.rollback()
        return False
    return changed


def list_user_sessions(db: DbSession, user_id: int) -> list[models.Session]:
    """Alle (nicht abgelaufenen) Sessions eines Users, jüngste Aktivität
    zuerst. Abgelaufene Rows blendet die Query aus statt sie zu löschen —
    das Aufräumen bleibt beim gedämpften Cleanup bzw. beim Lookup."""
    now = _utcnow()
    return list(
        db.scalars(
            select(models.Session)
            .where(
                models.Session.user_id == user_id,
                models.Session.expires_at > now,
                models.Session.absolute_expires_at > now,
            )
            .order_by(models.Session.last_seen_at.desc(), models.Session.id.desc())
        )
    )


def get_user_session(
    db: DbSession, user_id: int, session_id: int
) -> models.Session | None:
    """User-scoped Lookup einer einzelnen Session-Row (für den Self-Service-
    Revoke). Fremde IDs liefern None — derselbe 404-Pfad wie eine unbekannte,
    damit die Existenz fremder Sessions nicht leakt."""
    session = db.get(models.Session, session_id)
    if session is None or session.user_id != user_id:
        return None
    return session


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


# An expired session is also pruned lazily the moment it's looked up again
# (get_session_by_token), but a device that's simply never used again would
# otherwise sit in the table forever. There's no separate cron/scheduler in
# this deployment (single container, see CLAUDE.md), so this runs
# opportunistically on the request path instead — damped like the sliding
# refresh above, so it's one DELETE per process per interval, not per request.
SESSION_CLEANUP_INTERVAL_SECONDS = 60 * 60
_last_session_cleanup_at: datetime | None = None


def maybe_cleanup_expired_sessions(db: DbSession) -> int:
    """Runs ``cleanup_expired_sessions`` at most once per
    ``SESSION_CLEANUP_INTERVAL_SECONDS`` for this process."""
    global _last_session_cleanup_at
    now = _utcnow()
    if (
        _last_session_cleanup_at is not None
        and (now - _last_session_cleanup_at).total_seconds()
        < SESSION_CLEANUP_INTERVAL_SECONDS
    ):
        return 0
    _last_session_cleanup_at = now
    return cleanup_expired_sessions(db)


# ---------------------------------------------------------------------
# Brute-Force-Backoff
# ---------------------------------------------------------------------

# Brute-force backoff knobs (LOCKOUT_THRESHOLD / LOCKOUT_MAX_SECONDS) live in
# app.constants and are imported at the top of this module.


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
