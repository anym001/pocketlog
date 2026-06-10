"""User CRUD plus the admin-action target resolver.

``create_user`` seeds the default categories (via the categories module) and
the initial settings row in one commit, so a new account is never left in a
half-provisioned state.
"""

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import auth, exceptions, models
from .categories import _seed_default_categories
from .defaults import DEFAULT_CURRENCY, DEFAULT_LOCALE


def get_user_by_username(db: Session, username: str) -> models.User | None:
    return db.scalar(select(models.User).where(models.User.username == username))


def get_user_by_id(db: Session, user_id: int) -> models.User | None:
    return db.get(models.User, user_id)


def list_all_users(db: Session) -> list[models.User]:
    return list(db.scalars(select(models.User).order_by(models.User.id)))


def count_admins(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(models.User)
            .where(models.User.is_admin == True)  # noqa: E712
        )
        or 0
    )


def count_users(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(models.User)) or 0)


def get_oldest_user(db: Session) -> models.User | None:
    return db.scalar(select(models.User).order_by(models.User.id.asc()).limit(1))


def get_pending_admin(db: Session) -> models.User | None:
    """Liefert den Admin, der noch sein Passwort vergeben muss (z. B.
    nach der Migration). ``None`` wenn jeder Admin schon einen Hash
    hat oder gar kein Admin existiert."""
    return db.scalar(
        select(models.User)
        .where(models.User.is_admin == True)  # noqa: E712
        .where(models.User.password_hash.is_(None))
        .order_by(models.User.id.asc())
        .limit(1)
    )


def create_user(
    db: Session,
    *,
    username: str,
    password: str,
    is_admin: bool = False,
    force_change_password: bool = True,
    locale: str = DEFAULT_LOCALE,
    currency: str = DEFAULT_CURRENCY,
) -> models.User:
    """Legt einen neuen User samt Standard-Kategorien an. ``locale``
    bestimmt über das Primär-Subtag, in welcher Sprache die Default-
    Kategorien geseedet werden, und wird zusammen mit ``currency`` als
    initiale Settings-Zeile abgelegt (Admin-angelegte User erben so die
    Präferenzen des Admins). Wirft ``IntegrityError`` bei Username-
    Kollision."""
    user = models.User(
        username=username,
        password_hash=auth.hash_password(password),
        is_admin=is_admin,
        is_active=True,
        force_change_password=force_change_password,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(user)
    # Categories + the initial settings row share one commit so a new user is
    # never left with categories but no settings (or vice versa).
    _seed_default_categories(db, user.id, locale, commit=False)
    db.add(models.UserSettings(user_id=user.id, locale=locale, currency=currency))
    db.commit()
    return user


def set_user_password(
    db: Session, user: models.User, new_password: str, *, force_change: bool
) -> None:
    """Setzt ein neues Passwort und resettet den Brute-Force-State.
    ``force_change=True`` markiert den User für die Force-PW-View
    (Admin-Reset), ``False`` löst das Flag (normaler Self-Service-
    Change)."""
    user.password_hash = auth.hash_password(new_password)
    user.force_change_password = force_change
    user.failed_login_count = 0
    user.lockout_until = None
    db.commit()
    db.refresh(user)


def deactivate_user(db: Session, user: models.User) -> None:
    user.is_active = False
    db.commit()


def activate_user(db: Session, user: models.User) -> None:
    user.is_active = True
    # Brute-Force-State mit clearen: ein gesperrter, dann deaktivierter
    # User würde sonst nach dem Reaktivieren in einen ererbten Lockout
    # laufen, ohne dass ein Login-Versuch noch passt.
    user.failed_login_count = 0
    user.lockout_until = None
    db.commit()


def delete_user(db: Session, user: models.User) -> None:
    db.delete(user)
    db.commit()


def resolve_admin_target(
    db: Session,
    *,
    target_id: int,
    actor_id: int,
    allow_admin_target: bool,
) -> models.User:
    """Load the target user for an admin action and enforce the shared policy
    guards, raising typed ``DomainError``s that ``main`` maps to HTTP:

    - ``UserNotFoundError`` (404) — no such user.
    - ``CannotModifySelfError`` (403) — the admin targets their own account.
    - ``CannotModifyAdminError`` (403) — the admin targets another admin and
      the action does not permit it (``allow_admin_target=False``).

    The self-check runs before the admin-target check, matching the order the
    endpoints used inline. Audit logging stays in the endpoint layer.
    """
    target = get_user_by_id(db, target_id)
    if target is None:
        raise exceptions.UserNotFoundError()
    if target.id == actor_id:
        raise exceptions.CannotModifySelfError()
    if not allow_admin_target and target.is_admin:
        raise exceptions.CannotModifyAdminError()
    return target
