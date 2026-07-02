"""JSON full-account backup: export and restore.

Export walks every user-scoped domain and serialises it into the versioned
``schemas.BackupFile`` shape; restore parses that same shape back. Objects
reference each other by their user-visible unique names (category / rule
names), never by database id, so a backup survives the move to a fresh
install where the autoincrement counters differ.

Restore is deliberately a *restore*, not a merge: the router guards it with
``has_ledger_data`` so it only ever runs against an account without ledger
data (transactions, goals, budgets, recurring rules). Categories and tags may
already exist (fresh accounts are seeded) and are matched by name. Recurring
cursor state (``next_occurrence_date`` / ``occurrences_count``) is restored
verbatim so the catch-up engine doesn't re-materialize occurrences that are
already part of the restored history.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas
from .budgets import list_budgets
from .categories import list_categories
from .goals import list_goals
from .recurring import list_recurring_rules
from .settings import get_or_create_settings
from .tags import _build_tag_cache, _resolve_tags_cached
from .transactions import list_all_transactions


def export_backup(
    db: Session,
    user_id: int,
    *,
    exported_at: datetime,
    app_version: str,
) -> schemas.BackupFile:
    """Serialise the user's complete account into a BackupFile."""
    settings = get_or_create_settings(db, user_id)
    categories = list_categories(db, user_id)
    cat_names = {c.id: c.name for c in categories}
    rules = list_recurring_rules(db, user_id)
    rule_names = {r.id: r.name for r in rules}
    tags = list(
        db.scalars(
            select(models.Tag)
            .where(models.Tag.user_id == user_id)
            .order_by(models.Tag.name)
        )
    )
    return schemas.BackupFile(
        format=schemas.BACKUP_FORMAT,
        version=schemas.BACKUP_VERSION,
        exported_at=exported_at,
        app_version=app_version,
        settings=schemas.BackupSettings.model_validate(settings),
        categories=[schemas.BackupCategory.model_validate(c) for c in categories],
        tags=[t.name for t in tags],
        transactions=[
            schemas.BackupTransaction(
                date=t.date,
                type=t.type,
                amount=t.amount,
                description=t.description,
                category=cat_names[t.category_id],
                # Truncated to the write-path cap: legacy rows from before
                # the cap may carry more, and one such row must not fail the
                # whole export (nor its own restore later).
                tags=[tag.name for tag in t.tags][: schemas.MAX_TAGS_PER_TX],
                rule=rule_names.get(t.source_rule_id),
                import_hash=t.import_hash,
            )
            for t in list_all_transactions(db, user_id)
        ],
        goals=[
            schemas.BackupGoal(
                name=g.name,
                direction=g.direction,
                category=cat_names[g.category_id],
                initial_amount=g.initial_amount,
                target_amount=g.target_amount,
                start_date=g.start_date,
                icon=g.icon,
                color=g.color,
            )
            for g in list_goals(db, user_id)
        ],
        budgets=[
            schemas.BackupBudget(
                category=cat_names[b.category_id],
                amount=b.amount,
                frequency=b.frequency,
            )
            for b in list_budgets(db, user_id)
        ],
        recurring_rules=[
            schemas.BackupRecurringRule(
                name=r.name,
                amount=r.amount,
                type=r.type,
                category=cat_names[r.category_id],
                description=r.description,
                tags=[tag.name for tag in r.tags],
                frequency=r.frequency,
                interval=r.interval,
                weekday=r.weekday,
                day_of_month=r.day_of_month,
                start_date=r.start_date,
                end_date=r.end_date,
                max_occurrences=r.max_occurrences,
                active=r.active,
                next_occurrence_date=r.next_occurrence_date,
                occurrences_count=r.occurrences_count,
                skips=[s.skip_date for s in r.skips],
            )
            for r in rules
        ],
    )


def has_ledger_data(db: Session, user_id: int) -> bool:
    """True if the account holds any ledger data a restore would collide
    with. Categories and tags don't count — fresh accounts are seeded with
    default categories, and both are merged by name on restore."""
    for model in (
        models.Transaction,
        models.Goal,
        models.Budget,
        models.RecurringRule,
    ):
        if (
            db.scalar(select(model.id).where(model.user_id == user_id).limit(1))
            is not None
        ):
            return True
    return False


def restore_backup(
    db: Session, user_id: int, backup: schemas.BackupFile
) -> dict[str, int]:
    """Restore a validated BackupFile into the user's account.

    Caller must have checked ``has_ledger_data`` first. Everything lands in
    one transaction — a mid-way IntegrityError (e.g. a crafted file with
    duplicate rule names) rolls the whole restore back; the router maps it
    to a stable 409. Returns per-domain created counts.
    """
    counts = {
        "categories": 0,
        "tags": 0,
        "transactions": len(backup.transactions),
        "goals": len(backup.goals),
        "budgets": len(backup.budgets),
        "recurring_rules": len(backup.recurring_rules),
    }

    # Categories: merge by exact name (mirrors get_or_create_category).
    # Listed entries update icon/color on an existing match; entries only
    # *referenced* by other objects are created with defaults on demand.
    categories = {c.name: c for c in list_categories(db, user_id)}

    def _category(name: str) -> models.Category:
        cat = categories.get(name)
        if cat is None:
            cat = models.Category(user_id=user_id, name=name)
            db.add(cat)
            db.flush()
            categories[name] = cat
            counts["categories"] += 1
        return cat

    for bc in backup.categories:
        cat = categories.get(bc.name)
        if cat is None:
            cat = models.Category(
                user_id=user_id, name=bc.name, icon=bc.icon, color=bc.color
            )
            db.add(cat)
            db.flush()
            categories[bc.name] = cat
            counts["categories"] += 1
        else:
            cat.icon = bc.icon
            cat.color = bc.color

    # Tags: merged case-insensitively through the shared resolver — the same
    # semantics every other tag write path uses.
    tag_cache = _build_tag_cache(db, user_id)
    known_tags = len(tag_cache)
    _resolve_tags_cached(db, user_id, list(backup.tags), tag_cache)

    # Recurring rules first, so transactions can link back to them by name.
    rules_by_name: dict[str, models.RecurringRule] = {}
    for br in backup.recurring_rules:
        rule = models.RecurringRule(
            user_id=user_id,
            name=br.name,
            amount=br.amount,
            type=br.type,
            category_id=_category(br.category).id,
            description=br.description,
            frequency=br.frequency,
            interval=br.interval,
            weekday=br.weekday if br.frequency == "weekly" else None,
            day_of_month=(
                br.day_of_month
                if br.frequency in ("monthly", "quarterly", "yearly")
                else None
            ),
            start_date=br.start_date,
            end_date=br.end_date,
            max_occurrences=br.max_occurrences,
            next_occurrence_date=br.next_occurrence_date,
            occurrences_count=br.occurrences_count,
            active=br.active,
        )
        rule.tags = _resolve_tags_cached(db, user_id, br.tags, tag_cache)
        db.add(rule)
        db.flush()
        # set() dedupes crafted duplicates that would trip the composite PK.
        for skip_date in sorted(set(br.skips)):
            db.add(models.RecurringRuleSkip(rule_id=rule.id, skip_date=skip_date))
        rules_by_name[br.name] = rule

    for i, bt in enumerate(backup.transactions):
        rule = rules_by_name.get(bt.rule) if bt.rule else None
        tx = models.Transaction(
            user_id=user_id,
            amount=bt.amount,
            description=bt.description,
            category_id=_category(bt.category).id,
            date=bt.date,
            type=bt.type,
            source_rule_id=rule.id if rule is not None else None,
            import_hash=bt.import_hash,
        )
        tx.tags = _resolve_tags_cached(db, user_id, bt.tags, tag_cache)
        db.add(tx)
        if (i + 1) % 500 == 0:
            db.flush()

    for bg in backup.goals:
        db.add(
            models.Goal(
                user_id=user_id,
                name=bg.name,
                direction=bg.direction,
                category_id=_category(bg.category).id,
                initial_amount=bg.initial_amount,
                target_amount=bg.target_amount,
                start_date=bg.start_date,
                icon=bg.icon,
                color=bg.color,
            )
        )

    for bb in backup.budgets:
        db.add(
            models.Budget(
                user_id=user_id,
                category_id=_category(bb.category).id,
                amount=bb.amount,
                frequency=bb.frequency,
            )
        )

    if backup.settings is not None:
        settings = get_or_create_settings(db, user_id)
        settings.theme = backup.settings.theme
        settings.default_view = backup.settings.default_view
        settings.locale = backup.settings.locale
        settings.currency = backup.settings.currency

    counts["tags"] = len(tag_cache) - known_tags
    db.commit()
    return counts
