import csv
import io
from datetime import date as date_type, datetime
from decimal import Decimal, InvalidOperation

from sqlalchemy import and_, extract, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import models, schemas

DEFAULT_CATEGORIES: list[dict] = [
    {"name": "Lebensmittel", "icon": "🛒", "color": "#c8623a"},
    {"name": "Wohnen", "icon": "🏠", "color": "#8a6a4a"},
    {"name": "Mobilität", "icon": "🚗", "color": "#6a8a8a"},
    {"name": "Freizeit", "icon": "🎬", "color": "#a45ab0"},
    {"name": "Gesundheit", "icon": "💊", "color": "#3a7d5c"},
    {"name": "Sonstiges", "icon": "📦", "color": "#9e9b96"},
    {"name": "Gehalt", "icon": "💰", "color": "#3a7d5c"},
]


# ---------- Categories ----------

def ensure_default_categories(db: Session, username: str) -> None:
    existing = db.scalar(
        select(models.Category).where(models.Category.username == username).limit(1)
    )
    if existing is not None:
        return
    for c in DEFAULT_CATEGORIES:
        db.add(models.Category(username=username, **c))
    db.commit()


def list_categories(db: Session, username: str) -> list[models.Category]:
    ensure_default_categories(db, username)
    return list(
        db.scalars(
            select(models.Category)
            .where(models.Category.username == username)
            .order_by(models.Category.id)
        )
    )


def get_or_create_category(db: Session, username: str, name: str) -> models.Category:
    name = (name or "").strip() or "Sonstiges"
    cat = db.scalar(
        select(models.Category).where(
            and_(models.Category.username == username, models.Category.name == name)
        )
    )
    if cat is not None:
        return cat
    cat = models.Category(username=username, name=name[:100], icon="📦", color="#9e9b96")
    db.add(cat)
    db.flush()
    return cat


def create_category(
    db: Session, username: str, payload: schemas.CategoryCreate
) -> models.Category:
    cat = models.Category(username=username, **payload.model_dump())
    db.add(cat)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(cat)
    return cat


def update_category(
    db: Session,
    username: str,
    category_id: int,
    payload: schemas.CategoryUpdate,
) -> models.Category | None:
    cat = db.scalar(
        select(models.Category).where(
            and_(
                models.Category.id == category_id,
                models.Category.username == username,
            )
        )
    )
    if cat is None:
        return None
    for k, v in payload.model_dump().items():
        setattr(cat, k, v)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(cat)
    return cat


def delete_category(db: Session, username: str, category_id: int) -> bool:
    cat = db.scalar(
        select(models.Category).where(
            and_(
                models.Category.id == category_id,
                models.Category.username == username,
            )
        )
    )
    if cat is None:
        return False
    in_use = db.scalar(
        select(models.Transaction.id).where(
            models.Transaction.category_id == category_id
        ).limit(1)
    )
    if in_use is not None:
        raise ValueError("category_in_use")
    db.delete(cat)
    db.commit()
    return True


# ---------- Transactions ----------

def list_transactions(
    db: Session, username: str, year: int, month: int | None = None
) -> list[models.Transaction]:
    q = select(models.Transaction).where(
        and_(
            models.Transaction.username == username,
            extract("year", models.Transaction.date) == year,
        )
    )
    if month is not None:
        q = q.where(extract("month", models.Transaction.date) == month)
    q = q.order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    return list(db.scalars(q))


def list_all_transactions(db: Session, username: str) -> list[models.Transaction]:
    q = (
        select(models.Transaction)
        .where(models.Transaction.username == username)
        .order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    )
    return list(db.scalars(q))


def _check_category_owned(db: Session, username: str, category_id: int) -> bool:
    return (
        db.scalar(
            select(models.Category.id).where(
                and_(
                    models.Category.id == category_id,
                    models.Category.username == username,
                )
            )
        )
        is not None
    )


def create_transaction(
    db: Session, username: str, payload: schemas.TransactionCreate
) -> models.Transaction:
    if not _check_category_owned(db, username, payload.category_id):
        raise ValueError("unknown_category")
    tx = models.Transaction(username=username, **payload.model_dump(by_alias=False))
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return tx


def update_transaction(
    db: Session, username: str, tx_id: int, payload: schemas.TransactionUpdate
) -> models.Transaction | None:
    tx = db.scalar(
        select(models.Transaction).where(
            and_(
                models.Transaction.id == tx_id,
                models.Transaction.username == username,
            )
        )
    )
    if tx is None:
        return None
    if not _check_category_owned(db, username, payload.category_id):
        raise ValueError("unknown_category")
    for k, v in payload.model_dump(by_alias=False).items():
        setattr(tx, k, v)
    db.commit()
    db.refresh(tx)
    return tx


def list_tags(db: Session, username: str) -> list[str]:
    rows = db.scalars(
        select(models.Transaction.tags).where(
            and_(
                models.Transaction.username == username,
                models.Transaction.tags.is_not(None),
            )
        )
    )
    seen: set[str] = set()
    for tags in rows:
        if not tags:
            continue
        for t in tags:
            if not isinstance(t, str):
                continue
            t = t.strip()
            if t:
                seen.add(t)
    return sorted(seen, key=str.casefold)


def delete_transaction(db: Session, username: str, tx_id: int) -> bool:
    tx = db.scalar(
        select(models.Transaction).where(
            and_(
                models.Transaction.id == tx_id,
                models.Transaction.username == username,
            )
        )
    )
    if tx is None:
        return False
    db.delete(tx)
    db.commit()
    return True


# ---------- CSV-Import ----------

_TYPE_ALIASES = {
    "in": "in", "out": "out",
    "income": "in", "expense": "out",
    "einnahme": "in", "ausgabe": "out",
    "einnahmen": "in", "ausgaben": "out",
}

_DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d")


def _norm_key(k: str | None) -> str:
    return (k or "").strip().lstrip("﻿").lower()


def _parse_date(s: str) -> date_type:
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Datum nicht erkennbar: {s!r}")


def _parse_amount(s: str) -> Decimal:
    # Akzeptiert "42.50", "42,50", "1.234,56", "1,234.56"
    t = s.strip().replace("€", "").replace(" ", "")
    if "," in t and "." in t:
        # Letztes Symbol gewinnt als Dezimaltrenner
        if t.rfind(",") > t.rfind("."):
            t = t.replace(".", "").replace(",", ".")
        else:
            t = t.replace(",", "")
    elif "," in t:
        t = t.replace(",", ".")
    try:
        return Decimal(t)
    except InvalidOperation:
        raise ValueError(f"Betrag nicht erkennbar: {s!r}")


def _build_transaction(row: dict, db: Session, username: str) -> models.Transaction | None:
    r = {_norm_key(k): (v or "").strip() for k, v in row.items() if k is not None}
    if not r:
        return None
    if not any(r.values()):
        return None  # leere Zeile überspringen

    if not r.get("amount"):
        raise ValueError("Spalte 'amount' fehlt oder leer")
    if not r.get("date"):
        raise ValueError("Spalte 'date' fehlt oder leer")

    date_val = _parse_date(r["date"])
    amount = _parse_amount(r["amount"])

    type_raw = _norm_key(r.get("type"))
    tx_type = _TYPE_ALIASES.get(type_raw)
    if tx_type is None:
        # aus Vorzeichen ableiten
        if amount < 0:
            tx_type = "out"
        elif amount > 0:
            tx_type = "in"
        else:
            raise ValueError("Typ unbekannt und Betrag = 0")
    if amount < 0:
        amount = -amount
    if amount == 0:
        raise ValueError("Betrag darf nicht 0 sein")

    desc = (r.get("description") or r.get("desc") or "").strip()[:255]

    cat = get_or_create_category(db, username, r.get("category") or "Sonstiges")

    tags_raw = r.get("tags") or ""
    tags = [t.strip() for t in tags_raw.split(",") if t.strip()] or None

    return models.Transaction(
        username=username,
        amount=amount,
        description=desc,
        category_id=cat.id,
        date=date_val,
        type=tx_type,
        tags=tags,
    )


def import_csv(db: Session, username: str, text: str) -> dict:
    # Trennzeichen automatisch erkennen (; , \t)
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t|")
    except csv.Error:
        class _Fallback(csv.excel):
            delimiter = ";"
        dialect = _Fallback

    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        return {"imported": 0, "skipped": 0, "errors": [{"row": 1, "reason": "Header fehlt"}]}

    imported = 0
    skipped = 0
    errors: list[dict] = []

    for idx, row in enumerate(reader, start=2):
        try:
            tx = _build_transaction(row, db, username)
            if tx is None:
                skipped += 1
                continue
            db.add(tx)
            imported += 1
            if imported % 200 == 0:
                db.flush()
        except Exception as e:  # noqa: BLE001
            skipped += 1
            if len(errors) < 50:
                errors.append({"row": idx, "reason": str(e)})

    try:
        db.commit()
    except IntegrityError as e:
        db.rollback()
        return {
            "imported": 0,
            "skipped": imported + skipped,
            "errors": [{"row": 0, "reason": f"DB-Konflikt: {e.orig}"}],
        }

    return {"imported": imported, "skipped": skipped, "errors": errors}
