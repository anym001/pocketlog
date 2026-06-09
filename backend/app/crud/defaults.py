"""Seed data and deployment defaults shared across the crud package.

Kept dependency-free (only schemas) so every other crud submodule can import
from here without risking an import cycle.
"""

import logging
import os

from .. import schemas

logger = logging.getLogger("pocketlog.crud")

# Default categories seeded once per user. Each entry carries a stable
# ``key`` plus its icon/color; the human-readable name is looked up per
# language in DEFAULT_CATEGORY_NAMES so a new user gets them in the
# language chosen at creation. Once seeded they are plain user data —
# renaming or deleting never re-translates them.
DEFAULT_CATEGORIES: list[dict] = [
    {"key": "groceries", "icon": "shopping-cart", "color": "#c8623a"},
    {"key": "housing", "icon": "house", "color": "#8a6a4a"},
    {"key": "mobility", "icon": "car", "color": "#6a8a8a"},
    {"key": "leisure", "icon": "film-strip", "color": "#a45ab0"},
    {"key": "health", "icon": "pill", "color": "#3a7d5c"},
    {"key": "other", "icon": "package", "color": "#9e9b96"},
    {"key": "salary", "icon": "wallet", "color": "#3a7d5c"},
]

DEFAULT_CATEGORY_NAMES: dict[str, dict[str, str]] = {
    "de": {
        "groceries": "Lebensmittel",
        "housing": "Wohnen",
        "mobility": "Mobilität",
        "leisure": "Freizeit",
        "health": "Gesundheit",
        "other": "Sonstiges",
        "salary": "Gehalt",
    },
    "en": {
        "groceries": "Groceries",
        "housing": "Housing",
        "mobility": "Transport",
        "leisure": "Leisure",
        "health": "Health",
        "other": "Other",
        "salary": "Salary",
    },
}


# Deployment defaults: ENV overrides the built-in fallback, a per-user
# DB setting overrides ENV. Lets an operator ship e.g. an en-GB instance
# without touching code, while users still pick their own locale.
def _resolve_default_locale() -> str:
    raw = os.environ.get("DEFAULT_LOCALE")
    if raw:
        try:
            return schemas._normalise_locale(raw)
        except ValueError:
            logger.warning("Invalid DEFAULT_LOCALE=%r — using de-DE", raw)
    return "de-DE"


def _resolve_default_currency() -> str:
    raw = os.environ.get("DEFAULT_CURRENCY")
    if raw:
        try:
            return schemas._normalise_currency(raw)
        except ValueError:
            logger.warning("Invalid DEFAULT_CURRENCY=%r — using EUR", raw)
    return "EUR"


DEFAULT_LOCALE = _resolve_default_locale()
DEFAULT_CURRENCY = _resolve_default_currency()
