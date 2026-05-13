from datetime import date as date_type
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


# -------- Categories --------

class CategoryBase(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    icon: str = Field(min_length=1, max_length=8, default="📦")
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$", default="#9e9b96")


class CategoryCreate(CategoryBase):
    pass


class CategoryUpdate(CategoryBase):
    pass


class CategoryOut(CategoryBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


# -------- Tags --------

class TagRename(BaseModel):
    new_name: str = Field(min_length=1, max_length=64)


# -------- Transactions --------
# Frontend benutzt das JSON-Feld "desc"; in DB heißt die Spalte "description"
# (Reserved-Word-Vermeidung). Pydantic-Alias macht beides möglich.

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


# -------- Import --------

class ImportRowError(BaseModel):
    row: int
    reason: str


class ImportResult(BaseModel):
    imported: int
    skipped: int
    errors: list[ImportRowError]
