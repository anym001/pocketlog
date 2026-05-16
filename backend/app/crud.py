import csv
import io
from datetime import date as date_type, datetime, timedelta
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


# ---------- Users ----------

def get_or_create_user(db: Session, username: str) -> models.User:
    user = db.scalar(select(models.User).where(models.User.username == username))
    if user is not None:
        return user
    user = models.User(username=username)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent insert from a parallel request — fetch the winner.
        db.rollback()
        user = db.scalar(select(models.User).where(models.User.username == username))
        if user is None:
            raise
    else:
        db.refresh(user)
    return user


# ---------- Categories ----------

def ensure_default_categories(db: Session, user_id: int) -> None:
    existing = db.scalar(
        select(models.Category).where(models.Category.user_id == user_id).limit(1)
    )
    if existing is not None:
        return
    for c in DEFAULT_CATEGORIES:
        db.add(models.Category(user_id=user_id, **c))
    db.commit()


def list_categories(db: Session, user_id: int) -> list[models.Category]:
    ensure_default_categories(db, user_id)
    return list(
        db.scalars(
            select(models.Category)
            .where(models.Category.user_id == user_id)
            .order_by(models.Category.id)
        )
    )


def get_or_create_category(db: Session, user_id: int, name: str) -> models.Category:
    name = (name or "").strip() or "Sonstiges"
    cat = db.scalar(
        select(models.Category).where(
            and_(models.Category.user_id == user_id, models.Category.name == name)
        )
    )
    if cat is not None:
        return cat
    cat = models.Category(user_id=user_id, name=name[:100], icon="📦", color="#9e9b96")
    db.add(cat)
    db.flush()
    return cat


def create_category(
    db: Session, user_id: int, payload: schemas.CategoryCreate
) -> models.Category:
    cat = models.Category(user_id=user_id, **payload.model_dump())
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
    user_id: int,
    category_id: int,
    payload: schemas.CategoryUpdate,
) -> models.Category | None:
    cat = db.scalar(
        select(models.Category).where(
            and_(
                models.Category.id == category_id,
                models.Category.user_id == user_id,
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


def delete_category(db: Session, user_id: int, category_id: int) -> bool:
    cat = db.scalar(
        select(models.Category).where(
            and_(
                models.Category.id == category_id,
                models.Category.user_id == user_id,
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
    db: Session, user_id: int, year: int, month: int | None = None
) -> list[models.Transaction]:
    q = select(models.Transaction).where(
        and_(
            models.Transaction.user_id == user_id,
            extract("year", models.Transaction.date) == year,
        )
    )
    if month is not None:
        q = q.where(extract("month", models.Transaction.date) == month)
    q = q.order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    return list(db.scalars(q))


def list_all_transactions(db: Session, user_id: int) -> list[models.Transaction]:
    q = (
        select(models.Transaction)
        .where(models.Transaction.user_id == user_id)
        .order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    )
    return list(db.scalars(q))


def _check_category_owned(db: Session, user_id: int, category_id: int) -> bool:
    return (
        db.scalar(
            select(models.Category.id).where(
                and_(
                    models.Category.id == category_id,
                    models.Category.user_id == user_id,
                )
            )
        )
        is not None
    )


def create_transaction(
    db: Session, user_id: int, payload: schemas.TransactionCreate
) -> models.Transaction:
    if not _check_category_owned(db, user_id, payload.category_id):
        raise ValueError("unknown_category")
    tx = models.Transaction(user_id=user_id, **payload.model_dump(by_alias=False))
    db.add(tx)
    db.commit()
    db.refresh(tx)
    return tx


def update_transaction(
    db: Session, user_id: int, tx_id: int, payload: schemas.TransactionUpdate
) -> models.Transaction | None:
    tx = db.scalar(
        select(models.Transaction).where(
            and_(
                models.Transaction.id == tx_id,
                models.Transaction.user_id == user_id,
            )
        )
    )
    if tx is None:
        return None
    if not _check_category_owned(db, user_id, payload.category_id):
        raise ValueError("unknown_category")
    for k, v in payload.model_dump(by_alias=False).items():
        setattr(tx, k, v)
    db.commit()
    db.refresh(tx)
    return tx


def list_tags(db: Session, user_id: int) -> list[dict]:
    # Names: all-time pool (standalone tags + tags ever seen on a tx).
    # Counts: only transactions from the last 30 days, so suggestions
    # surface tags that are currently relevant rather than long-stale.
    # Standalone (declared) tags from the tags table — these win on casing
    # when both a standalone entry and a tx-derived entry exist for the
    # same case-folded key.
    by_key: dict[str, str] = {}
    counts: dict[str, int] = {}
    cutoff = date_type.today() - timedelta(days=30)

    for name in db.scalars(
        select(models.Tag.name).where(models.Tag.user_id == user_id)
    ):
        name = (name or "").strip()
        if name:
            by_key[name.casefold()] = name

    rows = db.execute(
        select(models.Transaction.tags, models.Transaction.date).where(
            and_(
                models.Transaction.user_id == user_id,
                models.Transaction.tags.is_not(None),
            )
        )
    )
    for tags, tx_date in rows:
        if not tags:
            continue
        in_window = tx_date is not None and tx_date >= cutoff
        for t in tags:
            if not isinstance(t, str):
                continue
            t = t.strip()
            if not t:
                continue
            key = t.casefold()
            by_key.setdefault(key, t)
            if in_window:
                counts[key] = counts.get(key, 0) + 1
    return [
        {"name": by_key[k], "count": counts.get(k, 0)}
        for k in sorted(by_key.keys())
    ]


def create_tag(db: Session, user_id: int, name: str) -> models.Tag:
    name = (name or "").strip()
    if not name:
        raise ValueError("empty_name")
    tag = models.Tag(user_id=user_id, name=name[:64])
    db.add(tag)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(tag)
    return tag


def _tx_with_tag(db: Session, user_id: int) -> list[models.Transaction]:
    return list(
        db.scalars(
            select(models.Transaction).where(
                and_(
                    models.Transaction.user_id == user_id,
                    models.Transaction.tags.is_not(None),
                )
            )
        )
    )


def _get_standalone_tag(
    db: Session, user_id: int, name: str
) -> models.Tag | None:
    return db.scalar(
        select(models.Tag).where(
            and_(models.Tag.user_id == user_id, models.Tag.name == name)
        )
    )


def rename_tag(db: Session, user_id: int, old_name: str, new_name: str) -> int:
    old_name = (old_name or "").strip()
    new_name = (new_name or "").strip()
    if not old_name or not new_name:
        raise ValueError("empty_name")
    if old_name == new_name:
        return 0

    # Update the standalone Tag entry if one exists. If a Tag with the
    # target name is already present, drop the old row (the target wins).
    old_tag = _get_standalone_tag(db, user_id, old_name)
    if old_tag is not None:
        existing = _get_standalone_tag(db, user_id, new_name)
        if existing is not None and existing.id != old_tag.id:
            db.delete(old_tag)
        else:
            old_tag.name = new_name[:64]

    affected = 0
    for tx in _tx_with_tag(db, user_id):
        if not tx.tags or old_name not in tx.tags:
            continue
        new_tags: list[str] = []
        for t in tx.tags:
            v = new_name if t == old_name else t
            if v not in new_tags:
                new_tags.append(v)
        tx.tags = new_tags or None
        affected += 1

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    return affected


def delete_tag(db: Session, user_id: int, name: str) -> int:
    name = (name or "").strip()
    if not name:
        return 0

    tag = _get_standalone_tag(db, user_id, name)
    if tag is not None:
        db.delete(tag)

    affected = 0
    for tx in _tx_with_tag(db, user_id):
        if not tx.tags or name not in tx.tags:
            continue
        new_tags = [t for t in tx.tags if t != name]
        tx.tags = new_tags or None
        affected += 1

    db.commit()
    return affected


# ---------- User Settings ----------

def get_or_create_settings(db: Session, user_id: int) -> models.UserSettings:
    s = db.scalar(
        select(models.UserSettings).where(models.UserSettings.user_id == user_id)
    )
    if s is not None:
        return s
    s = models.UserSettings(user_id=user_id)
    db.add(s)
    try:
        db.commit()
    except IntegrityError:
        # Concurrent insert — fetch the winner.
        db.rollback()
        s = db.scalar(
            select(models.UserSettings).where(models.UserSettings.user_id == user_id)
        )
        if s is None:
            raise
    else:
        db.refresh(s)
    return s


def update_settings(
    db: Session, user_id: int, payload: schemas.SettingsUpdate
) -> models.UserSettings:
    s = get_or_create_settings(db, user_id)
    data = payload.model_dump(exclude_none=True)
    for k, v in data.items():
        setattr(s, k, v)
    if data:
        db.commit()
        db.refresh(s)
    return s


def delete_transaction(db: Session, user_id: int, tx_id: int) -> bool:
    tx = db.scalar(
        select(models.Transaction).where(
            and_(
                models.Transaction.id == tx_id,
                models.Transaction.user_id == user_id,
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
        raise ValueError(f"Betrag nicht erkennbar: {s!r}")


def _build_transaction(row: dict, db: Session, user_id: int) -> models.Transaction | None:
    r = {_norm_key(k): (v or "").strip() for k, v in row.items() if k is not None}
    if not r:
        return None
    if not any(r.values()):
        return None  # skip empty rows

    if not r.get("amount"):
        raise ValueError("Spalte 'amount' fehlt oder leer")
    if not r.get("date"):
        raise ValueError("Spalte 'date' fehlt oder leer")

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
            raise ValueError("Typ unbekannt und Betrag = 0")
    if amount < 0:
        amount = -amount
    if amount == 0:
        raise ValueError("Betrag darf nicht 0 sein")

    desc = (r.get("description") or r.get("desc") or "").strip()[:255]

    cat = get_or_create_category(db, user_id, r.get("category") or "Sonstiges")

    tags_raw = r.get("tags") or ""
    tags = [t.strip() for t in tags_raw.split(",") if t.strip()] or None

    return models.Transaction(
        user_id=user_id,
        amount=amount,
        description=desc,
        category_id=cat.id,
        date=date_val,
        type=tx_type,
        tags=tags,
    )


def import_csv(db: Session, user_id: int, text: str) -> dict:
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
        return {"imported": 0, "skipped": 0, "errors": [{"row": 1, "reason": "Header fehlt"}]}

    imported = 0
    skipped = 0
    errors: list[dict] = []

    for idx, row in enumerate(reader, start=2):
        try:
            tx = _build_transaction(row, db, user_id)
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
