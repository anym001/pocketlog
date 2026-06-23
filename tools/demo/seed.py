#!/usr/bin/env python3
"""Seed a PocketLog instance with a curated demo dataset.

Drives the public API (no DB access), so it works against any reachable
instance and only ever creates states the app itself allows. Used to populate
a throwaway instance for the README screenshots (see capture.mjs), and handy
on its own to explore the app with realistic data.

Idempotent: transactions dedupe server-side, and goal/rule conflicts (409 /
duplicate name) are ignored — re-running converges on the same dataset.

Config via env (all optional):
    BASE_URL         default http://127.0.0.1:8000
    ADMIN_USERNAME   default demo
    ADMIN_PASSWORD   default Demo-Account-2026!   (meets the password policy)

The target must be a fresh instance (no admin yet) OR already owned by these
credentials. NEVER point this at a real account — it writes demo data.
"""

from __future__ import annotations

import os
import sys

import httpx

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:8000").rstrip("/")
USERNAME = os.environ.get("ADMIN_USERNAME", "demo")
PASSWORD = os.environ.get("ADMIN_PASSWORD", "Demo-Account-2026!")
LOCALE = "en-GB"
CURRENCY = "EUR"

# date;type;amount;description;category;tags — categories and tags are
# auto-created by the import. Dated around "today" (June 2026) so the ledger's
# default month view is populated; May rows give the reports range some depth.
DEMO_CSV = """date;type;amount;description;category;tags
2026-05-01;in;3200.00;Salary;Salary;
2026-05-02;out;1100.00;Monthly rent;Housing;fixed
2026-05-05;out;72.10;Supermarket;Groceries;
2026-05-09;out;55.00;Restaurant;Leisure;eating-out
2026-05-15;out;60.00;Fuel;Transport;
2026-05-20;out;14.99;Music streaming;Subscriptions;fixed
2026-06-01;in;3200.00;Salary;Salary;
2026-06-01;out;1100.00;Monthly rent;Housing;fixed
2026-06-02;in;200.00;Holiday saving;Savings;
2026-06-02;out;64.20;Supermarket;Groceries;
2026-06-03;in;300.00;Buffer top-up;Reserve;
2026-06-03;out;19.99;Mobile plan;Subscriptions;fixed
2026-06-04;out;78.50;Electricity;Utilities;fixed
2026-06-05;out;42.80;Dinner out;Leisure;eating-out
2026-06-06;out;61.30;Fuel;Transport;
2026-06-07;out;12.99;Video streaming;Subscriptions;fixed
2026-06-08;out;51.75;Supermarket;Groceries;
2026-06-09;in;150.00;Holiday saving;Savings;
2026-06-09;out;23.40;Pharmacy;Health;
2026-06-10;out;89.90;New jacket;Shopping;
2026-06-11;out;39.00;Transport pass;Transport;
2026-06-12;out;28.60;Coffee & lunch;Leisure;eating-out
"""

# name -> (icon id from the category sprite, hex colour). Applied after import
# so the auto-created categories aren't all the grey "package" default.
CATEGORY_STYLE = {
    "Salary": ("coins", "#2e9e5b"),
    "Housing": ("house", "#4a7fc0"),
    "Groceries": ("shopping-cart", "#e0892e"),
    "Transport": ("car", "#7d6bbf"),
    "Leisure": ("wine", "#d4567a"),
    "Health": ("first-aid-kit", "#3fb6a8"),
    "Subscriptions": ("television", "#9b59b6"),
    "Utilities": ("plug", "#d9a520"),
    "Shopping": ("handbag", "#c0607f"),
    "Savings": ("piggy-bank", "#2e9e5b"),
    "Reserve": ("umbrella", "#5b7da0"),
}

GOALS = [
    {
        "name": "Holiday Fund",
        "direction": "save_up",
        "category": "Savings",
        "initial_amount": "0.00",
        "target_amount": "2000.00",
        "start_date": "2026-01-01",
        "icon": "airplane",
        "color": "#d4567a",
    },
    {
        "name": "Emergency Buffer",
        "direction": "save_up",
        "category": "Reserve",
        "initial_amount": "1200.00",
        "target_amount": "5000.00",
        "start_date": "2026-01-01",
        "icon": "umbrella",
        "color": "#5b7da0",
    },
]

# Per-category spending caps. Amounts chosen against the demo June spend so the
# bars show a spread — Groceries/Leisure comfortably within, Subscriptions just
# over (the red over-budget state), and Transport on a quarterly period.
BUDGETS = [
    {"category": "Groceries", "amount": "200.00", "frequency": "monthly"},
    {"category": "Leisure", "amount": "100.00", "frequency": "monthly"},
    {"category": "Subscriptions", "amount": "30.00", "frequency": "monthly"},
    {"category": "Transport", "amount": "400.00", "frequency": "quarterly"},
]

# All start in the (near) future so they populate the recurring view as
# upcoming bookings without materializing into the demo month.
RECURRING_RULES = [
    {
        "name": "Salary",
        "amount": "3200.00",
        "type": "in",
        "category": "Salary",
        "desc": "Monthly salary",
        "frequency": "monthly",
        "interval": 1,
        "day_of_month": 1,
        "start_date": "2026-07-01",
    },
    {
        "name": "Rent",
        "amount": "1100.00",
        "type": "out",
        "category": "Housing",
        "desc": "Monthly rent",
        "frequency": "monthly",
        "interval": 1,
        "day_of_month": 1,
        "start_date": "2026-07-01",
        "tags": ["fixed"],
    },
    {
        "name": "Music streaming",
        "amount": "14.99",
        "type": "out",
        "category": "Subscriptions",
        "desc": "Monthly subscription",
        "frequency": "monthly",
        "interval": 1,
        "day_of_month": 5,
        "start_date": "2026-07-05",
        "tags": ["fixed"],
    },
    {
        "name": "Gym membership",
        "amount": "29.90",
        "type": "out",
        "category": "Leisure",
        "desc": "Monthly membership",
        "frequency": "monthly",
        "interval": 1,
        "day_of_month": 1,
        "start_date": "2026-07-01",
        "tags": ["fixed"],
    },
]


class Seeder:
    def __init__(self, client: httpx.Client) -> None:
        self._c = client
        self._csrf = ""

    def _headers(self) -> dict[str, str]:
        return {"X-CSRF-Token": self._csrf} if self._csrf else {}

    def authenticate(self) -> None:
        status = self._c.get("/api/auth/setup-status").json()
        if status.get("needs_setup"):
            r = self._c.post(
                "/api/auth/setup",
                json={"username": USERNAME, "password": PASSWORD, "locale": LOCALE},
            )
            r.raise_for_status()
        login = self._c.post(
            "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
        )
        login.raise_for_status()
        self._csrf = login.json()["user"]["csrf_token"]

    def set_display(self) -> None:
        self._c.put(
            "/api/settings",
            json={"locale": LOCALE, "currency": CURRENCY},
            headers=self._headers(),
        ).raise_for_status()

    def import_transactions(self) -> dict:
        r = self._c.post(
            "/api/import/csv",
            files={"file": ("demo.csv", DEMO_CSV.encode("utf-8"), "text/csv")},
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()

    def categories(self) -> dict[str, int]:
        r = self._c.get("/api/categories")
        r.raise_for_status()
        return {c["name"]: c["id"] for c in r.json()}

    def style_categories(self, ids: dict[str, int]) -> None:
        for name, (icon, color) in CATEGORY_STYLE.items():
            cid = ids.get(name)
            if cid is None:
                continue
            self._c.put(
                f"/api/categories/{cid}",
                json={"name": name, "icon": icon, "color": color},
                headers=self._headers(),
            ).raise_for_status()

    def create_goals(self, ids: dict[str, int]) -> None:
        for g in GOALS:
            cid = ids.get(g["category"])
            if cid is None:
                continue
            payload = {k: v for k, v in g.items() if k != "category"}
            payload["category_id"] = cid
            r = self._c.post("/api/goals", json=payload, headers=self._headers())
            if r.status_code == 409:
                continue  # goal already exists for this category — idempotent
            r.raise_for_status()

    def create_recurring(self, ids: dict[str, int]) -> None:
        for rule in RECURRING_RULES:
            cid = ids.get(rule["category"])
            if cid is None:
                continue
            payload = {k: v for k, v in rule.items() if k != "category"}
            payload["category_id"] = cid
            r = self._c.post("/api/recurring", json=payload, headers=self._headers())
            if r.status_code in (409, 422):
                continue  # duplicate name (idempotent) or already present
            r.raise_for_status()

    def create_budgets(self, ids: dict[str, int]) -> None:
        for b in BUDGETS:
            cid = ids.get(b["category"])
            if cid is None:
                continue
            payload = {k: v for k, v in b.items() if k != "category"}
            payload["category_id"] = cid
            r = self._c.post("/api/budgets", json=payload, headers=self._headers())
            if r.status_code == 409:
                continue  # budget already exists for this category — idempotent
            r.raise_for_status()


def main() -> int:
    with httpx.Client(base_url=BASE_URL, timeout=30.0) as client:
        try:
            client.get("/api/health").raise_for_status()
        except httpx.HTTPError as exc:
            print(f"PocketLog not reachable at {BASE_URL}: {exc}", file=sys.stderr)
            return 1
        seeder = Seeder(client)
        seeder.authenticate()
        seeder.set_display()
        result = seeder.import_transactions()
        ids = seeder.categories()
        seeder.style_categories(ids)
        seeder.create_goals(ids)
        seeder.create_recurring(ids)
        seeder.create_budgets(ids)
    print(
        "Seeded demo data: "
        f"imported={result.get('imported')} deduped={result.get('deduped')} "
        f"categories={len(ids)} goals={len(GOALS)} budgets={len(BUDGETS)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
