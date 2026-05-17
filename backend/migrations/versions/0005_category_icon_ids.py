"""widen categories.icon and migrate stored emoji glyphs to Phosphor IDs

Revision ID: 0005_category_icon_ids
Revises: 0004_user_settings
Create Date: 2026-05-17

The category icon used to be an emoji glyph stored as VARCHAR(8). We now
ship a curated Phosphor sprite (frontend/icons/categories/sprite.svg) and
persist its icon ID (e.g. ``house``, ``shopping-cart``) instead — a slug
that doesn't fit into 8 chars and isn't a single grapheme cluster anymore.

The column is widened to VARCHAR(64) and existing rows are remapped via a
table of the default emojis the app shipped with, plus the most common
emojis users typed in by hand. Anything we don't recognise falls back to
``package`` (the existing "Sonstiges" / fallback glyph), which the
frontend renders gracefully.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0005_category_icon_ids"
down_revision: Union[str, None] = "0004_user_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Mapping from previously-stored emoji glyphs to the icon IDs in the new
# sprite. Covers the seven default categories plus a handful of obvious
# stand-ins (food, transport, finance) so users who customised their icons
# don't suddenly all show the fallback box.
EMOJI_TO_ID: dict[str, str] = {
    # defaults
    "🛒": "shopping-cart",
    "🏠": "house",
    "🚗": "car",
    "🎬": "film-strip",
    "💊": "pill",
    "📦": "package",
    "💰": "wallet",
    # common stand-ins
    "🏡": "house",
    "🏢": "buildings",
    "🛏️": "bed",
    "🛋️": "armchair",
    "📺": "television",
    "💡": "lightbulb",
    "🔑": "key",
    "🔧": "wrench",
    "🔨": "hammer",
    "🧹": "broom",
    "👕": "t-shirt",
    "👗": "dress",
    "👟": "sneaker",
    "✂️": "scissors",
    "🚿": "shower",
    "🍞": "bread",
    "🍔": "hamburger",
    "🍕": "pizza",
    "🍪": "cookie",
    "🎂": "cake",
    "☕": "coffee",
    "🍺": "beer-stein",
    "🍷": "wine",
    "🍸": "martini",
    "🍽️": "fork-knife",
    "🚕": "taxi",
    "🚌": "bus",
    "🚆": "train",
    "✈️": "airplane",
    "🚲": "bicycle",
    "⛽": "gas-pump",
    "🎮": "game-controller",
    "🎵": "music-note",
    "📖": "book-open",
    "📚": "book",
    "🎁": "gift",
    "🎟️": "ticket",
    "⚽": "soccer-ball",
    "❤️": "heart",
    "🩺": "stethoscope",
    "🦷": "tooth",
    "🐶": "dog",
    "💼": "briefcase",
    "🎓": "graduation-cap",
    "✏️": "pencil",
    "💻": "laptop",
    "💳": "credit-card",
    "🏦": "bank",
    "🪙": "coins",
    "🐷": "piggy-bank",
    "€": "currency-eur",
    "🧾": "receipt",
    "⭐": "star",
    "🌍": "globe",
}


def upgrade() -> None:
    # Widen first so the longer slugs (`shopping-cart`, `film-strip`, …)
    # fit before we rewrite any rows.
    op.alter_column(
        "categories",
        "icon",
        existing_type=sa.String(8),
        type_=sa.String(64),
        existing_nullable=False,
    )

    # Remap stored emoji glyphs to the new icon IDs.
    for emoji, slug in EMOJI_TO_ID.items():
        op.execute(
            sa.text("UPDATE categories SET icon = :slug WHERE icon = :emoji").bindparams(
                slug=slug, emoji=emoji
            )
        )

    # Anything that isn't already a valid slug (i.e. an unmapped emoji or
    # other non-ASCII glyph) falls back to `package`. The frontend renders
    # unknown IDs as that glyph too, but storing the canonical slug keeps
    # the DB self-consistent and lets the API validation pass on later
    # edits.
    op.execute(
        sa.text(
            "UPDATE categories SET icon = 'package' "
            "WHERE icon NOT REGEXP '^[a-z0-9][a-z0-9-]*$'"
        )
    )


def downgrade() -> None:
    # Best-effort reverse mapping for the seven defaults; everything else
    # collapses to the box emoji. The column is then narrowed again. This
    # path exists for completeness — it loses information.
    reverse = {
        "shopping-cart": "🛒",
        "house": "🏠",
        "car": "🚗",
        "film-strip": "🎬",
        "pill": "💊",
        "package": "📦",
        "wallet": "💰",
    }
    # First map slugs that survive the narrowing (all 1-char emojis fit in
    # VARCHAR(8)).
    for slug, emoji in reverse.items():
        op.execute(
            sa.text("UPDATE categories SET icon = :emoji WHERE icon = :slug").bindparams(
                emoji=emoji, slug=slug
            )
        )
    # Anything left that's longer than 8 chars (other Phosphor IDs) → box.
    op.execute(
        sa.text("UPDATE categories SET icon = '📦' WHERE CHAR_LENGTH(icon) > 8")
    )
    op.alter_column(
        "categories",
        "icon",
        existing_type=sa.String(64),
        type_=sa.String(8),
        existing_nullable=False,
    )
