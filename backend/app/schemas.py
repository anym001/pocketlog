import re
from datetime import date as date_type, datetime
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

# C0 + DEL. Stripped from every user-controlled string field so a NUL
# byte or a stray newline never reaches the JSON column, the CSV export
# or the DOM via _escText.
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
# Backwards-compatible alias used by crud._build_transaction.
_TAG_CONTROL_CHARS = _CONTROL_CHARS


def _strip_control(value: str) -> str:
    return _CONTROL_CHARS.sub("", value)


def _strip_control_required(value: str) -> str:
    """For fields that must not be empty after stripping (e.g. names)."""
    cleaned = _CONTROL_CHARS.sub("", value).strip()
    if not cleaned:
        raise ValueError("must not be empty")
    return cleaned


# -------- Categories --------

class CategoryBase(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # Icon ID from the bundled Phosphor sprite (frontend/icons/categories/
    # sprite.svg). Slug-form, no whitespace, no emoji — kept lax here so a
    # new sprite icon can ship in the frontend without a coupled backend
    # release. Unknown IDs render as the default `package` glyph client-side.
    icon: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$", default="package")
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$", default="#9e9b96")

    @field_validator("name", mode="after")
    @classmethod
    def _normalise_name(cls, value: str) -> str:
        return _strip_control_required(value)


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

    @field_validator("name", mode="after")
    @classmethod
    def _normalise_name(cls, value: str) -> str:
        return _strip_control_required(value)


class TagRename(BaseModel):
    new_name: str = Field(min_length=1, max_length=64)

    @field_validator("new_name", mode="after")
    @classmethod
    def _normalise_new_name(cls, value: str) -> str:
        return _strip_control_required(value)


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

    @field_validator("description", mode="after")
    @classmethod
    def _normalise_description(cls, value: str) -> str:
        # Description is allowed to be empty (default=""), so strip control
        # chars silently without the not-empty check.
        return _strip_control(value)

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
    # Always a list (possibly empty) — the previous JSON column could be
    # NULL, but the M2M relationship is always a (possibly empty) list,
    # so the response shape is now consistent. The frontend already
    # treats `null` and `[]` the same (`t.tags || []`), so this is
    # backwards compatible at the consumer side.
    tags: list[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    @field_validator("tags", mode="before")
    @classmethod
    def _extract_tag_names(cls, value):
        # When constructed from the ORM, value is a list of Tag entities;
        # pull .name. When constructed from a dict / test fixture, value
        # is already list[str]. Handle both transparently so the schema
        # works on both code paths.
        if value is None:
            return []
        if isinstance(value, list):
            return [t.name if hasattr(t, "name") else t for t in value]
        return value


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


# -------- Auth --------
# Passwort-Policy: 12 Zeichen Mindestlänge (folgt aktueller NIST-Empfehlung
# „length > complexity"). Max 128 ist DoS-Schutz: ein 10-MB-„Passwort"
# würde sonst durch den Argon2-Worker laufen und ihn blockieren.
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128

# Username-Allowlist. Slug-Form, ASCII-only — gleiche Bounds wie früher
# der Authentik-Header, sodass migrierte Bestandsuser nicht plötzlich
# einen ungültigen Username haben.
_USERNAME_RE = re.compile(r"^[A-Za-z0-9._@+\-]{1,150}$")


def _validate_username(value: str) -> str:
    value = (value or "").strip()
    if not _USERNAME_RE.match(value):
        raise ValueError("invalid username")
    return value


class SetupRequest(BaseModel):
    """Setup-Modus: legt den ersten Admin an oder vergibt das Passwort
    für den migrationsbedingt promotionierten Admin. Bei Bestandsuser
    ignoriert das Backend den Username und nimmt den im DB hinterlegten
    Wert — die Validierung läuft aber, damit ein leerer Wert nicht
    durchrutscht."""
    username: str = Field(min_length=1, max_length=150)
    password: str = Field(
        min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH
    )

    @field_validator("username", mode="after")
    @classmethod
    def _normalise_username(cls, value: str) -> str:
        return _validate_username(value)


class SetupStatus(BaseModel):
    needs_setup: bool
    suggested_username: str | None = None


class LoginRequest(BaseModel):
    # Username wird hier bewusst nicht regex-validiert — wir wollen
    # malformed Inputs ebenfalls mit dem generischen "invalid
    # credentials"-Pfad beantworten, damit das Backend kein Signal
    # leakt, welches Feld bemängelt wurde.
    username: str = Field(min_length=1, max_length=150)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    remember_me: bool = False


class UserMe(BaseModel):
    id: int
    username: str
    is_admin: bool
    force_change_password: bool
    csrf_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    new_password: str = Field(
        min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH
    )


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=150)
    password: str = Field(
        min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH
    )

    @field_validator("username", mode="after")
    @classmethod
    def _normalise_username(cls, value: str) -> str:
        return _validate_username(value)


class AdminPasswordReset(BaseModel):
    new_password: str = Field(
        min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH
    )


class AdminUserOut(BaseModel):
    id: int
    username: str
    is_admin: bool
    is_active: bool
    force_change_password: bool
    locked_until: datetime | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
