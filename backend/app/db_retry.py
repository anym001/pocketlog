"""Retry helper for transient database write conflicts.

Some MariaDB deployments (Galera and other optimistic-locking setups) raise
``OperationalError 1020`` — "Record has changed since last read in table ...;
try restarting transaction" — when two statements update the *same row*
concurrently, instead of blocking the second writer like standalone InnoDB
does. PocketLog hits this when the offline outbox reconnects: a burst of
replayed writes, plus the sliding session refresh that runs on every request,
land on the same row at once. Deadlocks (1213) and lock-wait timeouts (1205)
are transient in the same way.

Retrying the whole read-modify-write resolves all three. A standalone-InnoDB
or SQLite deployment simply never raises these codes, so the retry path is
dormant there.
"""

import time
from collections.abc import Callable
from typing import Any

from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

# MariaDB/MySQL error codes that mean "transient conflict — restart the tx".
# 1020 = ER_CHECKREAD (optimistic-locking row conflict), 1213 = deadlock,
# 1205 = lock-wait timeout.
_RETRYABLE_CODES = frozenset({1020, 1205, 1213})


def is_retryable_operational_error(exc: OperationalError) -> bool:
    """True when the DBAPI error code marks a transient, retryable conflict."""
    orig = getattr(exc, "orig", None)
    args = getattr(orig, "args", None)
    return bool(args) and args[0] in _RETRYABLE_CODES


def run_with_retry(db: Session, op: Callable[[], Any], *, attempts: int = 3) -> Any:
    """Run a read-modify-write ``op`` (which must issue its own ``commit``),
    retrying from scratch on a transient conflict. Returns whatever ``op``
    returns.

    ``op`` re-reads inside the same session on every call, so a rolled-back
    attempt starts clean. Non-retryable errors — and the final attempt —
    propagate unchanged.
    """
    for attempt in range(attempts):
        try:
            return op()
        except OperationalError as exc:
            db.rollback()
            if attempt == attempts - 1 or not is_retryable_operational_error(exc):
                raise
            # Small staggered backoff so colliding writers don't lock-step
            # straight back into the same conflict.
            time.sleep(0.01 * (attempt + 1))
