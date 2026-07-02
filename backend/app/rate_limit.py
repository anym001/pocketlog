"""In-memory per-IP throttle for the unauthenticated auth endpoints.

Complements the per-user lockout in ``app.auth``: that one counts failures
per *account*, so it neither slows an attacker who distributes guesses
across many usernames nor protects a known username from being hammered
into permanent lockout by a third party. This module counts failures per
*source IP* with the same exponential-backoff shape (threshold, doubling,
cap — knobs in ``app.constants``, overridable via ``LOGIN_IP_*`` env vars).

Process-local by design: this deployment is a single container (see
CLAUDE.md), mirroring the damped session cleanup in ``app.auth``. State is
bounded (``_MAX_TRACKED_IPS``) and entries age out after the failure window.

IP resolution is deliberately NOT ``logging_config.client_ip``: that helper
prefers the *first* X-Forwarded-For entry, which the client itself can seed
even behind an honest proxy — fine for audit context, useless as a throttle
key. Here the *rightmost* forwarded entry wins: honest proxies append, so
the rightmost value was written by our own trusted proxy and names the peer
that actually connected to it.
"""

from __future__ import annotations

import os
import threading
from datetime import UTC, datetime, timedelta

from fastapi import Request

from . import constants
from .proxies import is_trusted_peer


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
        return v if v > 0 else default
    except ValueError:
        return default


IP_LOCKOUT_THRESHOLD = _env_int(
    "LOGIN_IP_LOCKOUT_THRESHOLD", constants.IP_LOCKOUT_THRESHOLD
)
IP_LOCKOUT_MAX_SECONDS = _env_int(
    "LOGIN_IP_LOCKOUT_MAX_SECONDS", constants.IP_LOCKOUT_MAX_SECONDS
)
IP_FAILURE_WINDOW_SECONDS = _env_int(
    "LOGIN_IP_FAILURE_WINDOW_SECONDS", constants.IP_FAILURE_WINDOW_SECONDS
)

# Hard bound on tracked IPs so an attacker rotating source addresses can't
# grow this dict without limit. When full, expired entries are pruned first,
# then the stalest ones.
_MAX_TRACKED_IPS = 10_000


class _IpState:
    __slots__ = ("failures", "last_failure_at", "blocked_until")

    def __init__(self) -> None:
        self.failures = 0
        self.last_failure_at = _utcnow()
        self.blocked_until: datetime | None = None


_states: dict[str, _IpState] = {}
_lock = threading.Lock()


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def limiter_ip(request: Request) -> str:
    """The throttle key for this request — see module docstring for why
    this intentionally differs from ``logging_config.client_ip``."""
    peer = request.client.host if request.client else None
    if peer and is_trusted_peer(peer):
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            last = xff.split(",")[-1].strip()
            if last:
                return last
        xri = request.headers.get("x-real-ip", "").strip()
        if xri:
            return xri
    return peer or "unknown"


def check_blocked(ip: str) -> int | None:
    """Remaining block seconds for *ip* (≥ 1), or ``None`` if not blocked."""
    with _lock:
        state = _states.get(ip)
        if state is None or state.blocked_until is None:
            return None
        remaining = (state.blocked_until - _utcnow()).total_seconds()
        if remaining <= 0:
            return None
        return max(1, int(remaining))


def record_failure(ip: str) -> int | None:
    """Count one failed attempt from *ip*. Returns the block duration in
    seconds if this failure put (or extended) the IP into a block, else
    ``None``. Mirrors ``auth.record_failed_login``'s backoff shape."""
    with _lock:
        now = _utcnow()
        state = _states.get(ip)
        if state is None:
            if len(_states) >= _MAX_TRACKED_IPS:
                _evict(now)
            state = _IpState()
            _states[ip] = state
        elif (now - state.last_failure_at).total_seconds() > IP_FAILURE_WINDOW_SECONDS:
            # Stale window: past failures no longer count.
            state.failures = 0
            state.blocked_until = None
        state.failures += 1
        state.last_failure_at = now
        if state.failures >= IP_LOCKOUT_THRESHOLD:
            seconds = min(
                IP_LOCKOUT_MAX_SECONDS, 2 ** (state.failures - IP_LOCKOUT_THRESHOLD)
            )
            state.blocked_until = now + timedelta(seconds=seconds)
            return seconds
        return None


def _evict(now: datetime) -> None:
    """Prune under ``_lock``: drop expired entries; if the dict is still at
    the bound, drop the stalest half so the insert path stays O(1) most of
    the time instead of evicting one-by-one under attack."""
    expired = [
        ip
        for ip, st in _states.items()
        if (now - st.last_failure_at).total_seconds() > IP_FAILURE_WINDOW_SECONDS
        and (st.blocked_until is None or st.blocked_until <= now)
    ]
    for ip in expired:
        del _states[ip]
    if len(_states) >= _MAX_TRACKED_IPS:
        stalest = sorted(_states.items(), key=lambda kv: kv[1].last_failure_at)
        for ip, _ in stalest[: _MAX_TRACKED_IPS // 2]:
            del _states[ip]


def reset() -> None:
    """Clear all throttle state. Test isolation only."""
    with _lock:
        _states.clear()
