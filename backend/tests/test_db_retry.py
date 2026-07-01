"""Tests for app.db_retry — the transient-conflict retry helper.

SQLite never raises the MariaDB conflict codes (1020/1213/1205), so the
retry path can't be exercised through the real stack here. We construct
OperationalErrors with the relevant DBAPI codes directly and verify the
classification + the retry/rollback/backoff loop.
"""

from __future__ import annotations

import pytest
from sqlalchemy.exc import OperationalError

from app.db_retry import is_retryable_operational_error, run_with_retry


def _op_error(code):
    # Mirrors how SQLAlchemy wraps a DBAPI error: orig.args[0] is the code.
    orig = Exception(code, "boom") if code is not None else Exception("no code")
    return OperationalError("UPDATE t SET x=1", {}, orig)


class _FakeSession:
    def __init__(self):
        self.rollbacks = 0

    def rollback(self):
        self.rollbacks += 1


@pytest.mark.parametrize("code", [1020, 1205, 1213])
def test_retryable_codes(code):
    assert is_retryable_operational_error(_op_error(code)) is True


@pytest.mark.parametrize("code", [1054, 1064, 1146, None])
def test_non_retryable_codes(code):
    assert is_retryable_operational_error(_op_error(code)) is False


def test_returns_result_on_first_success():
    db = _FakeSession()
    assert run_with_retry(db, lambda: "ok") == "ok"
    assert db.rollbacks == 0


def test_retries_transient_then_succeeds():
    db = _FakeSession()
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        if calls["n"] < 3:
            raise _op_error(1020)
        return "ok"

    assert run_with_retry(db, op, attempts=3) == "ok"
    assert calls["n"] == 3
    # One rollback per failed attempt before the successful third.
    assert db.rollbacks == 2


def test_gives_up_after_attempts_and_reraises():
    db = _FakeSession()

    def op():
        raise _op_error(1020)

    with pytest.raises(OperationalError):
        run_with_retry(db, op, attempts=3)
    assert db.rollbacks == 3  # rolled back on every attempt


def test_non_retryable_is_not_retried():
    db = _FakeSession()
    calls = {"n": 0}

    def op():
        calls["n"] += 1
        raise _op_error(1054)  # unknown column — not transient

    with pytest.raises(OperationalError):
        run_with_retry(db, op, attempts=3)
    assert calls["n"] == 1  # tried once, no retry
    assert db.rollbacks == 1
