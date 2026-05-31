"""Security/audit logging: the pocketlog.audit logger emits structured events
for auth and admin actions, at the right level and WITHOUT leaking secrets.

These are the operator's only audit trail (no DB audit table), so we pin both
the presence/level of events and the absence of credentials in the output.
"""
from __future__ import annotations

import logging
import uuid

import pytest
from fastapi.testclient import TestClient

from app import crud
from .conftest import TEST_PASSWORD

AUDIT = "pocketlog.audit"


@pytest.fixture(autouse=True)
def _capture_audit(caplog):
    """The pocketlog logger sets propagate=False (no double emission via
    uvicorn's root handler in production). pytest's caplog attaches to the
    ROOT logger, so it wouldn't see our records. Attach caplog's handler to
    the pocketlog logger for the duration of each test."""
    caplog.set_level(logging.INFO, logger="pocketlog")
    plog = logging.getLogger("pocketlog")
    plog.addHandler(caplog.handler)
    try:
        yield
    finally:
        plog.removeHandler(caplog.handler)


def _fresh(app):
    return TestClient(app)


# ── login ────────────────────────────────────────────────────────────────


def test_login_success_logs_audit_info(app, regular_user, caplog):
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200

    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    rec = recs[0]
    assert rec.levelno == logging.INFO
    msg = rec.getMessage()
    assert msg.startswith("auth.login.success")
    assert f"user={regular_user.username}" in msg
    assert f"id={regular_user.id}" in msg
    assert "ip=" in msg


def test_login_wrong_password_logs_warning(app, regular_user, caplog):
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _fresh(app)
    client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": "definitely-wrong"},
    )
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    assert recs[0].levelno == logging.WARNING
    msg = recs[0].getMessage()
    assert msg.startswith("auth.login.failure")
    assert "reason=bad_password" in msg


def test_login_unknown_user_logs_warning_same_shape(app, caplog):
    """Unknown user and wrong password are indistinguishable to the client;
    server-side they differ only by the log-only `reason` field."""
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _fresh(app)
    client.post(
        "/api/auth/login",
        json={"username": f"ghost-{uuid.uuid4().hex[:8]}", "password": "whatever-1234"},
    )
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    assert recs[0].levelno == logging.WARNING
    msg = recs[0].getMessage()
    assert msg.startswith("auth.login.failure")
    assert "reason=unknown_user" in msg


def test_repeated_failures_log_lockout_triggered(app, regular_user, caplog):
    """5th failure (LOCKOUT_THRESHOLD) flips from failure to lockout_triggered."""
    from app import auth

    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _fresh(app)
    for _ in range(auth.LOCKOUT_THRESHOLD):
        client.post(
            "/api/auth/login",
            json={"username": regular_user.username, "password": "wrong-pw-here"},
        )

    recs = [r for r in caplog.records if r.name == AUDIT]
    last = recs[-1]
    assert last.levelno == logging.WARNING
    msg = last.getMessage()
    assert msg.startswith("auth.login.lockout_triggered")
    assert "seconds=" in msg


# ── admin actions ──────────────────────────────────────────────────────────


def test_admin_create_user_logs_audit(app, admin_user, caplog):
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _login(app, admin_user)
    caplog.clear()  # drop the login.success record

    new_name = f"created-{uuid.uuid4().hex[:8]}"
    res = client.post(
        "/api/admin/users",
        json={"username": new_name, "password": "Created-user-2026!"},
    )
    assert res.status_code == 201, res.text
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    msg = recs[0].getMessage()
    assert msg.startswith("admin.user.create")
    assert f"actor_admin_id={admin_user.id}" in msg
    assert "new_user_id=" in msg


def test_admin_delete_user_logs_audit(app, admin_user, db_session, caplog):
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _login(app, admin_user)
    target = crud.create_user(
        db_session,
        username=f"victim-{uuid.uuid4().hex[:8]}",
        password=TEST_PASSWORD,
        is_admin=False,
        force_change_password=False,
    )
    db_session.commit()
    caplog.clear()

    res = client.delete(f"/api/admin/users/{target.id}")
    assert res.status_code == 204, res.text
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert any(
        r.getMessage().startswith("admin.user.delete")
        and f"target_id={target.id}" in r.getMessage()
        for r in recs
    )


def test_self_password_change_logs_revoked_count(app, regular_user, caplog):
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _login(app, regular_user)
    caplog.clear()

    res = client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "Changed-pw-2026!"},
    )
    assert res.status_code == 204, res.text
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    msg = recs[0].getMessage()
    assert msg.startswith("auth.password.change_self")
    assert f"id={regular_user.id}" in msg
    assert "revoked_count=" in msg


# ── secret-leak guard ──────────────────────────────────────────────────────


def test_audit_log_never_contains_secrets(app, regular_user, caplog):
    """Analogue to the CSV-import DB-internals leak test: no credential or
    token may ever appear in the audit log."""
    caplog.set_level(logging.INFO, logger=AUDIT)
    client = _fresh(app)
    res = client.post(
        "/api/auth/login",
        json={"username": regular_user.username, "password": TEST_PASSWORD},
    )
    csrf = res.json()["user"]["csrf_token"]
    session_cookie = client.cookies.get("pocketlog_session", "")
    client.headers["X-CSRF-Token"] = csrf
    client.post(
        "/api/auth/change-password",
        json={"current_password": TEST_PASSWORD, "new_password": "Another-pw-2026!"},
    )

    text = caplog.text
    forbidden = [
        TEST_PASSWORD,
        "Another-pw-2026!",
        "password_hash",
        csrf,
        session_cookie,
    ]
    leaks = [tok for tok in forbidden if tok and tok in text]
    assert not leaks, f"secrets leaked into audit log: {leaks!r}"


def test_reset_transactions_logs_audit(app, regular_user, caplog):
    """Self-service bulk delete of own transactions is destructive — audited."""
    client = _login(app, regular_user)
    caplog.clear()
    res = client.delete("/api/admin/transactions")
    assert res.status_code == 204, res.text
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    msg = recs[0].getMessage()
    assert msg.startswith("data.reset_transactions")
    assert f"id={regular_user.id}" in msg
    assert "deleted_count=" in msg


def test_reset_all_data_logs_audit(app, regular_user, caplog):
    """Irreversible wipe of transactions + categories + tags — audited."""
    client = _login(app, regular_user)
    caplog.clear()
    res = client.delete("/api/admin/all-data")
    assert res.status_code == 204, res.text
    recs = [r for r in caplog.records if r.name == AUDIT]
    assert len(recs) == 1
    assert recs[0].getMessage().startswith("data.reset_all_data")
    assert f"id={regular_user.id}" in recs[0].getMessage()


def test_crlf_in_username_cannot_forge_log_line(app, caplog):
    """A crafted username with CRLF must not split into a second log record
    or inject a fake event — safe() strips control chars."""
    client = _fresh(app)
    client.post(
        "/api/auth/login",
        json={
            "username": "evil\r\nauth.login.success user=admin id=1",
            "password": "whatever-1234",
        },
    )
    recs = [r for r in caplog.records if r.name == AUDIT]
    # Exactly one record, and the injected newline is gone from its message.
    assert len(recs) == 1
    msg = recs[0].getMessage()
    assert "\n" not in msg and "\r" not in msg
    assert msg.startswith("auth.login.failure")


def test_safe_strips_control_chars_and_truncates():
    from app.logging_config import safe

    assert safe("a\r\nb") == "a  b"
    assert safe("tab\tend") == "tab end"
    assert safe(None) == ""
    long = "x" * 500
    out = safe(long, max_len=10)
    assert out == "x" * 10 + "…"


# ── helpers ──────────────────────────────────────────────────────────────


def _login(app, user):
    """Authenticated TestClient (mirrors conftest._login_client without the
    fixture indirection so a test can log in mid-body)."""
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"username": user.username, "password": TEST_PASSWORD},
    )
    assert res.status_code == 200, res.text
    client.headers["X-CSRF-Token"] = res.json()["user"]["csrf_token"]
    return client
