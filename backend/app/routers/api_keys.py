"""API key management endpoints.

Users can create bearer tokens with configurable scopes (import, read, write,
admin) for programmatic access. The raw token is returned once at creation and
never stored — subsequent requests use the SHA-256 hash stored in ``api_keys``.

Audit events are emitted for creation and revocation.
"""

import logging

from fastapi import APIRouter

from .. import crud, errors, schemas
from ..deps import DB, CurrentUser

router = APIRouter()
audit = logging.getLogger("pocketlog.audit")


@router.get("/api/api-keys", response_model=list[schemas.ApiKeyOut])
def list_api_keys(user: CurrentUser, db: DB) -> list:
    return crud.list_api_keys(db, user.id)


@router.post(
    "/api/api-keys", response_model=schemas.ApiKeyCreateResponse, status_code=201
)
def create_api_key(
    payload: schemas.ApiKeyCreate, user: CurrentUser, db: DB
) -> schemas.ApiKeyCreateResponse:
    api_key, raw_key = crud.create_api_key(db, user.id, payload.name, payload.scopes)
    audit.info(
        "api_key.create user_id=%s key_id=%s name=%r scopes=%r",
        user.id,
        api_key.id,
        api_key.name,
        payload.scopes,
    )
    return schemas.ApiKeyCreateResponse(
        id=api_key.id,
        name=api_key.name,
        scopes=payload.scopes,
        created_at=api_key.created_at,
        key=raw_key,
    )


@router.delete("/api/api-keys/{key_id}", status_code=204)
def revoke_api_key(key_id: int, user: CurrentUser, db: DB) -> None:
    deleted = crud.revoke_api_key(db, user.id, key_id)
    if not deleted:
        raise errors.not_found("api_key_not_found")
    audit.info("api_key.revoke user_id=%s key_id=%s", user.id, key_id)
