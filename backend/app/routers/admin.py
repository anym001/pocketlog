"""Admin user management plus the user-self-service data-reset endpoints.

The self-/admin-target guards live in crud.resolve_admin_target; this layer
adds the audit events. The two data-reset endpoints are user-self-service
despite their /api/admin/* path — the path is kept for backwards-compat with
already-queued IndexedDB outbox entries (renaming would orphan those).
"""

import logging

from fastapi import APIRouter, Request, Response
from sqlalchemy.exc import IntegrityError

from .. import auth, crud, errors, models, schemas
from ..deps import DB, AdminUser, CurrentUser
from ..logging_config import client_ip

audit = logging.getLogger("pocketlog.audit")

router = APIRouter()


def _user_to_admin_out(user: models.User) -> schemas.AdminUserOut:
    return schemas.AdminUserOut(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        is_active=user.is_active,
        force_change_password=user.force_change_password,
        locked_until=user.lockout_until,
        created_at=user.created_at,
    )


@router.get("/api/admin/users", response_model=list[schemas.AdminUserOut])
def admin_list_users(db: DB, _admin: AdminUser):
    return [_user_to_admin_out(u) for u in crud.list_all_users(db)]


@router.post(
    "/api/admin/users",
    response_model=schemas.AdminUserOut,
    status_code=201,
)
def admin_create_user(
    payload: schemas.AdminUserCreate, request: Request, db: DB, _admin: AdminUser
):
    # New users inherit the creating admin's language + currency so their
    # default categories are seeded in the admin's language and the app
    # opens in the same locale (the admin can't know the user's own
    # preference yet; the user can change it later in Settings).
    admin_settings = crud.get_or_create_settings(db, _admin.id)
    try:
        user = crud.create_user(
            db,
            username=payload.username,
            password=payload.password,
            is_admin=False,
            force_change_password=True,
            locale=admin_settings.locale,
            currency=admin_settings.currency,
        )
    except IntegrityError:
        raise errors.conflict("username_taken")
    audit.info(
        "admin.user.create actor_admin_id=%s new_user_id=%s username=%s ip=%s",
        _admin.id,
        user.id,
        user.username,
        client_ip(request),
    )
    return _user_to_admin_out(user)


@router.post("/api/admin/users/{user_id}/reset-password", status_code=204)
def admin_reset_password(
    user_id: int,
    payload: schemas.AdminPasswordReset,
    request: Request,
    db: DB,
    admin: AdminUser,
):
    # Self-reset would dump the admin into the force-change view and revoke
    # all their own sessions — an instant self-lockout. Resetting another
    # admin is allowed; only self is blocked (allow_admin_target=True).
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=True
    )
    crud.set_user_password(db, target, payload.new_password, force_change=True)
    # Sicherheit: alle Sessions des betroffenen Users wegwerfen, damit
    # ein bereits eingeloggter Tab nicht weiterläuft.
    revoked = auth.revoke_all_user_sessions(db, target.id)
    audit.info(
        "auth.password.reset_admin actor_admin_id=%s target_id=%s "
        "ip=%s revoked_count=%s",
        admin.id,
        target.id,
        client_ip(request),
        revoked,
    )
    return Response(status_code=204)


@router.post("/api/admin/users/{user_id}/deactivate", status_code=204)
def admin_deactivate(user_id: int, request: Request, db: DB, admin: AdminUser):
    # Neither self nor another admin: deactivating an admin could leave the
    # instance with zero admins.
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=False
    )
    crud.deactivate_user(db, target)
    revoked = auth.revoke_all_user_sessions(db, target.id)
    audit.info(
        "admin.user.deactivate actor_admin_id=%s target_id=%s ip=%s revoked_count=%s",
        admin.id,
        target.id,
        client_ip(request),
        revoked,
    )
    return Response(status_code=204)


@router.post("/api/admin/users/{user_id}/activate", status_code=204)
def admin_activate(user_id: int, request: Request, db: DB, admin: AdminUser):
    # Self is always active (else this admin wouldn't be here); reactivating
    # another admin is fine, so only self is blocked.
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=True
    )
    crud.activate_user(db, target)
    audit.info(
        "admin.user.activate actor_admin_id=%s target_id=%s ip=%s",
        admin.id,
        target.id,
        client_ip(request),
    )
    return Response(status_code=204)


@router.delete("/api/admin/users/{user_id}", status_code=204)
def admin_delete_user(user_id: int, request: Request, db: DB, admin: AdminUser):
    # Symmetric with deactivate: neither self nor another admin may be
    # deleted, keeping the admin-count invariant intact.
    target = crud.resolve_admin_target(
        db, target_id=user_id, actor_id=admin.id, allow_admin_target=False
    )
    crud.delete_user(db, target)
    audit.info(
        "admin.user.delete actor_admin_id=%s target_id=%s ip=%s",
        admin.id,
        target.id,
        client_ip(request),
    )
    return Response(status_code=204)


# ---------------------------------------------------------------------
# Data management (user-self-service despite the /api/admin path)
# ---------------------------------------------------------------------
# Bulk reset operations the user triggers from the Verwaltung drawer.
# User row and user_settings are preserved either way.


@router.delete("/api/admin/transactions", status_code=204)
def reset_transactions(request: Request, user: CurrentUser, db: DB):
    count = crud.delete_all_transactions(db, user.id)
    audit.info(
        "data.reset_transactions id=%s ip=%s deleted_count=%s",
        user.id,
        client_ip(request),
        count,
    )
    return Response(status_code=204)


@router.delete("/api/admin/all-data", status_code=204)
def reset_all_data(request: Request, user: CurrentUser, db: DB):
    crud.delete_all_user_data(db, user.id)
    audit.info(
        "data.reset_all_data id=%s ip=%s",
        user.id,
        client_ip(request),
    )
    return Response(status_code=204)
