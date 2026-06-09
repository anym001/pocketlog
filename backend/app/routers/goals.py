"""Goal CRUD. A goal is 1:1 with a category (uq_goals_user_category); a second
goal on the same category raises IntegrityError -> 409. Progress is derived in
the frontend, never stored."""

from fastapi import APIRouter, Response
from sqlalchemy.exc import IntegrityError

from .. import crud, errors, schemas
from ..deps import DB, CurrentUser

router = APIRouter()


@router.get("/api/goals", response_model=list[schemas.GoalOut])
def get_goals(user: CurrentUser, db: DB):
    return crud.list_goals(db, user.id)


@router.post("/api/goals", response_model=schemas.GoalOut, status_code=201)
def post_goal(payload: schemas.GoalCreate, user: CurrentUser, db: DB):
    try:
        return crud.create_goal(db, user.id, payload)
    except IntegrityError:
        raise errors.conflict("goal exists for category")


@router.put("/api/goals/{goal_id}", response_model=schemas.GoalOut)
def put_goal(
    goal_id: int,
    payload: schemas.GoalUpdate,
    user: CurrentUser,
    db: DB,
):
    try:
        goal = crud.update_goal(db, user.id, goal_id, payload)
    except IntegrityError:
        raise errors.conflict("goal exists for category")
    if goal is None:
        raise errors.not_found()
    return goal


@router.delete("/api/goals/{goal_id}", status_code=204)
def remove_goal(goal_id: int, user: CurrentUser, db: DB):
    ok = crud.delete_goal(db, user.id, goal_id)
    if not ok:
        raise errors.not_found()
    return Response(status_code=204)
