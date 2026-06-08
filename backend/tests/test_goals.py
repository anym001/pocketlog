"""Goals (savings + debt tracker) API coverage.

Mirrors the smoke/validation/csrf conventions: each test runs as a fresh
user via the ``client``/``authed_client`` fixtures and trusts the
user_id-scoped CRUD for isolation. Goal progress is computed client-side
(the API stores only the raw fields), so these tests cover the CRUD
surface, the 1:1 category constraint, validation, ownership/isolation,
CSRF and the cascade/guard behaviour — not progress maths.
"""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from .conftest import TEST_PASSWORD


def _new_category(client, name: str | None = None) -> int:
    name = name or f"Cat-{uuid.uuid4().hex[:8]}"
    r = client.post(
        "/api/categories",
        json={"name": name, "icon": "house", "color": "#123456"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _savings_payload(category_id: int, **over) -> dict:
    body = {
        "name": "Urlaubskasse",
        "direction": "save_up",
        "category_id": category_id,
        "initial_amount": "0.00",
        "target_amount": "1000.00",
        "start_date": "2026-01-01",
        "icon": "piggy-bank",
        "color": "#2a78d8",
    }
    body.update(over)
    return body


def _debt_payload(category_id: int, **over) -> dict:
    body = {
        "name": "Autokredit",
        "direction": "pay_down",
        "category_id": category_id,
        "initial_amount": "5000.00",
        "target_amount": "0.00",
        "start_date": "2026-01-01",
    }
    body.update(over)
    return body


def test_goal_crud_roundtrip(client):
    cat = _new_category(client)
    create = client.post("/api/goals", json=_savings_payload(cat))
    assert create.status_code == 201, create.text
    goal = create.json()
    goal_id = goal["id"]
    assert goal["direction"] == "save_up"
    assert goal["category_id"] == cat

    listed = client.get("/api/goals")
    assert listed.status_code == 200
    assert any(g["id"] == goal_id for g in listed.json())

    update = client.put(
        f"/api/goals/{goal_id}",
        json=_savings_payload(cat, name="Sommerurlaub", target_amount="1500.00"),
    )
    assert update.status_code == 200
    assert update.json()["name"] == "Sommerurlaub"

    delete = client.delete(f"/api/goals/{goal_id}")
    assert delete.status_code == 204
    assert all(g["id"] != goal_id for g in client.get("/api/goals").json())


def test_debt_goal_roundtrip(client):
    cat = _new_category(client)
    create = client.post("/api/goals", json=_debt_payload(cat))
    assert create.status_code == 201, create.text
    assert create.json()["direction"] == "pay_down"


def test_one_goal_per_category(client):
    cat_a = _new_category(client)
    cat_b = _new_category(client)
    first = client.post("/api/goals", json=_savings_payload(cat_a))
    assert first.status_code == 201
    # Second goal on the same category → 409.
    dup = client.post("/api/goals", json=_debt_payload(cat_a))
    assert dup.status_code == 409
    # A different category is fine.
    other = client.post("/api/goals", json=_savings_payload(cat_b))
    assert other.status_code == 201


def test_savings_target_must_exceed_initial(client):
    cat = _new_category(client)
    r = client.post(
        "/api/goals",
        json=_savings_payload(cat, initial_amount="500.00", target_amount="500.00"),
    )
    assert r.status_code == 422


def test_debt_requires_positive_initial(client):
    cat = _new_category(client)
    r = client.post(
        "/api/goals",
        json=_debt_payload(cat, initial_amount="0.00"),
    )
    assert r.status_code == 422


def test_debt_target_must_be_below_initial(client):
    cat = _new_category(client)
    r = client.post(
        "/api/goals",
        json=_debt_payload(cat, initial_amount="100.00", target_amount="200.00"),
    )
    assert r.status_code == 422


def test_goal_on_foreign_category_rejected(app, client, db_session):
    """A goal may not reference another user's category."""
    from app import crud

    other = crud.create_user(
        db_session,
        username=f"other-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    other_client = TestClient(app)
    res = other_client.post(
        "/api/auth/login",
        json={"username": other.username, "password": TEST_PASSWORD},
    )
    other_client.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]
    foreign_cat = _new_category(other_client)

    r = client.post("/api/goals", json=_savings_payload(foreign_cat))
    assert r.status_code == 422


def test_goals_are_user_scoped(app, client, db_session):
    """User A's goals never appear in user B's list."""
    from app import crud

    cat = _new_category(client)
    mine = client.post("/api/goals", json=_savings_payload(cat))
    assert mine.status_code == 201
    my_goal_id = mine.json()["id"]

    other = crud.create_user(
        db_session,
        username=f"other-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    other_client = TestClient(app)
    res = other_client.post(
        "/api/auth/login",
        json={"username": other.username, "password": TEST_PASSWORD},
    )
    other_client.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]

    assert other_client.get("/api/goals").json() == []
    # Cross-user mutation is a 404, not someone else's row.
    assert other_client.delete(f"/api/goals/{my_goal_id}").status_code == 404


def test_goal_post_requires_csrf(app, regular_user):
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200
    # Need a category + goal first (with CSRF) then attempt mutations without
    # the header — POST, PUT and DELETE must all be rejected.
    csrf = res.json()["user"]["csrf_token"]
    cat = _new_category_with_csrf(client, csrf)
    no_csrf = client.post("/api/goals", json=_savings_payload(cat))
    assert no_csrf.status_code == 403
    created = client.post(
        "/api/goals", headers={"X-CSRF-Token": csrf}, json=_savings_payload(cat)
    )
    assert created.status_code == 201
    gid = created.json()["id"]
    assert (
        client.put(f"/api/goals/{gid}", json=_savings_payload(cat)).status_code == 403
    )
    assert client.delete(f"/api/goals/{gid}").status_code == 403


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


def test_deleting_category_with_goal_is_blocked(client):
    cat = _new_category(client)
    created = client.post("/api/goals", json=_savings_payload(cat))
    assert created.status_code == 201
    goal_id = created.json()["id"]

    blocked = client.delete(f"/api/categories/{cat}")
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "category has goal"

    # Once the goal is gone, the category can be deleted.
    assert client.delete(f"/api/goals/{goal_id}").status_code == 204
    assert client.delete(f"/api/categories/{cat}").status_code == 204


def test_goals_require_authentication(app):
    """Every goals endpoint rejects an unauthenticated client."""
    anon = TestClient(app)
    assert anon.get("/api/goals").status_code == 401
    assert anon.post("/api/goals", json=_savings_payload(1)).status_code == 401
    assert anon.put("/api/goals/1", json=_savings_payload(1)).status_code == 401
    assert anon.delete("/api/goals/1").status_code == 401


def test_update_unknown_goal_is_404(client):
    cat = _new_category(client)
    r = client.put("/api/goals/99999999", json=_savings_payload(cat))
    assert r.status_code == 404


def test_delete_unknown_goal_is_404(client):
    assert client.delete("/api/goals/99999999").status_code == 404


def test_update_foreign_goal_is_404(app, client, db_session):
    """A user cannot update another user's goal (no cross-user write)."""
    from app import crud

    cat = _new_category(client)
    mine = client.post("/api/goals", json=_savings_payload(cat))
    gid = mine.json()["id"]

    other = crud.create_user(
        db_session,
        username=f"other-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    other_client = TestClient(app)
    res = other_client.post(
        "/api/auth/login",
        json={"username": other.username, "password": TEST_PASSWORD},
    )
    other_client.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]
    foreign_cat = _new_category(other_client)
    assert (
        other_client.put(
            f"/api/goals/{gid}", json=_savings_payload(foreign_cat)
        ).status_code
        == 404
    )


def test_update_to_foreign_category_rejected(app, client, db_session):
    """PUT validates category ownership too, not just POST."""
    from app import crud

    cat = _new_category(client)
    gid = client.post("/api/goals", json=_savings_payload(cat)).json()["id"]

    other = crud.create_user(
        db_session,
        username=f"other-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    other_client = TestClient(app)
    res = other_client.post(
        "/api/auth/login",
        json={"username": other.username, "password": TEST_PASSWORD},
    )
    other_client.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]
    foreign_cat = _new_category(other_client)

    r = client.put(f"/api/goals/{gid}", json=_savings_payload(foreign_cat))
    assert r.status_code == 422


def test_update_moving_goal_onto_taken_category_409(client):
    """Moving goal B onto a category that already backs goal A → 409."""
    cat_a = _new_category(client)
    cat_b = _new_category(client)
    client.post("/api/goals", json=_savings_payload(cat_a))
    gid_b = client.post("/api/goals", json=_savings_payload(cat_b)).json()["id"]
    r = client.put(f"/api/goals/{gid_b}", json=_savings_payload(cat_a))
    assert r.status_code == 409


def test_update_flipping_direction_revalidates(client):
    """Flipping save_up→pay_down re-runs the cross-field validator: a goal
    with initial=0 is invalid as a debt and must 422."""
    cat = _new_category(client)
    gid = client.post(
        "/api/goals",
        json=_savings_payload(cat, initial_amount="0.00", target_amount="1000.00"),
    ).json()["id"]
    flipped = _debt_payload(cat, initial_amount="0.00", target_amount="0.00")
    assert client.put(f"/api/goals/{gid}", json=flipped).status_code == 422


def test_user_delete_cascades_goals(db_session):
    """Deleting a user removes their goals (ORM + FK cascade)."""
    from app import crud, models
    from app.schemas import GoalCreate

    user = crud.create_user(
        db_session,
        username=f"cascade-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    cat = crud.list_categories(db_session, user.id)[0]
    crud.create_goal(
        db_session,
        user.id,
        GoalCreate(
            name="Notgroschen",
            direction="save_up",
            category_id=cat.id,
            initial_amount="0.00",
            target_amount="500.00",
            start_date="2026-01-01",
        ),
    )
    uid = user.id
    assert crud.list_goals(db_session, uid)
    crud.delete_user(db_session, user)
    db_session.expire_all()
    assert db_session.query(models.Goal).filter(models.Goal.user_id == uid).count() == 0
