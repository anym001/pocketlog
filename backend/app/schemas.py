from datetime import date as date_type
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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


class TransactionCreate(TransactionIn):
    pass


class TransactionUpdate(TransactionIn):
    pass


class TransactionOut(BaseModel):
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
