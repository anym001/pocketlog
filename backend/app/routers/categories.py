"""Category CRUD. Delete is blocked (409, DomainError) while a transaction,
goal or recurring rule still references the category."""

from fastapi import APIRouter, Response
from sqlalchemy.exc import IntegrityError

from .. import crud, errors, schemas
from ..deps import DB, ReadUser, WriteUser

router = APIRouter()


@router.get("/api/categories", response_model=list[schemas.CategoryOut])
def get_categories(user: ReadUser, db: DB):
    return crud.list_categories(db, user.id)


@router.post("/api/categories", response_model=schemas.CategoryOut, status_code=201)
def post_category(payload: schemas.CategoryCreate, user: WriteUser, db: DB):
    try:
        return crud.create_category(db, user.id, payload)
    except IntegrityError:
        raise errors.conflict("category exists")


@router.put("/api/categories/{category_id}", response_model=schemas.CategoryOut)
def put_category(
    category_id: int,
    payload: schemas.CategoryUpdate,
    user: WriteUser,
    db: DB,
):
    try:
        cat = crud.update_category(db, user.id, category_id, payload)
    except IntegrityError:
        raise errors.conflict("category exists")
    if cat is None:
        raise errors.not_found()
    return cat


@router.delete("/api/categories/{category_id}", status_code=204)
def remove_category(category_id: int, user: WriteUser, db: DB):
    # In-use / has-goal / has-recurring-rule are raised as DomainErrors and
    # mapped to 409 by the global handler.
    ok = crud.delete_category(db, user.id, category_id)
    if not ok:
        raise errors.not_found()
    return Response(status_code=204)
