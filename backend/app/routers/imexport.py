"""CSV import/export and the JSON full-account backup endpoints.

CSV import/export guard against spreadsheet formula injection (see _csv_safe /
crud.import_csv). Every upload goes through ``_read_upload_limited`` so an
oversized body is rejected chunk-wise *before* it is buffered into RAM.

The JSON backup pair is asymmetric on purpose: export is available to read
API keys (it's just data egress, same as the CSV export), restore is
session-only — it rewrites settings and mass-creates rows, which is a
different blast radius than an ``import``-scoped key should have.
"""

import csv
import io
import json
import logging
import os
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from .. import constants, crud, errors, schemas
from ..deps import DB, CurrentUser, ImportUser, ReadUser
from ..logging_config import client_ip

logger = logging.getLogger("pocketlog.api")
audit = logging.getLogger("pocketlog.audit")

router = APIRouter()

_READ_CHUNK_BYTES = 1024 * 1024


async def _read_upload_limited(file: UploadFile, max_bytes: int, detail: str) -> bytes:
    """Read an upload in chunks, aborting with 413 once *max_bytes* is
    exceeded. A plain ``await file.read()`` would materialize the whole
    body in RAM before any size check can run (Starlette spools large
    multipart bodies to disk, so the cap here bounds the process memory,
    not the transfer)."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=detail)
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/api/import/csv", response_model=schemas.ImportResult)
async def import_csv(file: UploadFile, user: ImportUser, db: DB):
    raw = await _read_upload_limited(
        file, constants.MAX_IMPORT_BYTES, "file too large (>5MB)"
    )
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        # Fallback for Excel exports on Windows
        try:
            text = raw.decode("cp1252")
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="encoding not utf-8/cp1252")
    return crud.import_csv(db, user.id, text, max_rows=constants.MAX_IMPORT_ROWS)


def _csv_safe(value: str) -> str:
    # CSV formula-injection guard; prefix set documented in app.constants.
    if value and value[0] in constants.CSV_FORMULA_PREFIXES:
        return "'" + value
    return value


@router.get("/api/export/csv")
def export_csv(user: ReadUser, db: DB):
    txs = crud.list_all_transactions(db, user.id)
    categories = {c.id: c.name for c in crud.list_categories(db, user.id)}

    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["date", "type", "amount", "description", "category", "tags"])
    for t in txs:
        # Each tag is escaped individually, so the joined string can only
        # start with a formula-trigger if the first tag did — which then
        # already carries the leading quote. The outer _csv_safe is kept
        # as defence-in-depth in case the per-tag rule ever changes.
        joined_tags = ",".join(_csv_safe(tag.name) for tag in t.tags)
        writer.writerow(
            [
                t.date.isoformat(),
                t.type,
                f"{t.amount:.2f}",
                _csv_safe(t.description),
                _csv_safe(categories.get(t.category_id, "")),
                _csv_safe(joined_tags),
            ]
        )
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="pocketlog.csv"'},
    )


@router.get(
    "/api/export/json",
    response_model=schemas.BackupFile,
    response_model_by_alias=True,
)
def export_json(response: Response, user: ReadUser, db: DB):
    """Full-account backup: settings, categories, tags, transactions,
    goals, budgets, recurring rules — one versioned JSON file that
    POST /api/import/json accepts back."""
    backup = crud.export_backup(
        db,
        user.id,
        exported_at=datetime.now(UTC),
        app_version=os.environ.get("APP_VERSION", "dev"),
    )
    response.headers["Content-Disposition"] = (
        'attachment; filename="pocketlog-backup.json"'
    )
    return backup


@router.post("/api/import/json", response_model=schemas.BackupRestoreResult)
async def import_json(
    file: UploadFile,
    request: Request,
    user: CurrentUser,
    db: DB,
):
    """Restore a backup file into this account.

    Only allowed while the account has no ledger data (transactions, goals,
    budgets, recurring rules) — restore is a migration/recovery path, not a
    merge. All error responses carry stable machine codes the frontend
    translates (``backup.*`` in the i18n bundles).
    """
    raw = await _read_upload_limited(
        file, constants.MAX_BACKUP_BYTES, "backup_too_large"
    )
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="backup_invalid")
    if not isinstance(data, dict) or data.get("format") != schemas.BACKUP_FORMAT:
        raise HTTPException(status_code=400, detail="backup_invalid")
    # Version gate before schema validation, so a future-version file gets
    # the specific code instead of a generic validation failure.
    if data.get("version") != schemas.BACKUP_VERSION:
        raise HTTPException(status_code=400, detail="backup_unsupported_version")
    try:
        backup = schemas.BackupFile.model_validate(data)
    except ValidationError as exc:
        # Field contents may echo user data — log the shape, not the values.
        logger.info(
            "backup restore rejected for user_id=%s: %s validation error(s)",
            user.id,
            exc.error_count(),
        )
        raise HTTPException(status_code=400, detail="backup_invalid")

    if crud.has_ledger_data(db, user.id):
        raise errors.conflict("restore_not_empty")

    # Plain int, resolved before the try: after a failed flush the session
    # needs a rollback first, so even `user.id` (a lazy refresh) would raise
    # PendingRollbackError inside the except block.
    user_id = user.id
    try:
        counts = crud.restore_backup(db, user_id, backup)
    except IntegrityError:
        # E.g. a crafted file with duplicate rule names or two goals on one
        # category. Constraint details stay in the server log.
        db.rollback()
        logger.exception("backup restore IntegrityError for user_id=%s", user_id)
        raise errors.conflict("restore_conflict")

    audit.info(
        "backup.restore id=%s ip=%s transactions=%s categories=%s tags=%s "
        "goals=%s budgets=%s rules=%s",
        user_id,
        client_ip(request),
        counts["transactions"],
        counts["categories"],
        counts["tags"],
        counts["goals"],
        counts["budgets"],
        counts["recurring_rules"],
    )
    return counts
