import re
from datetime import date as date_type
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Bounds for the tags array on a single transaction. The list cap keeps a
# rogue payload from filling the JSON column with thousands of items
# (each tag would then have to be rendered, aggregated and serialised on
# every read); the item-length cap matches the dedicated /api/tags
# endpoint's max_length=64.
MAX_TAGS_PER_TX = 20
MAX_TAG_LENGTH = 64

# C0 + DEL. Stripped from tags so a payload with a NUL byte or a stray
# newline doesn't reach the JSON column or the DOM via _escText.
_TAG_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


# -------- Categories --------

class CategoryBase(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # Icon ID from the bundled Phosphor sprite (frontend/icons/categories/
    # sprite.svg). Slug-form, no whitespace, no emoji — kept lax here so a
    # new sprite icon can ship in the frontend without a coupled backend
    # release. Unknown IDs render as the default `package` glyph client-side.
    icon: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$", default="package")
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$", default="#9e9b96")


class CategoryCreate(CategoryBase):
    pass


class CategoryUpdate(CategoryBase):
    pass


class CategoryOut(CategoryBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


# -------- Tags --------

class TagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class TagRename(BaseModel):
    new_name: str = Field(min_length=1, max_length=64)


class TagOut(BaseModel):
    name: str
    count: int


# -------- Transactions --------
# The frontend uses the JSON field "desc"; the DB column is "description"
# (avoids reserved-word conflicts). The Pydantic alias accepts both.

class TransactionIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    description: str = Field(default="", max_length=255, alias="desc")
    category_id: int
    date: date_type
    type: Literal["in", "out"]
    tags: list[str] | None = None

    model_config = ConfigDict(populate_by_name=True)

    @field_validator("tags")
    @classmethod
    def _normalise_tags(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        if len(value) > MAX_TAGS_PER_TX:
            raise ValueError(f"too many tags (max {MAX_TAGS_PER_TX})")
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in value:
            if not isinstance(raw, str):
                raise ValueError("tags must be strings")
            tag = _TAG_CONTROL_CHARS.sub("", raw).strip()
            if not tag:
                raise ValueError("tag must not be empty")
            if len(tag) > MAX_TAG_LENGTH:
                raise ValueError(f"tag too long (max {MAX_TAG_LENGTH})")
            # casefold (not lower) so the dedupe matches list_tags in
            # crud.py — otherwise `Straße` and `STRASSE` would be one
            # entry in the tag list but two distinct tags on a tx.
            key = tag.casefold()
            if key in seen:
                continue
            seen.add(key)
            cleaned.append(tag)
        return cleaned


class TransactionCreate(TransactionIn):
    pass


class TransactionUpdate(TransactionIn):
    pass


class TransactionOut(BaseModel):
    # No _normalise_tags here on purpose: legacy rows from before the cap
    # may carry more than MAX_TAGS_PER_TX entries, and a 422 on read would
    # brick the UI for those users. The cap is enforced on write only.
    id: int
    amount: Decimal
    description: str = Field(serialization_alias="desc")
    category_id: int
    date: date_type
    type: Literal["in", "out"]
    tags: list[str] | None = None

    model_config = ConfigDict(from_attributes=True)


# -------- User Settings --------
# UI preferences mirrored from localStorage so the app survives iOS-side
# storage eviction. Single row per user. PUT accepts a partial body — only
# the provided fields are updated, the rest stays untouched.

class SettingsOut(BaseModel):
    theme: Literal["system", "light", "dark"]
    default_view: Literal["transactions", "categories"]

    model_config = ConfigDict(from_attributes=True)


class SettingsUpdate(BaseModel):
    theme: Literal["system", "light", "dark"] | None = None
    default_view: Literal["transactions", "categories"] | None = None


# -------- Import --------

class ImportRowError(BaseModel):
    row: int
    reason: str


class ImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[ImportRowError]
