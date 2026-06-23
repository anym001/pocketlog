# Demo data & README screenshots

Tooling to populate a **throwaway** PocketLog instance with a curated demo
dataset and capture the screenshots used in the top-level `README.md`. Both
drive the public API only — no database access — so they work against any
reachable instance and never create states the app itself wouldn't.

> ⚠️ Never point these at a real account: `seed.py` writes demo data, and the
> default credentials are well-known.

## 1. Start a throwaway instance

Run a fresh PocketLog. The default `SESSION_COOKIE_SECURE=auto` already omits
the Secure flag on a direct plain-HTTP connection, so the seeder's session
cookie is accepted on localhost without any override. For example, from
`backend/`:

```sh
SQLITE_PATH=/tmp/demo/pocketlog.db python -m alembic upgrade head
SQLITE_PATH=/tmp/demo/pocketlog.db \
  python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

> ℹ️ The app serves the PWA from `backend/static`, which only exists inside the
> built image (the Dockerfile copies `frontend/` into it). For a local run the
> seeder works without it, but **`capture.mjs` needs the frontend served**, so
> point `static` at `frontend/` first: `ln -sfn ../frontend backend/static`
> (the symlink is git-ignored; remove it when done).

## 2. Seed the demo data

Needs `httpx` (already a backend dependency). On first run it creates the admin
(`demo` / `Demo-Account-2026!`); re-runs are idempotent.

```sh
python tools/demo/seed.py          # honours BASE_URL / ADMIN_USERNAME / ADMIN_PASSWORD
```

This imports ~2 months of transactions (auto-creating + styling categories and
tags), then adds two savings goals, four recurring rules and four per-category
budgets.

## 3. Capture the screenshots

Reuses Playwright's Chromium (shared with `frontend/e2e` via the global
browser cache, so `playwright install` is usually a no-op):

```sh
cd tools/demo
npm install
npm run capture                    # writes ../../docs/screenshots/*.png
```

Renders six views at the Pixel 5 mobile viewport (the app's primary form
factor) in light theme — ledger, categories, recurring, category report,
goals, budgets — plus a wide desktop shot (sidebar layout, dark theme).
