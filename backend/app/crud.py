import csv
import io
import logging
from datetime import date as date_type, datetime, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import and_, case, delete, extract, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import auth, models, schemas

logger = logging.getLogger("uvicorn.error")

DEFAULT_CATEGORIES: list[dict] = [
    {"name": "Lebensmittel", "icon": "shopping-cart", "color": "#c8623a"},
    {"name": "Wohnen", "icon": "house", "color": "#8a6a4a"},
    {"name": "Mobilität", "icon": "car", "color": "#6a8a8a"},
    {"name": "Freizeit", "icon": "film-strip", "color": "#a45ab0"},
    {"name": "Gesundheit", "icon": "pill", "color": "#3a7d5c"},
    {"name": "Sonstiges", "icon": "package", "color": "#9e9b96"},
    {"name": "Gehalt", "icon": "wallet", "color": "#3a7d5c"},
]


# ---------- Users ----------

def get_user_by_username(db: Session, username: str) -> models.User | None:
    return db.scalar(
        select(models.User).where(models.User.username == username)
    )


def get_user_by_id(db: Session, user_id: int) -> models.User | None:
    return db.get(models.User, user_id)


def list_all_users(db: Session) -> list[models.User]:
    return list(
        db.scalars(select(models.User).order_by(models.User.id))
    )


def count_admins(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(models.User)
            .where(models.User.is_admin == True)  # noqa: E712
        )
        or 0
    )


def count_users(db: Session) -> int:
    return int(
        db.scalar(select(func.count()).select_from(models.User)) or 0
    )


def get_oldest_user(db: Session) -> models.User | None:
    return db.scalar(
        select(models.User).order_by(models.User.id.asc()).limit(1)
    )


def get_pending_admin(db: Session) -> models.User | None:
    """Liefert den Admin, der noch sein Passwort vergeben muss (z. B.
    nach der Migration). ``None`` wenn jeder Admin schon einen Hash
    hat oder gar kein Admin existiert."""
    return db.scalar(
        select(models.User)
        .where(models.User.is_admin == True)  # noqa: E712
        .where(models.User.password_hash.is_(None))
        .order_by(models.User.id.asc())
        .limit(1)
    )


def create_user(
    db: Session,
    *,
    username: str,
    password: str,
    is_admin: bool = False,
    force_change_password: bool = True,
) -> models.User:
    """Legt einen neuen User samt Standard-Kategorien an. Wirft
    ``IntegrityError`` bei Username-Kollision."""
    user = models.User(
        username=username,
        password_hash=auth.hash_password(password),
        is_admin=is_admin,
        is_active=True,
        force_change_password=force_change_password,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise
    db.refresh(user)
    _seed_default_categories(db, user.id)
    return user


def set_user_password(
    db: Session, user: models.User, new_password: str, *, force_change: bool
) -> None:
    """Setzt ein neues Passwort und resettet den Brute-Force-State.
    ``force_change=True`` markiert den User für die Force-PW-View
    (Admin-Reset), ``False`` löst das Flag (normaler Self-Service-
    Change)."""
    user.password_hash = auth.hash_password(new_password)
    user.force_change_password = force_change
    user.failed_login_count = 0
    user.lockout_until = None
    db.commit()
    db.refresh(user)


def deactivate_user(db: Session, user: models.User) -> None:
    user.is_active = False
    db.commit()


def activate_user(db: Session, user: models.User) -> None:
    user.is_active = True
    db.commit()


def delete_user(db: Session, user: models.User) -> None:
    db.delete(user)
    db.commit()


# ---------- Categories ----------

def _seed_default_categories(db: Session, user_id: int) -> None:
    for c in DEFAULT_CATEGORIES:
        db.add(models.Category(user_id=user_id, **c))
    db.commit()


def list_categories(db: Session, user_id: int) -> list[models.Category]:
    return list(
        db.scalars(
            select(models.Category)
            .where(models.Category.user_id == user_id)
            .order_by(models.Category.id)
        )
    )


def get_or_create_category(db: Session, user_id: int, name: str) -> models.Category:
    # CSV import path lands here with raw cell content — apply the same
    # control-char strip as schemas._normalise_name so a CSV with a NUL
    # in the category column can't insert an unreachable row.
    name = schemas._CONTROL_CHARS.sub("", name or "").strip() or "Sonstiges"
    cat = db.scalar(
        select(models.Category).where(
            and_(models.Category.user_id == user_id, models.Category.name == name)
        )
    )
    if cat is not None:
        return cat
    cat = models.Category(user_id=user_id, name=name[:100], icon="package", color="#9e9b96")
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

# Transaction.tags already has lazy='selectin' on the relationship, so
# every list endpoint gets the tags batched in via a single extra IN
# query. The explicit selectinload here is defensive — it makes the
# eager-load policy visible at the call site and survives if the
# relationship default ever changes.
_TX_TAGS_LOAD = selectinload(models.Transaction.tags)


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
    q = q.options(_TX_TAGS_LOAD).order_by(
        models.Transaction.date.desc(), models.Transaction.id.desc()
    )
    return list(db.scalars(q))


def list_all_transactions(db: Session, user_id: int) -> list[models.Transaction]:
    q = (
        select(models.Transaction)
        .where(models.Transaction.user_id == user_id)
        .options(_TX_TAGS_LOAD)
        .order_by(models.Transaction.date.desc(), models.Transaction.id.desc())
    )
    return list(db.scalars(q))


def list_transactions_by_range(
    db: Session,
    user_id: int,
    date_from: date_type | None,
    date_to: date_type | None,
) -> list[models.Transaction]:
    q = select(models.Transaction).where(models.Transaction.user_id == user_id)
    if date_from is not None:
        q = q.where(models.Transaction.date >= date_from)
    if date_to is not None:
        q = q.where(models.Transaction.date <= date_to)
    q = q.options(_TX_TAGS_LOAD).order_by(
        models.Transaction.date.desc(), models.Transaction.id.desc()
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


def _build_tag_cache(db: Session, user_id: int) -> dict[str, models.Tag]:
    """One SELECT of every tag the user owns, keyed by case-fold name.

    Tag counts per user are small (tens to a few hundred), so caching
    the whole set once per write is cheaper than N point-lookups — and
    crucial for CSV import where _resolve_tags runs per row."""
    return {
        tag.name.casefold(): tag
        for tag in db.scalars(
            select(models.Tag).where(models.Tag.user_id == user_id)
        )
    }


def _resolve_tags_cached(
    db: Session,
    user_id: int,
    names: list[str] | None,
    cache: dict[str, models.Tag],
) -> list[models.Tag]:
    """Resolve a list of tag-name strings to ORM rows using an
    externally-managed cache. Newly created tags are inserted into the
    cache so later calls in the same batch reuse them. Case-folded
    lookup matches schemas._normalise_tags."""
    if not names:
        return []
    out: list[models.Tag] = []
    seen: set[object] = set()
    for raw in names:
        if not isinstance(raw, str):
            continue
        name = raw.strip()
        if not name:
            continue
        folded = name.casefold()
        tag = cache.get(folded)
        if tag is None:
            tag = models.Tag(user_id=user_id, name=name[: schemas.MAX_TAG_LENGTH])
            db.add(tag)
            db.flush()
            cache[folded] = tag
        key = tag.id if tag.id is not None else id(tag)
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    return out


def _resolve_tags(
    db: Session, user_id: int, names: list[str] | None
) -> list[models.Tag]:
    """One-shot resolver for single create/update calls. CSV import
    builds the cache once and uses _resolve_tags_cached directly."""
    return _resolve_tags_cached(
        db, user_id, names, _build_tag_cache(db, user_id)
    )


def create_transaction(
    db: Session, user_id: int, payload: schemas.TransactionCreate
) -> models.Transaction:
    if not _check_category_owned(db, user_id, payload.category_id):
        raise ValueError("unknown_category")
    data = payload.model_dump(by_alias=False)
    tag_names = data.pop("tags", None)
    tx = models.Transaction(user_id=user_id, **data)
    tx.tags = _resolve_tags(db, user_id, tag_names)
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
    data = payload.model_dump(by_alias=False)
    tag_names = data.pop("tags", None)
    for k, v in data.items():
        setattr(tx, k, v)
    # Replacing the collection lets SQLAlchemy diff old vs new and
    # emit the minimal INSERT/DELETE set on the junction table.
    tx.tags = _resolve_tags(db, user_id, tag_names)
    db.commit()
    db.refresh(tx)
    return tx


def list_tags(db: Session, user_id: int) -> list[dict]:
    # Names: every tag the user has — both standalone (no transactions
    # attached) and tags currently linked to one or more transactions.
    # Counts: only transactions from the last 30 days, so suggestions
    # surface tags that are currently relevant rather than long-stale.
    cutoff = date_type.today() - timedelta(days=30)

    # Single grouped query: LEFT JOIN keeps standalone tags with count 0;
    # the CASE ... date >= cutoff windows the count without filtering
    # out unused tags. Returned as a list of (name, count) pairs sorted
    # case-insensitively to match the alphabetical UI.
    recent = case(
        (models.Transaction.date >= cutoff, 1), else_=0
    )
    count_expr = func.coalesce(func.sum(recent), 0)
    rows = db.execute(
        select(models.Tag.name, count_expr)
        .select_from(models.Tag)
        .join(
            models.transaction_tags,
            models.transaction_tags.c.tag_id == models.Tag.id,
            isouter=True,
        )
        .join(
            models.Transaction,
            models.Transaction.id == models.transaction_tags.c.transaction_id,
            isouter=True,
        )
        .where(models.Tag.user_id == user_id)
        .group_by(models.Tag.id, models.Tag.name)
        .order_by(func.lower(models.Tag.name))
    ).all()
    return [{"name": name, "count": int(count or 0)} for name, count in rows]


def _find_tag_by_name(
    db: Session, user_id: int, name: str
) -> models.Tag | None:
    """Case-insensitive tag lookup. ``casefold`` runs Python-side
    because some MariaDB collations (utf8mb4_general_ci) treat
    ``ß ≠ ss``, which would let two tag rows coexist that the rest of
    the codebase considers identical."""
    folded = name.casefold()
    for tag in db.scalars(
        select(models.Tag).where(models.Tag.user_id == user_id)
    ):
        if tag.name.casefold() == folded:
            return tag
    return None


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


def rename_tag(db: Session, user_id: int, old_name: str, new_name: str) -> int:
    old_name = (old_name or "").strip()
    new_name = (new_name or "").strip()
    if not old_name or not new_name:
        raise ValueError("empty_name")

    old_tag = _find_tag_by_name(db, user_id, old_name)
    if old_tag is None:
        return 0

    target = _find_tag_by_name(db, user_id, new_name)
    if target is not None and target.id == old_tag.id:
        # Same row, casing-only change. Apply it and report no
        # transactions as "affected" — the displayed name updates
        # automatically because every linked row reads it through the
        # M2M relationship.
        if old_tag.name != new_name[:64]:
            old_tag.name = new_name[:64]
            db.commit()
        return 0

    affected = len(old_tag.transactions)

    if target is None:
        # Plain rename — no collision, just update the row.
        old_tag.name = new_name[:64]
    else:
        # A different tag with the target name already exists. Merge:
        # link every transaction from old_tag to target (skip ones
        # already linked), then drop old_tag. ON DELETE CASCADE on the
        # junction takes care of the now-orphaned old links.
        for tx in list(old_tag.transactions):
            if target not in tx.tags:
                tx.tags.append(target)
        db.delete(old_tag)

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
    tag = _find_tag_by_name(db, user_id, name)
    if tag is None:
        return 0
    affected = len(tag.transactions)
    # ON DELETE CASCADE on the junction removes the link rows.
    db.delete(tag)
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


def delete_all_transactions(db: Session, user_id: int) -> int:
    result = db.execute(
        delete(models.Transaction).where(models.Transaction.user_id == user_id)
    )
    db.commit()
    return result.rowcount or 0


def delete_all_user_data(db: Session, user_id: int) -> None:
    # Order matters: transactions reference categories with ON DELETE RESTRICT,
    # so the rows must go first or the categories delete raises IntegrityError.
    db.execute(delete(models.Transaction).where(models.Transaction.user_id == user_id))
    db.execute(delete(models.Tag).where(models.Tag.user_id == user_id))
    db.execute(delete(models.Category).where(models.Category.user_id == user_id))
    db.commit()


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


def _build_transaction(
    row: dict,
    db: Session,
    user_id: int,
    tag_cache: dict[str, models.Tag],
) -> models.Transaction | None:
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

    desc_raw = r.get("description") or r.get("desc") or ""
    desc = schemas._CONTROL_CHARS.sub("", desc_raw).strip()[:255]

    cat = get_or_create_category(db, user_id, r.get("category") or "Sonstiges")

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


def import_csv(db: Session, user_id: int, text: str, max_rows: int = 10_000) -> dict:
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

    # One tag-cache for the whole import — keeps row-by-row tag
    # resolution at O(distinct tags) instead of O(rows × tags).
    tag_cache = _build_tag_cache(db, user_id)

    for idx, row in enumerate(reader, start=2):
        if idx - 1 > max_rows:
            # Stop the loop before allocating a transaction for the next
            # row, then surface the truncation as an error entry. The
            # 5 MB byte cap upstream protects RAM, the row cap protects
            # the worker process from minute-long parse loops.
            errors.append({
                "row": idx,
                "reason": f"Limit von {max_rows} Zeilen überschritten – Rest übersprungen.",
            })
            break
        try:
            tx = _build_transaction(row, db, user_id, tag_cache)
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
    except IntegrityError:
        # The raw exception contains MariaDB column/constraint names, which
        # would leak schema details to the API client. Log the detail
        # server-side and return a generic message.
        logger.exception("CSV import IntegrityError for user_id=%s", user_id)
        db.rollback()
        return {
            "imported": 0,
            "skipped": imported + skipped,
            "errors": [{"row": 0, "reason": "Datenbankkonflikt beim Speichern. Bitte erneut versuchen."}],
        }

    return {"imported": imported, "skipped": skipped, "errors": errors}
