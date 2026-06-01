"""Lock down exact monetary precision on the SQLite backend.

Amounts are ``DECIMAL(12,2)``. SQLite has no native decimal type, so a
regression here (e.g. a value silently round-tripping through a float) would
corrupt money. These tests pin that every amount survives a DB round-trip
byte-for-byte and that summing them in Python stays exact — including the
classic ``0.10 + 0.20`` float trap.

Each test deletes the transactions it creates: the suite shares one SQLite
file, and the setup-mode tests wipe the users table with a raw bulk delete
whose cascade trips ``transactions.category_id``'s ON DELETE RESTRICT if rows
are left behind.
"""
from __future__ import annotations

from decimal import Decimal

# Awkward values: the 0.10/0.20 float trap, the largest 8-integer-digit value,
# and a 12-significant-digit value at the DECIMAL(12,2) ceiling.
AMOUNTS = ["0.10", "0.20", "99999999.99", "1234567890.12"]


def _make_tx(client, cat_id, amount):
    r = client.post(
        "/api/transactions",
        json={
            "amount": amount,
            "desc": "money",
            "category_id": cat_id,
            "date": "2026-05-20",
            "type": "out",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_amounts_round_trip_exactly(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    ids = []
    try:
        for amount in AMOUNTS:
            tx = _make_tx(client, cat_id, amount)
            ids.append(tx["id"])
            # Serialized back as a string — must match the input verbatim and
            # carry exactly two decimal places.
            assert tx["amount"] == amount
            as_decimal = Decimal(tx["amount"])
            assert as_decimal == Decimal(amount)
            assert as_decimal.as_tuple().exponent == -2
    finally:
        for tx_id in ids:
            client.delete(f"/api/transactions/{tx_id}")


def test_python_sum_is_exact(client):
    cat_id = client.get("/api/categories").json()[0]["id"]
    ids = []
    try:
        for amount in AMOUNTS:
            ids.append(_make_tx(client, cat_id, amount)["id"])

        listed = client.get("/api/transactions?year=2026&month=5").json()
        total = sum((Decimal(t["amount"]) for t in listed), Decimal("0"))
        # 0.10 + 0.20 + 99999999.99 + 1234567890.12
        assert total == Decimal("1334567890.41")
    finally:
        for tx_id in ids:
            client.delete(f"/api/transactions/{tx_id}")
