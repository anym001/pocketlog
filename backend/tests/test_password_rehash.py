"""Opportunistic Argon2 rehash on login: hashes written with weaker (older)
parameters are upgraded to the library's current defaults the next time the
password is legitimately available — and current hashes are left alone."""

from __future__ import annotations

import uuid

from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from app import auth, crud

from .conftest import TEST_PASSWORD

# Deliberately minimal parameters, as if written by an old release. Any
# realistic future default exceeds these, so check_needs_rehash fires.
_WEAK_HASHER = PasswordHasher(
    time_cost=1, memory_cost=8, parallelism=1, hash_len=16, salt_len=8
)


def _make_user_with_weak_hash(db_session):
    user = crud.create_user(
        db_session,
        username=f"rehash-{uuid.uuid4().hex[:10]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    user.password_hash = _WEAK_HASHER.hash(TEST_PASSWORD)
    db_session.commit()
    return user


def test_login_upgrades_weak_hash(app, db_session):
    user = _make_user_with_weak_hash(db_session)
    weak_hash = user.password_hash

    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200

    db_session.expire_all()
    db_session.refresh(user)
    assert user.password_hash != weak_hash
    # The new hash carries current parameters and still verifies.
    assert auth.verify_password(TEST_PASSWORD, user.password_hash)
    assert not auth._hasher.check_needs_rehash(user.password_hash)


def test_login_leaves_current_hash_alone(app, regular_user, db_session):
    before = regular_user.password_hash

    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200

    db_session.expire_all()
    db_session.refresh(regular_user)
    assert regular_user.password_hash == before


def test_wrong_password_never_rehashes(app, db_session):
    user = _make_user_with_weak_hash(db_session)
    weak_hash = user.password_hash

    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": "Wrong-password-1"},
    )
    assert res.status_code == 401

    db_session.expire_all()
    db_session.refresh(user)
    assert user.password_hash == weak_hash
