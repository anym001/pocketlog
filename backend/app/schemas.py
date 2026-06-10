import json
import re
from datetime import date as date_type
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
from pydantic_core import PydanticCustomError

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


def _normalise_tag_list(value: list[str] | None) -> list[str] | None:
    """Shared between TransactionIn and RecurringRuleBase.

    Strips control chars, deduplicates case-insensitively (casefold,
    not lower — see ``crud._find_tag_by_name``) and enforces the
    per-record cap. Returns ``None`` when the caller didn't provide
    the field, ``[]`` when explicitly empty.
    """
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
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(tag)
    return cleaned


# Reusable field types for the recurring normalisation patterns — the same
# Annotated+AfterValidator idiom as Locale/Currency/NewPassword further down,
# replacing per-class copies of the identical @field_validator.
# A user-facing name: control chars stripped, must be non-empty afterwards.
NameStr = Annotated[str, AfterValidator(_strip_control_required)]
# Free text that may be empty (descriptions): control chars stripped silently.
FreeText = Annotated[str, AfterValidator(_strip_control)]
# A tags payload: stripped, case-insensitively deduplicated, capped.
TagList = Annotated[list[str] | None, AfterValidator(_normalise_tag_list)]


# -------- Categories --------


class CategoryBase(BaseModel):
    name: NameStr = Field(min_length=1, max_length=100)
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


# -------- Goals --------


class GoalBase(BaseModel):
    name: NameStr = Field(min_length=1, max_length=100)
    # 'save_up' counts contributions up to target_amount; 'pay_down'
    # counts repayments down from initial_amount toward target_amount.
    direction: Literal["save_up", "pay_down"]
    # The single category whose transactions feed this goal (1:1 per user).
    category_id: int
    # Baseline anchor: for pay_down the starting debt; for save_up the
    # amount already saved at start_date (usually 0).
    initial_amount: Decimal = Field(
        ge=0, max_digits=12, decimal_places=2, default=Decimal("0")
    )
    target_amount: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    # Only transactions dated on/after this anchor count toward progress.
    start_date: date_type
    # Icon ID from the bundled Phosphor sprite — same lax slug pattern as
    # CategoryBase. Default 'piggy-bank' exists in the sprite; unknown IDs
    # fall back to the default glyph client-side.
    icon: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$", default="piggy-bank")
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$", default="#9e9b96")

    @model_validator(mode="after")
    def _check_amounts(self) -> "GoalBase":
        if self.direction == "save_up":
            # There must be room to save into.
            if self.target_amount <= self.initial_amount:
                raise ValueError(
                    "target_amount must be greater than initial_amount "
                    "for a savings goal"
                )
        else:  # pay_down
            # There must be a debt, and the target must be below it.
            if self.initial_amount <= 0:
                raise ValueError(
                    "initial_amount must be greater than 0 for a debt goal"
                )
            if self.target_amount >= self.initial_amount:
                raise ValueError(
                    "target_amount must be less than initial_amount for a debt goal"
                )
        return self


class GoalCreate(GoalBase):
    pass


class GoalUpdate(GoalBase):
    pass


class GoalOut(GoalBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


# -------- Tags --------


class TagCreate(BaseModel):
    name: NameStr = Field(min_length=1, max_length=64)


class TagRename(BaseModel):
    new_name: NameStr = Field(min_length=1, max_length=64)


class TagOut(BaseModel):
    name: str
    count: int


# -------- Transactions --------
# The frontend uses the JSON field "desc"; the DB column is "description"
# (avoids reserved-word conflicts). The Pydantic alias accepts both.


class TransactionIn(BaseModel):
    amount: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    # Description is allowed to be empty (default=""), so FreeText strips
    # control chars silently without the not-empty check.
    description: FreeText = Field(default="", max_length=255, alias="desc")
    category_id: int
    date: date_type
    type: Literal["in", "out"]
    tags: TagList = None

    model_config = ConfigDict(populate_by_name=True)


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
    # Set on transactions materialized from a recurring rule; null on
    # manually entered ones and on rows whose rule was deleted later.
    # Drives the small recurring badge in the tx list.
    source_rule_id: int | None = None

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


# -------- Recurring Rules --------
# A rule is a template for auto-booked transactions. The materialization
# engine (app.recurring) reads these and inserts rows into transactions
# when due. Cross-field validation (weekday/day_of_month required by
# frequency, end_date >= start_date) lives in the model_validator so the
# frontend can map each failure to a stable i18n key.


class RecurringRuleBase(BaseModel):
    name: NameStr = Field(min_length=1, max_length=100)
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    type: Literal["in", "out"]
    category_id: int
    description: FreeText = Field(default="", max_length=255, alias="desc")
    tags: TagList = None
    frequency: Literal["daily", "weekly", "monthly", "quarterly", "yearly"]
    interval: int = Field(default=1, ge=1, le=365)
    # 0=Mon, 6=Sun. Required iff weekly. Ignored otherwise (but stored
    # if the client sends it — round-trip is fine for the form's hidden
    # state).
    weekday: int | None = Field(default=None, ge=0, le=6)
    # 1..31. Required iff month-based. 31 clamps to the actual last
    # day of shorter months (Outlook semantics).
    day_of_month: int | None = Field(default=None, ge=1, le=31)
    start_date: date_type
    end_date: date_type | None = None
    max_occurrences: int | None = Field(default=None, ge=1, le=10_000)
    active: bool = True

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="after")
    def _check_cross_fields(self) -> "RecurringRuleBase":
        # Stable machine codes for the frontend to translate, mirroring
        # ``validate_password_complexity``. Bare ValueError would
        # surface as ``type=value_error`` with the message embedded
        # in prose, which the frontend can't reliably map to i18n.
        if self.frequency == "weekly" and self.weekday is None:
            raise PydanticCustomError(
                "recurring_cross_field",
                "weekday is required for weekly frequency",
                {"missing": "weekday"},
            )
        if (
            self.frequency in ("monthly", "quarterly", "yearly")
            and self.day_of_month is None
        ):
            raise PydanticCustomError(
                "recurring_cross_field",
                "day_of_month is required for monthly/quarterly/yearly",
                {"missing": "day_of_month"},
            )
        if self.end_date is not None and self.end_date < self.start_date:
            raise PydanticCustomError(
                "recurring_cross_field",
                "end_date must not precede start_date",
                {"missing": "end_after_start"},
            )
        return self


class RecurringRuleCreate(RecurringRuleBase):
    pass


class RecurringRuleUpdate(RecurringRuleBase):
    pass


class RecurringRuleOut(RecurringRuleBase):
    id: int
    # Cached cursor; null when the rule has terminated (end_date passed
    # or max_occurrences hit). The frontend uses this to label the
    # "Nächste Buchung" row and to disable the skip-next button.
    next_occurrence_date: date_type | None = None
    occurrences_count: int = 0
    skips: list[date_type] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    @field_validator("skips", mode="before")
    @classmethod
    def _extract_skip_dates(cls, value):
        if value is None:
            return []
        return [s.skip_date if hasattr(s, "skip_date") else s for s in value]

    @field_validator("tags", mode="before")
    @classmethod
    def _extract_tag_names(cls, value):
        # Same shape contract as TransactionOut: ORM relation rows
        # carry a .name; dict / fixture payloads are already strings.
        if value is None:
            return []
        if isinstance(value, list):
            return [t.name if hasattr(t, "name") else t for t in value]
        return value


class RecurringRuleCreateResponse(BaseModel):
    """Wraps RecurringRuleOut with the count of transactions that were
    auto-materialized in the same request (backdated rules)."""

    rule: RecurringRuleOut
    materialized_count: int = 0


class RecurringSkipOut(BaseModel):
    skipped_date: date_type | None
    next_occurrence_date: date_type | None


# -------- User Settings --------
# UI preferences mirrored from localStorage so the app survives iOS-side
# storage eviction. Single row per user. PUT accepts a partial body — only
# the provided fields are updated, the rest stays untouched.

# BCP-47 locales the UI offers. The translation bundle is the primary
# subtag (must have a frontend/i18n/<subtag>.json); the full tag drives
# Intl number/date formatting, so en-GB and en-US share one en.json but
# format dates differently. Curated list — extend together with the
# corresponding picker entry (and a JSON bundle for a new primary subtag).
SUPPORTED_LOCALES = ("de-DE", "de-AT", "de-CH", "en-GB", "en-US")
# Translation bundles that actually ship under frontend/i18n/.
SUPPORTED_BUNDLES = ("de", "en")


def bundle_for_locale(locale: str) -> str:
    """Primary subtag (de-AT -> de). Falls back to the first bundle for an
    unknown/empty value so a render never breaks on a stray tag."""
    sub = (locale or "").split("-", 1)[0].lower()
    return sub if sub in SUPPORTED_BUNDLES else SUPPORTED_BUNDLES[0]


def _normalise_locale(value: str) -> str:
    parts = (value or "").strip().replace("_", "-").split("-")
    if parts and parts[0]:
        parts[0] = parts[0].lower()
    if len(parts) > 1 and parts[1]:
        parts[1] = parts[1].upper()
    code = "-".join(p for p in parts if p)
    if code not in SUPPORTED_LOCALES:
        raise ValueError("locale must be one of: " + ", ".join(SUPPORTED_LOCALES))
    return code


Locale = Annotated[str, AfterValidator(_normalise_locale)]

# Currencies offered in the picker. Display-only (ISO 4217) — amounts are
# never converted. Curated list, easy to extend; the symbol/position is
# resolved client-side via Intl.NumberFormat, so adding one here is the
# only change needed.
SUPPORTED_CURRENCIES = ("EUR", "USD", "GBP", "CHF", "JPY")


def _normalise_currency(value: str) -> str:
    code = (value or "").strip().upper()
    if code not in SUPPORTED_CURRENCIES:
        raise ValueError("currency must be one of: " + ", ".join(SUPPORTED_CURRENCIES))
    return code


Currency = Annotated[str, AfterValidator(_normalise_currency)]


class SettingsOut(BaseModel):
    theme: Literal["system", "light", "dark"]
    default_view: Literal["transactions", "categories"]
    locale: str
    currency: str

    model_config = ConfigDict(from_attributes=True)


class SettingsUpdate(BaseModel):
    theme: Literal["system", "light", "dark"] | None = None
    default_view: Literal["transactions", "categories"] | None = None
    locale: Locale | None = None
    currency: Currency | None = None


# -------- Import --------
# Per-row errors carry a stable machine ``code`` (+ optional ``params``)
# instead of a localized string, so the frontend can translate them. The
# code catalogue lives in crud._CSV_ERROR_CODES / frontend i18n "import.error.*".


class ImportRowError(BaseModel):
    row: int
    code: str
    params: dict[str, str | int] = {}


class ImportResult(BaseModel):
    imported: int
    skipped: int
    deduped: int = 0
    errors: list[ImportRowError]


# -------- API Keys --------
# Per-user bearer tokens with configurable scopes for programmatic access.
# The raw key (plk_<base64url>) is returned once at creation (ApiKeyCreateResponse)
# and never persisted — only the SHA-256 hash is stored.
#
# Three data scopes, hierarchical (write ⊇ import/read; see deps._SCOPE_GRANTS).
# There is no admin *data* scope: user management, mass-delete and key
# management stay session-only and are never reachable via a bearer token.
_VALID_SCOPES = {"import", "read", "write"}


class ApiKeyCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=100)]
    scopes: list[Literal["import", "read", "write"]]

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return v.strip()

    @field_validator("scopes")
    @classmethod
    def _require_scopes(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("at least one scope required")
        return list(dict.fromkeys(v))  # deduplicate, preserve order


class ApiKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    scopes: list[str]
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None

    @field_validator("scopes", mode="before")
    @classmethod
    def _parse_scopes(cls, v: object) -> list[str]:
        if isinstance(v, str):
            return json.loads(v)
        return v  # type: ignore[return-value]


class ApiKeyCreateResponse(BaseModel):
    id: int
    name: str
    scopes: list[str]
    created_at: datetime
    key: str  # plaintext raw key, shown exactly once


# -------- Auth --------
# Passwort-Policy: 12 Zeichen Mindestlänge plus vier Zeichenklassen
# (Groß/Klein/Zahl/Sonderzeichen). NIST 800-63B erlaubt es, Komplexität
# wegzulassen, aber Org-/Audit-Anforderungen verlangen sie häufig —
# wir setzen sie deshalb explizit durch. Max 128 ist DoS-Schutz: ein
# 10-MB-„Passwort" würde sonst den Argon2-Worker blockieren.
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128


def password_missing_classes(value: str) -> list[str]:
    """Stable machine codes for the character classes a password lacks.
    Unicode-aware via ``str.is*`` — „Ä", „ß", „é" zählen als Buchstaben
    (nicht Sonderzeichen), damit deutsche Eingaben nicht unter die
    Sonderzeichen-Pflicht fallen."""
    missing: list[str] = []
    if not any(c.isupper() for c in value):
        missing.append("upper")
    if not any(c.islower() for c in value):
        missing.append("lower")
    if not any(c.isdigit() for c in value):
        missing.append("digit")
    if not any(not c.isalnum() for c in value):
        missing.append("special")
    return missing


def validate_password_complexity(value: str) -> str:
    """Erzwingt je mindestens einen Groß-/Kleinbuchstaben, eine Ziffer und
    ein Sonderzeichen. Wirft einen ``PydanticCustomError`` mit stabilem Code
    ``password_complexity`` und den fehlenden Klassen-Codes im Kontext, damit
    das Frontend die 422-Antwort übersetzen kann (keine deutsche Prosa über
    die API). Die Recovery-CLI gibt operator-facing einen eigenen englischen
    Hinweis aus."""
    missing = password_missing_classes(value)
    if missing:
        raise PydanticCustomError(
            "password_complexity",
            "Password is missing character classes: {missing}",
            {"missing": ", ".join(missing)},
        )
    return value


# Wiederverwendbarer Annotated-Typ für jedes „neue" Passwort
# (Setup, Change, Admin-Create, Admin-Reset). Login/Current-Password
# laufen bewusst NICHT durch die Policy: dort soll der Server keinen
# Hinweis geben, was am Input formal falsch war.
NewPassword = Annotated[
    str,
    Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH),
    AfterValidator(validate_password_complexity),
]

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
    password: NewPassword
    # Locale picked on the setup screen. Seeds the default categories in the
    # matching language and becomes the admin's stored preference. Optional
    # so an older client that doesn't send it falls back to the default.
    locale: Locale = "de-DE"

    @field_validator("username", mode="after")
    @classmethod
    def _normalise_username(cls, value: str) -> str:
        return _validate_username(value)


class SetupStatus(BaseModel):
    needs_setup: bool
    suggested_username: str | None = None
    # Deployment default (ENV-configurable) so the setup screen can preselect
    # the operator's locale instead of always guessing from the browser.
    default_locale: str = "de-DE"


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
    # Count of transactions just materialized by the recurring catch-up
    # on this request; the frontend shows a dismissible info banner
    # when > 0. Defaults to 0 so callers that don't pass it (login
    # response) don't trip the schema.
    recurring_materialized_count: int = 0


class ChangePasswordRequest(BaseModel):
    # ``None`` whenever the user is in force-change-password state: the
    # backend ignores the value there because the existing password is
    # administrative (admin reset, CLI bootstrap, or NULL after the
    # migration). In the voluntary self-service path the value is required
    # and verified.
    current_password: str | None = Field(default=None, max_length=MAX_PASSWORD_LENGTH)
    new_password: NewPassword


class AdminUserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=150)
    password: NewPassword

    @field_validator("username", mode="after")
    @classmethod
    def _normalise_username(cls, value: str) -> str:
        return _validate_username(value)


class AdminPasswordReset(BaseModel):
    new_password: NewPassword


class AdminUserOut(BaseModel):
    id: int
    username: str
    is_admin: bool
    is_active: bool
    force_change_password: bool
    locked_until: datetime | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
