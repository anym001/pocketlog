"""User settings: the server-side backup of the localStorage UI preferences.

The frontend paints from localStorage and reconciles with this endpoint pair
in the background, so it survives iOS-side localStorage eviction.
"""

from fastapi import APIRouter

from .. import crud, schemas
from ..deps import DB, CurrentUser

router = APIRouter()


@router.get("/api/settings", response_model=schemas.SettingsOut)
def get_settings(user: CurrentUser, db: DB):
    return crud.get_or_create_settings(db, user.id)


@router.put("/api/settings", response_model=schemas.SettingsOut)
def put_settings(payload: schemas.SettingsUpdate, user: CurrentUser, db: DB):
    return crud.update_settings(db, user.id, payload)
