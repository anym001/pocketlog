"""Tag CRUD plus the tag-name → ORM resolvers.

The resolvers (``_build_tag_cache``, ``_resolve_tags_cached``,
``_resolve_tags``) are shared infrastructure: transactions, recurring rules
and CSV import all turn user-supplied tag-name strings into ``models.Tag``
rows through them. They are intentionally collision-folded to match
``schemas._normalise_tags``.
"""

from datetime import date as date_type
from datetime import timedelta

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import exceptions, models, schemas


def _build_tag_cache(db: Session, user_id: int) -> dict[str, models.Tag]:
    """One SELECT of every tag the user owns, keyed by case-fold name.

    Tag counts per user are small (tens to a few hundred), so caching
    the whole set once per write is cheaper than N point-lookups — and
    crucial for CSV import where _resolve_tags runs per row."""
    return {
        tag.name.casefold(): tag
        for tag in db.scalars(select(models.Tag).where(models.Tag.user_id == user_id))
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
    return _resolve_tags_cached(db, user_id, names, _build_tag_cache(db, user_id))


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
    recent = case((models.Transaction.date >= cutoff, 1), else_=0)
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


def _find_tag_by_name(db: Session, user_id: int, name: str) -> models.Tag | None:
    """Case-insensitive tag lookup. ``casefold`` runs Python-side
    because some MariaDB collations (utf8mb4_general_ci) treat
    ``ß ≠ ss``, which would let two tag rows coexist that the rest of
    the codebase considers identical."""
    folded = name.casefold()
    for tag in db.scalars(select(models.Tag).where(models.Tag.user_id == user_id)):
        if tag.name.casefold() == folded:
            return tag
    return None


def create_tag(db: Session, user_id: int, name: str) -> models.Tag:
    name = (name or "").strip()
    if not name:
        raise exceptions.EmptyNameError()
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
        raise exceptions.EmptyNameError()

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
