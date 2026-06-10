"""Tag CRUD. Rename propagates across all transactions (see crud.rename_tag)."""

from fastapi import APIRouter, Response
from sqlalchemy.exc import IntegrityError

from .. import crud, errors, schemas
from ..deps import DB, ReadUser, WriteUser

router = APIRouter()


@router.get("/api/tags", response_model=list[schemas.TagOut])
def get_tags(user: ReadUser, db: DB):
    return crud.list_tags(db, user.id)


@router.post("/api/tags", status_code=201)
def post_tag(payload: schemas.TagCreate, user: WriteUser, db: DB):
    try:
        tag = crud.create_tag(db, user.id, payload.name)
    except IntegrityError:
        raise errors.conflict("tag exists")
    return {"name": tag.name}


@router.put("/api/tags/{name}")
def put_tag(name: str, payload: schemas.TagRename, user: WriteUser, db: DB):
    try:
        affected = crud.rename_tag(db, user.id, name, payload.new_name)
    except IntegrityError:
        raise errors.conflict("tag exists")
    return {"affected": affected}


@router.delete("/api/tags/{name}", status_code=204)
def remove_tag(name: str, user: WriteUser, db: DB):
    crud.delete_tag(db, user.id, name)
    return Response(status_code=204)
