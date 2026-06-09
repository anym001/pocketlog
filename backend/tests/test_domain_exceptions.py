"""Pins the domain-exception -> HTTP contract.

The CRUD layer raises typed ``DomainError`` subclasses; a single handler in
``main`` maps them to HTTP responses by reading ``status_code``/``detail`` off
the exception. These statuses and detail strings are a public contract the
frontend translates, so they must not drift. This module locks them down at
two levels:

1. Unit: every subclass carries the exact ``status_code`` + ``detail`` it has
   always produced.
2. Integration: the registered handler turns a raised ``DomainError`` into the
   matching HTTP response (same status, ``{"detail": ...}`` body) for the
   paths reachable through the API.
"""

from datetime import date
from decimal import Decimal

import pytest

from app import exceptions

# (subclass, expected status, expected detail) — the full, frozen contract.
DOMAIN_CONTRACT = [
    (exceptions.CategoryNotFoundError, 422, "category not found"),
    (exceptions.CategoryInUseError, 409, "category in use"),
    (exceptions.CategoryHasGoalError, 409, "category has goal"),
    (exceptions.CategoryHasRecurringRuleError, 409, "category has recurring rule"),
    (exceptions.BackdateTooFarError, 422, "backdate too far"),
    (exceptions.UnknownCategoryError, 400, "unknown_category"),
    (exceptions.EmptyNameError, 400, "empty_name"),
    (exceptions.UserNotFoundError, 404, "user_not_found"),
    (exceptions.CannotModifySelfError, 403, "cannot_modify_self"),
    (exceptions.CannotModifyAdminError, 403, "cannot_modify_admin"),
]


@pytest.mark.parametrize("exc_cls, status, detail", DOMAIN_CONTRACT)
def test_subclass_carries_status_and_detail(exc_cls, status, detail):
    exc = exc_cls()
    assert isinstance(exc, exceptions.DomainError)
    assert exc.status_code == status
    assert exc.detail == detail


def test_domain_error_is_not_a_value_error():
    # DomainError must bypass any incidental `except ValueError` and reach the
    # dedicated handler.
    assert not issubclass(exceptions.DomainError, ValueError)


def test_handler_registered_for_domain_error(app):
    # The single handler is keyed on the base class, so every subclass routes
    # through it.
    assert exceptions.DomainError in app.exception_handlers


def test_unknown_category_on_transaction_maps_to_400(authed_client):
    res = authed_client.post(
        "/api/transactions",
        json={
            "amount": "5.00",
            "category_id": 9_999_999,
            "date": date.today().isoformat(),
            "type": "out",
        },
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "unknown_category"


def test_category_not_found_on_goal_maps_to_422(authed_client):
    res = authed_client.post(
        "/api/goals",
        json={
            "name": "Holiday",
            "direction": "save_up",
            "category_id": 9_999_999,
            "initial_amount": "0",
            "target_amount": "100.00",
            "start_date": date.today().isoformat(),
        },
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "category not found"


def test_category_in_use_on_delete_maps_to_409(authed_client, regular_user, db_session):
    from app import crud, schemas

    cat = crud.create_category(
        db_session,
        regular_user.id,
        schemas.CategoryCreate(name="DeleteMe", icon="package", color="#9e9b96"),
    )
    crud.create_transaction(
        db_session,
        regular_user.id,
        schemas.TransactionCreate(
            amount=Decimal("1.00"),
            category_id=cat.id,
            date=date.today(),
            type="out",
        ),
    )
    res = authed_client.delete(f"/api/categories/{cat.id}")
    assert res.status_code == 409
    assert res.json()["detail"] == "category in use"
