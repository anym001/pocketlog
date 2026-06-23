"""Budgets (per-category spending caps) API coverage.

Mirrors the goals test conventions: each test runs as a fresh user via the
``client``/``regular_user`` fixtures and trusts the user_id-scoped CRUD for
isolation. Budget consumption is computed client-side (the API stores only
the raw fields), so these tests cover the CRUD surface, the 1:1 category
constraint, validation, ownership/isolation, CSRF and the cascade/guard
behaviour — not usage maths.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD
from .conftest import new_category as _new_category
from .conftest import other_client as _other_client


def _budget_payload(category_id: int, **over) -> dict:
    body = {
        "category_id": category_id,
        "amount": "300.00",
        "frequency": "monthly",
    }
    body.update(over)
    return body


def _new_category_with_csrf(client, csrf: str) -> int:
    r = client.post(
        "/api/categories",
        headers={"X-CSRF-Token": csrf},
        json={
            "name": f"Cat-{uuid.uuid4().hex[:8]}",
            "icon": "house",
            "color": "#123456",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_budget_crud_roundtrip(client):
    cat = _new_category(client)
    create = client.post("/api/budgets", json=_budget_payload(cat))
    assert create.status_code == 201, create.text
    budget = create.json()
    budget_id = budget["id"]
    assert budget["category_id"] == cat
    assert budget["frequency"] == "monthly"
    assert budget["amount"] == "300.00"

    listed = client.get("/api/budgets")
    assert listed.status_code == 200
    assert any(b["id"] == budget_id for b in listed.json())

    update = client.put(
        f"/api/budgets/{budget_id}",
        json=_budget_payload(cat, amount="450.00", frequency="quarterly"),
    )
    assert update.status_code == 200
    assert update.json()["amount"] == "450.00"
    assert update.json()["frequency"] == "quarterly"

    delete = client.delete(f"/api/budgets/{budget_id}")
    assert delete.status_code == 204
    assert all(b["id"] != budget_id for b in client.get("/api/budgets").json())


def test_one_budget_per_category(client):
    cat_a = _new_category(client)
    cat_b = _new_category(client)
    first = client.post("/api/budgets", json=_budget_payload(cat_a))
    assert first.status_code == 201
    # Second budget on the same category → 409.
    dup = client.post("/api/budgets", json=_budget_payload(cat_a))
    assert dup.status_code == 409
    # A different category is fine.
    other = client.post("/api/budgets", json=_budget_payload(cat_b))
    assert other.status_code == 201


def test_budget_and_goal_coexist_on_one_category(client):
    """A category may carry both a goal and a budget — independent features."""
    cat = _new_category(client)
    goal = client.post(
        "/api/goals",
        json={
            "name": "Urlaubskasse",
            "direction": "save_up",
            "category_id": cat,
            "initial_amount": "0.00",
            "target_amount": "1000.00",
            "start_date": "2026-01-01",
        },
    )
    assert goal.status_code == 201, goal.text
    budget = client.post("/api/budgets", json=_budget_payload(cat))
    assert budget.status_code == 201, budget.text


def test_budget_amount_must_be_positive(client):
    cat = _new_category(client)
    assert (
        client.post(
            "/api/budgets", json=_budget_payload(cat, amount="0.00")
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/budgets", json=_budget_payload(cat, amount="-10.00")
        ).status_code
        == 422
    )


def test_budget_frequency_must_be_known(client):
    cat = _new_category(client)
    r = client.post("/api/budgets", json=_budget_payload(cat, frequency="weekly"))
    assert r.status_code == 422


def test_budget_on_foreign_category_rejected(app, client, db_session):
    """A budget may not reference another user's category."""
    other_client = _other_client(app, db_session)
    foreign_cat = _new_category(other_client)

    r = client.post("/api/budgets", json=_budget_payload(foreign_cat))
    assert r.status_code == 422


def test_budgets_are_user_scoped(app, client, db_session):
    """User A's budgets never appear in user B's list."""
    cat = _new_category(client)
    mine = client.post("/api/budgets", json=_budget_payload(cat))
    assert mine.status_code == 201
    my_budget_id = mine.json()["id"]

    other_client = _other_client(app, db_session)

    assert other_client.get("/api/budgets").json() == []
    # Cross-user mutation is a 404, not someone else's row.
    assert other_client.delete(f"/api/budgets/{my_budget_id}").status_code == 404


def test_budget_post_requires_csrf(app, regular_user):
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200
    csrf = res.json()["user"]["csrf_token"]
    cat = _new_category_with_csrf(client, csrf)
    no_csrf = client.post("/api/budgets", json=_budget_payload(cat))
    assert no_csrf.status_code == 403
    created = client.post(
        "/api/budgets", headers={"X-CSRF-Token": csrf}, json=_budget_payload(cat)
    )
    assert created.status_code == 201
    bid = created.json()["id"]
    assert (
        client.put(f"/api/budgets/{bid}", json=_budget_payload(cat)).status_code == 403
    )
    assert client.delete(f"/api/budgets/{bid}").status_code == 403


def test_deleting_category_with_budget_is_blocked(client):
    cat = _new_category(client)
    created = client.post("/api/budgets", json=_budget_payload(cat))
    assert created.status_code == 201
    budget_id = created.json()["id"]

    blocked = client.delete(f"/api/categories/{cat}")
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "category has budget"

    # Once the budget is gone, the category can be deleted.
    assert client.delete(f"/api/budgets/{budget_id}").status_code == 204
    assert client.delete(f"/api/categories/{cat}").status_code == 204


def test_budgets_require_authentication(app):
    """Every budgets endpoint rejects an unauthenticated client."""
    anon = TestClient(app)
    assert anon.get("/api/budgets").status_code == 401
    assert anon.post("/api/budgets", json=_budget_payload(1)).status_code == 401
    assert anon.put("/api/budgets/1", json=_budget_payload(1)).status_code == 401
    assert anon.delete("/api/budgets/1").status_code == 401


def test_update_unknown_budget_is_404(client):
    cat = _new_category(client)
    r = client.put("/api/budgets/99999999", json=_budget_payload(cat))
    assert r.status_code == 404


def test_delete_unknown_budget_is_404(client):
    assert client.delete("/api/budgets/99999999").status_code == 404


def test_update_foreign_budget_is_404(app, client, db_session):
    """A user cannot update another user's budget (no cross-user write)."""
    cat = _new_category(client)
    mine = client.post("/api/budgets", json=_budget_payload(cat))
    bid = mine.json()["id"]

    other_client = _other_client(app, db_session)
    foreign_cat = _new_category(other_client)
    assert (
        other_client.put(
            f"/api/budgets/{bid}", json=_budget_payload(foreign_cat)
        ).status_code
        == 404
    )


def test_update_to_foreign_category_rejected(app, client, db_session):
    """PUT validates category ownership too, not just POST."""
    cat = _new_category(client)
    bid = client.post("/api/budgets", json=_budget_payload(cat)).json()["id"]

    other_client = _other_client(app, db_session)
    foreign_cat = _new_category(other_client)

    r = client.put(f"/api/budgets/{bid}", json=_budget_payload(foreign_cat))
    assert r.status_code == 422


def test_update_moving_budget_onto_taken_category_409(client):
    """Moving budget B onto a category that already has budget A → 409."""
    cat_a = _new_category(client)
    cat_b = _new_category(client)
    client.post("/api/budgets", json=_budget_payload(cat_a))
    bid_b = client.post("/api/budgets", json=_budget_payload(cat_b)).json()["id"]
    r = client.put(f"/api/budgets/{bid_b}", json=_budget_payload(cat_a))
    assert r.status_code == 409


def test_user_delete_cascades_budgets(db_session):
    """Deleting a user removes their budgets (ORM + FK cascade)."""
    from app import crud, models
    from app.schemas import BudgetCreate

    user = crud.create_user(
        db_session,
        username=f"cascade-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    cat = crud.list_categories(db_session, user.id)[0]
    crud.create_budget(
        db_session,
        user.id,
        BudgetCreate(
            category_id=cat.id,
            amount="300.00",
            frequency="monthly",
        ),
    )
    uid = user.id
    assert crud.list_budgets(db_session, uid)
    crud.delete_user(db_session, user)
    db_session.expire_all()
    assert (
        db_session.query(models.Budget).filter(models.Budget.user_id == uid).count()
        == 0
    )
