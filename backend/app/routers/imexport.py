"""CSV import and export. Both guard against spreadsheet formula injection
(see _csv_safe / crud.import_csv) and cap the import at constants.MAX_IMPORT_*.
"""

import csv
import io

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from .. import constants, crud, schemas
from ..deps import DB, CurrentUser, ImportUser

router = APIRouter()


@router.post("/api/import/csv", response_model=schemas.ImportResult)
async def import_csv(file: UploadFile, user: ImportUser, db: DB):
    raw = await file.read()
    if len(raw) > constants.MAX_IMPORT_BYTES:
        raise HTTPException(status_code=413, detail="file too large (>5MB)")
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
def export_csv(user: CurrentUser, db: DB):
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
