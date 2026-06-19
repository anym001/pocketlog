"""Trusted reverse-proxy resolution.

Two independent decisions hinge on the same question — *is the immediate peer
a reverse proxy we trust to set ``X-Forwarded-*`` headers?*:

- the audit client-IP resolver (``logging_config.client_ip``) decides whether
  to believe ``X-Real-IP`` / ``X-Forwarded-For`` for the audit trail;
- the Secure-cookie decision (``deps._cookie_secure``) decides whether to
  believe ``X-Forwarded-Proto`` when ``SESSION_COOKIE_SECURE=auto``.

Centralising the trust check here keeps the two in lock-step and closes the gap
where any direct client could forge ``X-Forwarded-Proto`` to flip the Secure
flag on the session cookie.

``TRUSTED_PROXIES`` — comma-separated IPs/CIDRs, or ``*`` for all:
    empty (default)  trust the standard private and loopback ranges, so the
                     common "container on a private Docker/LAN network behind a
                     reverse proxy" deployment works without any configuration.
    explicit list    trust exactly those networks (replaces the defaults) —
                     e.g. ``172.16.0.0/12,192.168.1.1``.
    ``*``            trust every peer; fine for single-proxy setups where the
                     container port is not reachable from untrusted networks.

The resolved trust governs forwarded headers only — never authorization. A
spoofed header can at worst mislabel an audit IP or the Secure flag, both of
which are gated by the trust check above.
"""

import ipaddress
import logging
import os

_Network = ipaddress.IPv4Network | ipaddress.IPv6Network

# Standard private + loopback ranges trusted when TRUSTED_PROXIES is unset.
# Mirrors the defaults reverse proxies (and e.g. Authentik) assume for a
# typical home-server / Docker deployment.
_PRIVATE_DEFAULTS = (
    "127.0.0.0/8",  # IPv4 loopback
    "10.0.0.0/8",  # RFC 1918
    "172.16.0.0/12",  # RFC 1918 (Docker bridge range)
    "192.168.0.0/16",  # RFC 1918
    "::1/128",  # IPv6 loopback
    "fe80::/10",  # IPv6 link-local
)


def _parse(env: str) -> list[_Network] | None:
    """Parse ``TRUSTED_PROXIES``.

    Returns ``None`` for the wildcard ``*`` (trust all), otherwise a list of
    networks: the explicit entries when given, else the private-range defaults.
    """
    raw = env.strip()
    if raw == "*":
        return None  # trust all
    parts = (
        [p.strip() for p in raw.split(",") if p.strip()]
        if raw
        else list(_PRIVATE_DEFAULTS)
    )
    networks: list[_Network] = []
    for part in parts:
        try:
            networks.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            logging.getLogger("pocketlog").warning(
                "TRUSTED_PROXIES: invalid entry %r ignored", part
            )
    return networks


_TRUSTED_NETWORKS = _parse(os.environ.get("TRUSTED_PROXIES", ""))


def is_trusted_peer(peer: str | None) -> bool:
    """True if *peer* (an IP string) is a trusted reverse proxy and may set
    ``X-Forwarded-*`` headers.

    The wildcard config trusts everyone; a missing or unparseable peer is
    never trusted.
    """
    if _TRUSTED_NETWORKS is None:
        return True  # wildcard
    if not peer:
        return False
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in net for net in _TRUSTED_NETWORKS)
