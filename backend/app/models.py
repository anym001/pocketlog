from datetime import date as date_type, datetime
from decimal import Decimal

from sqlalchemy import (
    CHAR,
    DECIMAL,
    TIMESTAMP,
    Boolean,
    Column,
    Date,
    Enum,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    Table,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


# Junction table between transactions and tags. Migration 0008 holds the
# DDL; this declaration just lets ORM-level operations (.append, .remove,
# selectinload) work against the same rows.
transaction_tags = Table(
    "transaction_tags",
    Base.metadata,
    Column(
        "transaction_id",
        Integer,
        ForeignKey(
            "transactions.id",
            ondelete="CASCADE",
            name="fk_tx_tags_transaction",
        ),
        nullable=False,
    ),
    Column(
        "tag_id",
        Integer,
        ForeignKey(
            "tags.id", ondelete="CASCADE", name="fk_tx_tags_tag"
        ),
        nullable=False,
    ),
    PrimaryKeyConstraint(
        "transaction_id", "tag_id", name="pk_transaction_tags"
    ),
    Index("ix_transaction_tags_tag_id", "tag_id"),
    mysql_engine="InnoDB",
    mysql_charset="utf8mb4",
)


class User(Base):
    __tablename__ = "users"
    # The unique constraint is named explicitly so it matches what
    # MariaDB created at table-creation time (alembic 0002). Without
    # this, alembic --autogenerate keeps proposing a "drop and recreate"
    # of the constraint just to give it a deterministic name.
    __table_args__ = (
        UniqueConstraint("username", name="uq_users_username"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Uniqueness lives in __table_args__ above so it has a stable name —
    # column-level `unique=True` would let SQLAlchemy auto-name it and
    # diverge from what alembic 0002 emitted on production.
    username: Mapped[str] = mapped_column(String(150), nullable=False)
    # Argon2id hash. NULL = no password yet (bootstrap users from the
    # pre-app-auth era and freshly-promoted admins in setup mode).
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_admin: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="0", default=False
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="1", default=True
    )
    force_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="0", default=False
    )
    # Python-side default ensures every ORM INSERT carries a value —
    # necessary on the SQLite test path where the migration adds the
    # column without a server default (SQLite refuses ALTER TABLE
    # ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP). On MariaDB the
    # server_default still applies for non-ORM inserts.
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(),
        nullable=False,
        server_default=func.current_timestamp(),
        default=lambda: datetime.utcnow(),
    )
    # Brute-force backoff state. Both columns are reset on a successful
    # login and on admin password-reset.
    failed_login_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0", default=0
    )
    lockout_until: Mapped[datetime | None] = mapped_column(
        TIMESTAMP(), nullable=True
    )

    categories: Mapped[list["Category"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    transactions: Mapped[list["Transaction"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    tags: Mapped[list["Tag"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    settings: Mapped["UserSettings | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    sessions: Mapped[list["Session"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    goals: Mapped[list["Goal"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class Session(Base):
    """Server-side session record.

    The plain token lives only in the user's cookie (HttpOnly). The DB
    keeps the sha256 hex so a DB leak can't be replayed as a session
    hijack. CSRF token is a separate random value stored in plain — it
    is sent to JS via a readable cookie + ``GET /api/auth/me`` and
    compared on every state-changing request.
    """
    __tablename__ = "sessions"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
        Index("ix_sessions_user_id", "user_id"),
        Index("ix_sessions_expires_at", "expires_at"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    csrf_token: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(),
        nullable=False,
        server_default=func.current_timestamp(),
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(),
        nullable=False,
        server_default=func.current_timestamp(),
    )
    expires_at: Mapped[datetime] = mapped_column(TIMESTAMP(), nullable=False)
    # Hard cap so a stolen cookie can't be refreshed indefinitely by a
    # quiet attacker who only needs to make one request a day to stay
    # under the sliding window.
    absolute_expires_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(), nullable=False
    )
    remember_me: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="0", default=False
    )
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions")


class UserSettings(Base):
    __tablename__ = "user_settings"
    __table_args__ = (
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    theme: Mapped[str] = mapped_column(String(16), nullable=False, default="system")
    default_view: Mapped[str] = mapped_column(
        String(32), nullable=False, default="transactions"
    )
    # BCP-47 locale tag ('de-DE', 'de-AT', 'en-GB' …). The UI translation
    # bundle is derived from the primary subtag (de/en); the full tag drives
    # Intl number/date formatting.
    locale: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="de-DE", default="de-DE"
    )
    # ISO 4217 currency code used purely for display/formatting — amounts
    # are never converted, only rendered with this symbol and locale.
    currency: Mapped[str] = mapped_column(
        String(3), nullable=False, server_default="EUR", default="EUR"
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(),
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
    )

    user: Mapped[User] = relationship(back_populates="settings")


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_categories_user_name"),
        Index("ix_categories_user_id", "user_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    icon: Mapped[str] = mapped_column(String(64), nullable=False, default="package")
    color: Mapped[str] = mapped_column(CHAR(7), nullable=False, default="#9e9b96")

    user: Mapped[User] = relationship(back_populates="categories")
    transactions: Mapped[list["Transaction"]] = relationship(back_populates="category")


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_tags_user_name"),
        Index("ix_tags_user_id", "user_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)

    user: Mapped[User] = relationship(back_populates="tags")
    # Back-reference only — the junction is the authoritative source.
    # Used by rename_tag/delete_tag in crud.py to walk affected
    # transactions without a manual JOIN.
    transactions: Mapped[list["Transaction"]] = relationship(
        secondary=transaction_tags,
        back_populates="tags",
    )


class Transaction(Base):
    __tablename__ = "transactions"
    __table_args__ = (
        Index("ix_transactions_user_date", "user_id", "date"),
        # FK on category_id triggers an InnoDB FK-check on every category
        # DELETE; without this index that check is a full table scan on
        # transactions.
        Index("ix_transactions_category_id", "category_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[Decimal] = mapped_column(DECIMAL(12, 2), nullable=False)
    description: Mapped[str] = mapped_column("description", String(255), nullable=False, default="")
    category_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="RESTRICT"), nullable=False
    )
    date: Mapped[date_type] = mapped_column(Date, nullable=False)
    type: Mapped[str] = mapped_column(Enum("in", "out", name="tx_type"), nullable=False)

    user: Mapped[User] = relationship(back_populates="transactions")
    category: Mapped[Category] = relationship(back_populates="transactions")
    # Many-to-many tags via the transaction_tags junction. selectin
    # loading because list_transactions/_by_range serialise every row's
    # tags — a default lazy='select' would N+1 on every page.
    # order_by keeps the array stable across reads; the previous JSON
    # column preserved insertion order, which has no semantic meaning,
    # so alphabetical is both stable and matches the tag list UI.
    tags: Mapped[list["Tag"]] = relationship(
        secondary=transaction_tags,
        back_populates="transactions",
        lazy="selectin",
        order_by="Tag.name",
    )


class Goal(Base):
    """A savings goal or debt payoff tracker.

    A unified concept: ``direction='save_up'`` counts contributions up
    toward ``target_amount``; ``direction='pay_down'`` counts repayments
    down from ``initial_amount`` (the starting debt) toward
    ``target_amount`` (usually 0). The progress is *derived* — never
    stored — from the transactions in the linked category dated on/after
    ``start_date`` (in-type for save_up, out-type for pay_down). A goal
    never affects ledger income/expense totals.

    Exactly one category backs a goal (1:1 per user via
    ``uq_goals_user_category``).
    """
    __tablename__ = "goals"
    __table_args__ = (
        UniqueConstraint("user_id", "category_id", name="uq_goals_user_category"),
        Index("ix_goals_user_id", "user_id"),
        # FK on category_id triggers an InnoDB FK-check on every category
        # DELETE; without this index that check is a full table scan on
        # goals (mirrors ix_transactions_category_id).
        Index("ix_goals_category_id", "category_id"),
        {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4"},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    direction: Mapped[str] = mapped_column(
        Enum("save_up", "pay_down", name="goal_direction"), nullable=False
    )
    category_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("categories.id", ondelete="CASCADE"), nullable=False
    )
    initial_amount: Mapped[Decimal] = mapped_column(
        DECIMAL(12, 2), nullable=False, server_default="0", default=Decimal("0")
    )
    target_amount: Mapped[Decimal] = mapped_column(DECIMAL(12, 2), nullable=False)
    start_date: Mapped[date_type] = mapped_column(Date, nullable=False)
    icon: Mapped[str] = mapped_column(String(64), nullable=False, default="piggy-bank")
    color: Mapped[str] = mapped_column(CHAR(7), nullable=False, default="#9e9b96")
    # Python-side defaults mirror User.created_at — the SQLite test path's
    # ORM inserts need them since the migration adds no usable server
    # default for CURRENT_TIMESTAMP on ALTER. On MariaDB the server_default
    # still applies for non-ORM inserts.
    created_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(),
        nullable=False,
        server_default=func.current_timestamp(),
        default=lambda: datetime.utcnow(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(),
        nullable=False,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp(),
        default=lambda: datetime.utcnow(),
    )

    user: Mapped[User] = relationship(back_populates="goals")
    category: Mapped[Category] = relationship()
