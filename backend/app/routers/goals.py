"""Goal CRUD. A goal is 1:1 with a category (uq_goals_user_category); a second
goal on the same category raises IntegrityError -> 409. Progress is derived in
the frontend, never stored."""

import logging

from fastapi import APIRouter, Request, Response
from sqlalchemy.exc import IntegrityError

from .. import crud, errors, schemas
from ..deps import DB, ReadUser, WriteUser
from ..logging_config import client_ip

audit = logging.getLogger("pocketlog.audit")

router = APIRouter()


@router.get("/api/goals", response_model=list[schemas.GoalOut])
def get_goals(user: ReadUser, db: DB):
    return crud.list_goals(db, user.id)


@router.post("/api/goals", response_model=schemas.GoalOut, status_code=201)
def post_goal(payload: schemas.GoalCreate, request: Request, user: WriteUser, db: DB):
    try:
        goal = crud.create_goal(db, user.id, payload)
    except IntegrityError:
        raise errors.conflict("goal exists for category")
    audit.info(
        "goal.create id=%s goal_id=%s category_id=%s direction=%s ip=%s",
        user.id,
        goal.id,
        goal.category_id,
        goal.direction,
        client_ip(request),
    )
    return goal


@router.put("/api/goals/{goal_id}", response_model=schemas.GoalOut)
def put_goal(
    goal_id: int,
    payload: schemas.GoalUpdate,
    request: Request,
    user: WriteUser,
    db: DB,
):
    try:
        goal = crud.update_goal(db, user.id, goal_id, payload)
    except IntegrityError:
        raise errors.conflict("goal exists for category")
    if goal is None:
        raise errors.not_found()
    audit.info(
        "goal.update id=%s goal_id=%s ip=%s",
        user.id,
        goal_id,
        client_ip(request),
    )
    return goal


@router.delete("/api/goals/{goal_id}", status_code=204)
def remove_goal(goal_id: int, request: Request, user: WriteUser, db: DB):
    if not crud.delete_goal(db, user.id, goal_id):
        raise errors.not_found()
    audit.info(
        "goal.delete id=%s goal_id=%s ip=%s",
        user.id,
        goal_id,
        client_ip(request),
    )
    return Response(status_code=204)
