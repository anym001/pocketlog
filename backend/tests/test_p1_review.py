"""Regression guards for the P1 review fixes (2026-05-23)."""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy.exc import IntegrityError

# ── P1-9: CSV-import IntegrityError must not leak DB internals ──────────────


def test_csv_import_integrity_error_returns_generic_message(monkeypatch, app):
    """When the final db.commit() raises IntegrityError (e.g. a unique-key
    collision against existing rows), the error returned to the API client
    must NOT contain MariaDB schema details — table names, column names,
    constraint names, or the exception class name. The real detail goes
    to the server log, not into the response body.
    """
    from app import crud, models
    from app.database import SessionLocal

    # Pretend the commit hits the same kind of MariaDB error the leak
    # would have surfaced: a duplicate-key violation whose `e.orig`
    # carries the raw pymysql message.
    leaky_orig = Exception(
        "(1062, \"Duplicate entry 'test' for key 'transactions.uq_user_name'\")"
    )

    def boom(self, *args, **kwargs):
        raise IntegrityError("INSERT INTO transactions ...", {}, leaky_orig)

    db = SessionLocal()
    try:
        # The import path needs a user + at least one category so
        # _build_transaction succeeds before the failing commit.
        user = models.User(username="csv-leak-test")
        db.add(user)
        db.commit()
        db.refresh(user)
        cat = models.Category(
            user_id=user.id, name="Sonstiges", icon="package", color="#9e9b96"
        )
        db.add(cat)
        db.commit()

        # Force ONLY the final commit inside import_csv to fail.
        from sqlalchemy.orm import Session

        monkeypatch.setattr(Session, "commit", boom)

        csv_text = (
            "date;amount;category;description;type\n"
            "2026-01-15;1.50;Sonstiges;Brot;out\n"
        )
        result = crud.import_csv(db, user.id, csv_text)
    finally:
        db.close()

    assert result["imported"] == 0
    assert result["errors"], "expected at least one error entry"
    # Errors are now code + params; flatten both so a leaked DB internal in
    # either would still be caught.
    reasons = " | ".join(
        f"{e['code']} {e.get('params', {})}" for e in result["errors"]
    ).lower()

    # None of these MariaDB / pymysql / SQLAlchemy artifacts may appear:
    forbidden = [
        "pymysql",
        "integrityerror",
        "operationalerror",
        "insert into",
        "uq_user_name",
        "transactions.",
        "1062",
        "duplicate entry",
    ]
    leaks = [token for token in forbidden if token in reasons]
    assert not leaks, (
        f"DB internals leaked into API error: {leaks!r} found in {reasons!r}"
    )


# ── P1-10: TransactionOut serialisation aliases ─────────────────────────────


def test_transaction_out_follows_alias_convention():
    """CLAUDE.md says: when a schema uses Field(alias=…) or
    Field(serialization_alias=…), its model_config must set
    populate_by_name=True. TransactionOut declares serialization_alias
    on `description`, so the config must carry populate_by_name=True —
    otherwise the model is asymmetric with TransactionIn and silently
    drifts away from the documented project convention.
    """
    from app.schemas import TransactionOut

    uses_serialization_alias = any(
        f.serialization_alias is not None for f in TransactionOut.model_fields.values()
    )
    assert uses_serialization_alias, (
        "test premise broken: no serialization_alias on TransactionOut"
    )

    config = TransactionOut.model_config
    assert config.get("populate_by_name") is True, (
        "TransactionOut uses serialization_alias but model_config does not set "
        "populate_by_name=True — violates the alias-handling convention in CLAUDE.md."
    )


def test_transaction_out_serialises_description_as_desc():
    """Runtime guarantee for the frontend contract: a TransactionOut
    dumped by_alias must surface `desc` (what the JSON / frontend reads),
    while the plain dump keeps the ORM-matching `description` field name.
    """
    from app.schemas import TransactionOut

    instance = TransactionOut(
        id=1,
        amount=Decimal("10.50"),
        description="Brot",
        category_id=2,
        date="2026-01-15",
        type="out",
        tags=["Reise"],
    )

    dumped = instance.model_dump(by_alias=True)
    assert "desc" in dumped, (
        "TransactionOut must serialise description as 'desc' for the frontend"
    )
    assert "description" not in dumped, (
        "alias must replace the field name when by_alias=True"
    )
    assert dumped["desc"] == "Brot"

    plain = instance.model_dump()
    assert plain["description"] == "Brot"
