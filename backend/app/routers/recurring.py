"""Recurring-rule CRUD: the booking templates.

This manages only the templates. The catch-up engine (app.recurring)
materializes due occurrences on each /auth/me and /transactions read; those
triggers live in the auth and transactions routers, not here.
"""

import logging
from datetime import date as date_type

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError

from .. import crud, errors, schemas
from ..deps import DB, ReadUser, WriteUser
from ..logging_config import client_ip

audit = logging.getLogger("pocketlog.audit")

router = APIRouter()


@router.get("/api/recurring", response_model=list[schemas.RecurringRuleOut])
def get_recurring(user: ReadUser, db: DB):
    return crud.list_recurring_rules(db, user.id)


@router.post(
    "/api/recurring",
    response_model=schemas.RecurringRuleCreateResponse,
    status_code=201,
)
def post_recurring(
    payload: schemas.RecurringRuleCreate,
    request: Request,
    user: WriteUser,
    db: DB,
):
    try:
        rule, count = crud.create_recurring_rule(
            db, user.id, payload, today=date_type.today()
        )
    except IntegrityError:
        raise errors.conflict("rule name exists")
    audit.info(
        "recurring.create id=%s rule_id=%s freq=%s interval=%s materialized=%s ip=%s",
        user.id,
        rule.id,
        rule.frequency,
        rule.interval,
        count,
        client_ip(request),
    )
    return schemas.RecurringRuleCreateResponse(
        rule=schemas.RecurringRuleOut.model_validate(rule),
        materialized_count=count,
    )


@router.put(
    "/api/recurring/{rule_id}",
    response_model=schemas.RecurringRuleOut,
)
def put_recurring(
    rule_id: int,
    payload: schemas.RecurringRuleUpdate,
    request: Request,
    user: WriteUser,
    db: DB,
):
    try:
        rule = crud.update_recurring_rule(db, user.id, rule_id, payload)
    except IntegrityError:
        raise errors.conflict("rule name exists")
    if rule is None:
        raise errors.not_found()
    audit.info(
        "recurring.update id=%s rule_id=%s ip=%s",
        user.id,
        rule_id,
        client_ip(request),
    )
    return rule


@router.delete("/api/recurring/{rule_id}", status_code=204)
def remove_recurring(rule_id: int, request: Request, user: WriteUser, db: DB):
    if not crud.delete_recurring_rule(db, user.id, rule_id):
        raise errors.not_found()
    audit.info(
        "recurring.delete id=%s rule_id=%s ip=%s",
        user.id,
        rule_id,
        client_ip(request),
    )
    return Response(status_code=204)


@router.post(
    "/api/recurring/{rule_id}/skip-next",
    response_model=schemas.RecurringSkipOut,
)
def post_recurring_skip_next(rule_id: int, user: WriteUser, db: DB):
    result = crud.skip_next_occurrence(db, user.id, rule_id)
    if result is None:
        raise errors.not_found()
    skipped, nxt = result
    return schemas.RecurringSkipOut(skipped_date=skipped, next_occurrence_date=nxt)


@router.delete("/api/recurring/{rule_id}/skip/{skip_date}", status_code=204)
def remove_recurring_skip(rule_id: int, skip_date: str, user: WriteUser, db: DB):
    try:
        d = date_type.fromisoformat(skip_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid date")
    if not crud.remove_skip(db, user.id, rule_id, d):
        raise errors.not_found()
    return Response(status_code=204)
