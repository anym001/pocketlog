"""API key management: creation, listing, and revocation.

Keys are stored as SHA-256 hashes (``key_hash``) so a DB leak cannot be
replayed. The raw token (``plk_<base64url>``) is returned exactly once at
creation time via ``create_api_key`` and never persisted.
"""

import hashlib
import json
import secrets
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models

_API_KEY_PREFIX = "plk_"


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def create_api_key(
    db: Session,
    user_id: int,
    name: str,
    scopes: list[str],
) -> tuple[models.ApiKey, str]:
    """Create and persist a new API key.

    Returns ``(ApiKey row, raw_key)``. The raw key is the only opportunity
    to retrieve the plaintext — callers must surface it to the user
    immediately and never store it server-side.
    """
    raw = _API_KEY_PREFIX + secrets.token_urlsafe(32)
    key_hash = hashlib.sha256(raw.encode()).hexdigest()
    api_key = models.ApiKey(
        user_id=user_id,
        name=name,
        key_hash=key_hash,
        scopes=json.dumps(scopes),
        created_at=_utcnow(),
    )
    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    return api_key, raw


def list_api_keys(db: Session, user_id: int) -> list[models.ApiKey]:
    return list(
        db.scalars(
            select(models.ApiKey)
            .where(models.ApiKey.user_id == user_id)
            .order_by(models.ApiKey.created_at)
        )
    )


def revoke_api_key(db: Session, user_id: int, key_id: int) -> bool:
    """Delete a key owned by ``user_id``. Returns True on success, False if
    the key does not exist or belongs to a different user."""
    api_key = db.get(models.ApiKey, key_id)
    if api_key is None or api_key.user_id != user_id:
        return False
    db.delete(api_key)
    db.commit()
    return True


def get_api_key_by_hash(db: Session, key_hash: str) -> models.ApiKey | None:
    return db.scalar(select(models.ApiKey).where(models.ApiKey.key_hash == key_hash))
