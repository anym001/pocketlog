"""Cross-domain CRUD helpers below the per-domain modules.

The lowest-level leaf of the crud package (imports nothing from its
siblings), so every domain module may import from here without creating a
cycle. Not part of the public ``crud.*`` surface — these helpers are
internal to the package.
"""

from sqlalchemy import and_, select
from sqlalchemy.orm import Session


def _get_owned(db: Session, model_cls, user_id: int, item_id: int):
    """The user-scoped primary-key lookup shared by every domain.

    Returns the row, or ``None`` both when the id does not exist and when it
    belongs to another user — deliberately the same answer, so endpoints
    never leak row existence across users (404 either way).
    """
    return db.scalar(
        select(model_cls).where(
            and_(model_cls.id == item_id, model_cls.user_id == user_id)
        )
    )
