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


# ── unified log format ─────────────────────────────────────────────────────


def test_uvicorn_loggers_use_unified_format(app):
    """uvicorn's own loggers are reformatted to match the app/audit format so
    docker logs are consistent (one timestamp+level+name+message scheme)."""
    from app.logging_config import _TEXT_FORMAT

    for name in ("pocketlog", "uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        assert lg.propagate is False, f"{name} should not propagate"
        formats = {
            h.formatter._fmt for h in lg.handlers if h.formatter is not None
        }
        assert _TEXT_FORMAT in formats, (
            f"{name} has no handler using the unified format; got {formats}"
        )


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


def test_log_file_writes_and_rotates(tmp_path, monkeypatch):
    """LOG_FILE writes audit records to disk (in addition to stderr) and the
    rotating handler caps file count."""
    import logging.handlers as handlers_mod
    from app import logging_config

    log_path = tmp_path / "logs" / "audit.log"
    monkeypatch.setenv("LOG_FILE", str(log_path))
    monkeypatch.setenv("LOG_FILE_MAX_BYTES", "200")
    monkeypatch.setenv("LOG_FILE_BACKUPS", "2")

    plog = logging.getLogger("pocketlog")
    added = [h for h in plog.handlers]
    try:
        logging_config._attach_file_handler(logging.INFO)
        file_handlers = [
            h for h in plog.handlers
            if isinstance(h, handlers_mod.RotatingFileHandler)
        ]
        assert file_handlers, "expected a RotatingFileHandler on pocketlog"
        fh = file_handlers[-1]
        assert fh.backupCount == 2
        assert fh.maxBytes == 200

        # Parent directory was created and a record lands in the file.
        logging.getLogger("pocketlog.audit").info("test.event id=1 ip=x")
        fh.flush()
        assert log_path.exists()
        assert "test.event" in log_path.read_text(encoding="utf-8")
    finally:
        # Remove only the handler(s) we added, restore prior state.
        for h in [h for h in plog.handlers if h not in added]:
            plog.removeHandler(h)
            h.close()


def test_log_file_bad_path_does_not_crash(monkeypatch, caplog):
    """A non-writable LOG_FILE must warn, not raise — the app keeps running on
    stderr. Point LOG_FILE at a path whose parent can't be created."""
    from app import logging_config

    # /proc is read-only; makedirs there raises OSError, which must be swallowed.
    monkeypatch.setenv("LOG_FILE", "/proc/cannot/create/here/audit.log")
    plog = logging.getLogger("pocketlog")
    before = list(plog.handlers)
    # Must not raise.
    logging_config._attach_file_handler(logging.INFO)
    # No file handler was added.
    assert list(plog.handlers) == before


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
