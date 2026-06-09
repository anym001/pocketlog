"""CSV import. Parses uploaded rows into transactions, creating categories
and tags on the fly via the categories/tags modules. Per-row failures carry a
stable machine ``code`` (``CsvRowError``) so the frontend localizes the
message — the backend never emits German import prose.

Deduplication: every imported row gets an ``import_hash`` fingerprint
(SHA-256 of ``date|amount|normalized_description|type``). The UNIQUE
constraint ``uq_tx_user_import_hash`` on ``(user_id, import_hash)`` makes
re-importing the same bank data a no-op for the duplicate rows.
"""

import csv
import hashlib
import io
import logging
from datetime import date as date_type
from datetime import datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import constants, models, schemas
from .categories import get_or_create_category
from .defaults import DEFAULT_CATEGORY_NAMES, DEFAULT_LOCALE
from .tags import _build_tag_cache, _resolve_tags_cached

logger = logging.getLogger("pocketlog.crud")

_TYPE_ALIASES = {
    "in": "in",
    "out": "out",
    "income": "in",
    "expense": "out",
    "einnahme": "in",
    "ausgabe": "out",
    "einnahmen": "in",
    "ausgaben": "out",
}


def _norm_key(k: str | None) -> str:
    return (k or "").strip().lstrip("﻿").lower()


class CsvRowError(ValueError):
    """A per-row CSV import problem carrying a stable machine ``code`` plus
    optional ``params``. import_csv turns these into the localized message on
    the client side — the backend never emits German import prose."""

    def __init__(self, code: str, **params):
        super().__init__(code)
        self.code = code
        self.params = params


def _parse_date(s: str) -> date_type:
    for fmt in constants.DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise CsvRowError("date_unrecognised", value=s)


def _parse_amount(s: str) -> Decimal:
    # Accepts "42.50", "42,50", "1.234,56", "1,234.56"
    t = s.strip().replace("€", "").replace(" ", "")
    if "," in t and "." in t:
        # The last separator wins as decimal point
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif "," in t:
        t = t.replace(",", ".")
    try:
        return Decimal(t)
    except InvalidOperation:
        raise CsvRowError("amount_unrecognised", value=s)


def _build_transaction(
    row: dict,
    db: Session,
    user_id: int,
    tag_cache: dict[str, models.Tag],
    fallback_category: str = "Sonstiges",
) -> models.Transaction | None:
    r = {_norm_key(k): (v or "").strip() for k, v in row.items() if k is not None}
    if not r:
        return None
    if not any(r.values()):
        return None  # skip empty rows

    if not r.get("amount"):
        raise CsvRowError("amount_missing")
    if not r.get("date"):
        raise CsvRowError("date_missing")

    date_val = _parse_date(r["date"])
    amount = _parse_amount(r["amount"])

    type_raw = _norm_key(r.get("type"))
    tx_type = _TYPE_ALIASES.get(type_raw)
    if tx_type is None:
        # derive type from sign
        if amount < 0:
            tx_type = "out"
        elif amount > 0:
            tx_type = "in"
        else:
            raise CsvRowError("type_unknown_zero")
    if amount < 0:
        amount = -amount
    if amount == 0:
        raise CsvRowError("amount_zero")

    desc_raw = r.get("description") or r.get("desc") or ""
    desc = schemas._CONTROL_CHARS.sub("", desc_raw).strip()[:255]

    cat = get_or_create_category(db, user_id, r.get("category") or fallback_category)

    tags_raw = r.get("tags") or ""
    # CSV import is best-effort: bad tags are skipped silently rather than
    # failing the whole row (mirrors the existing per-row error model in
    # import_csv). The schema validator above takes the stricter path.
    seen: set[str] = set()
    tag_names: list[str] = []
    for raw in tags_raw.split(","):
        tag = schemas._TAG_CONTROL_CHARS.sub("", raw).strip()
        if not tag or len(tag) > schemas.MAX_TAG_LENGTH:
            continue
        # casefold (not lower) — see schemas._normalise_tags for the
        # Straße/STRASSE rationale.
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        tag_names.append(tag)
        if len(tag_names) >= schemas.MAX_TAGS_PER_TX:
            break

    tx = models.Transaction(
        user_id=user_id,
        amount=amount,
        description=desc,
        category_id=cat.id,
        date=date_val,
        type=tx_type,
    )
    tx.tags = _resolve_tags_cached(db, user_id, tag_names, tag_cache)
    return tx


def _import_hash(tx: models.Transaction) -> str:
    """Fingerprint a transaction for CSV import deduplication.

    Uses the normalised description (lower + strip) so minor whitespace
    differences between bank CSV generations do not create false negatives.
    The hash is per-user via the UNIQUE(user_id, import_hash) constraint,
    not embedded in the hash itself.
    """
    payload = f"{tx.date.isoformat()}|{tx.amount}|{tx.description.lower().strip()}|{tx.type}"
    return hashlib.sha256(payload.encode()).hexdigest()


def import_csv(
    db: Session, user_id: int, text: str, max_rows: int = constants.MAX_IMPORT_ROWS
) -> dict:
    # Auto-detect delimiter (; , \t)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
    except csv.Error:

        class _Fallback(csv.excel):
            delimiter = ";"

        dialect = _Fallback

    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        return {
            "imported": 0,
            "skipped": 0,
            "deduped": 0,
            "errors": [{"row": 1, "code": "header_missing", "params": {}}],
        }

    imported = 0
    skipped = 0
    deduped = 0
    errors: list[dict] = []

    # Locale-aware fallback category for rows without a category column, so an
    # English user doesn't get a German "Sonstiges" bucket. Read-only lookup —
    # no commit here, so the import stays a single transaction.
    s = db.scalar(
        select(models.UserSettings).where(models.UserSettings.user_id == user_id)
    )
    locale = s.locale if s else DEFAULT_LOCALE
    fallback_category = DEFAULT_CATEGORY_NAMES.get(
        schemas.bundle_for_locale(locale), DEFAULT_CATEGORY_NAMES["de"]
    )["other"]

    # One tag-cache for the whole import — keeps row-by-row tag
    # resolution at O(distinct tags) instead of O(rows × tags).
    tag_cache = _build_tag_cache(db, user_id)

    # Pre-load existing import hashes for this user into a set so dedup
    # checks are O(1) without a per-row DB query. Also serves as an
    # in-memory guard for within-file duplicates (e.g. bank CSV with two
    # identical rows).
    existing_hashes: set[str] = {
        row[0]
        for row in db.execute(
            select(models.Transaction.import_hash).where(
                models.Transaction.user_id == user_id,
                models.Transaction.import_hash.is_not(None),
            )
        )
    }

    for idx, row in enumerate(reader, start=2):
        if idx - 1 > max_rows:
            # Stop the loop before allocating a transaction for the next
            # row, then surface the truncation as an error entry. The
            # 5 MB byte cap upstream protects RAM, the row cap protects
            # the worker process from minute-long parse loops.
            errors.append(
                {
                    "row": idx,
                    "code": "row_limit",
                    "params": {"max": max_rows},
                }
            )
            break
        try:
            tx = _build_transaction(row, db, user_id, tag_cache, fallback_category)
            if tx is None:
                skipped += 1
                continue

            h = _import_hash(tx)
            if h in existing_hashes:
                deduped += 1
                continue
            existing_hashes.add(h)
            tx.import_hash = h

            db.add(tx)
            imported += 1
            if imported % 200 == 0:
                db.flush()
        except CsvRowError as e:
            skipped += 1
            if len(errors) < 50:
                errors.append({"row": idx, "code": e.code, "params": e.params})
        except Exception:  # noqa: BLE001
            # Unexpected per-row failure: never surface the raw (possibly
            # German / schema-leaking) message — emit a generic code and log.
            logger.exception("CSV import row %s failed for user_id=%s", idx, user_id)
            skipped += 1
            if len(errors) < 50:
                errors.append({"row": idx, "code": "row_invalid", "params": {}})

    try:
        db.commit()
    except IntegrityError:
        # The raw exception contains MariaDB column/constraint names, which
        # would leak schema details to the API client. Log the detail
        # server-side and return a generic message.
        logger.exception("CSV import IntegrityError for user_id=%s", user_id)
        db.rollback()
        return {
            "imported": 0,
            "skipped": imported + skipped,
            "deduped": deduped,
            "errors": [{"row": 0, "code": "db_conflict", "params": {}}],
        }

    return {"imported": imported, "skipped": skipped, "deduped": deduped, "errors": errors}
