# PocketLog – Household Ledger PWA – Claude Code Project Context

## Architecture Overview
```
PWA (Browser / Homescreen)
        ↓ HTTPS
   Reverse Proxy          ← any (nginx, Caddy, Traefik …)
        ↓
  ┌─────────────────────────────────────┐
  │  FastAPI Container :8000            │  /        → static PWA files
  │  (uvicorn, Python 3.12)             │  /api/*   → Python API
  │  App auth: pocketlog_session cookie + X-CSRF-Token header (Double-Submit).
  └──────────────────┬──────────────────┘
                     ↓
   SQLite /config/db/pocketlog.db (default) · OR external MariaDB (opt-in via DB_*)
```
`DATABASE_URL` wins; otherwise MariaDB as soon as any `DB_*` variable is set; otherwise SQLite.

## Project Structure
```
frontend/
  index.html         ← PWA shell
  styles.css         ← complete CSS (tokens, layout, components)
  core.js            ← API/CSRF plumbing, formatting, toast/confirm, navigation
  ledger.js          ← transaction list, swipe-to-delete, bulk actions
  reports.js         ← Chart.js wiring + all report renderers
  booking.js         ← create/edit transaction modal
  categories.js      ← category management, tag picker, icon picker
  goals.js           ← savings goals + debt trackers
  budgets.js         ← per-category spending caps
  recurring.js       ← recurring rules editor + next-booking preview
  settings.js        ← settings drawer (tags, sync, theme, backup, import/export, API keys, users)
  app.js             ← boot: auth bootstrap + init() (loads last)
  state.js           ← central app state (grouped `appState` object)
  utils.js           ← pure helpers (loaded before app.js)
  reportsData.js     ← pure report/goal/trend aggregation (loaded before app.js)
  i18n.js            ← i18n runtime (window.I18N, tr(), locale/currency)
  i18n/              ← translation bundles (de.json, en.json)
  sw.js              ← service worker (cache + outbox)
  db.js              ← IndexedDB helper for outbox
  icons/categories/sprite.svg  ← category glyphs (Phosphor Regular, MIT)
  fonts/             ← DM Sans + DM Serif Display woff2
  vendor/            ← third-party bundles (Chart.js)
backend/
  docker-entrypoint.sh  ← chown /config, drop to PUID/PGID via gosu
  Dockerfile
  migrations/
  app/
    main.py            ← DomainError handler, security-headers middleware, router wiring, StaticFiles
    deps.py            ← session/CSRF cookie I/O + dependency chain (CurrentUser/AdminUser/DB)
    routers/           ← one APIRouter per domain; wired by main.include_router
    models.py          ← SQLAlchemy ORM
    schemas.py         ← Pydantic v2
    crud/              ← user_id-scoped queries, one module per domain; __init__ re-exports all
    auth.py            ← session, CSRF, brute-force (per-user lockout)
    rate_limit.py      ← per-IP login/setup throttle (in-memory, LOGIN_IP_* env)
    recurring.py       ← catch-up / materialization engine
    recurring_dates.py ← pure occurrence date math (no DB)
    database.py        ← engine selection: SQLite | MariaDB
    proxies.py         ← trusted reverse-proxy check (TRUSTED_PROXIES)
    logging_config.py  ← central logging setup
    cli.py             ← operator CLI (reset-admin-password, backup); launcher: `pocketlog <cmd>` (pocketlog-cli.sh)
tests/               ← pytest suite (backend)
```

## Third-Party Assets & Privacy

All assets from own origin — no CDNs, no tracking.
**Before adding any new asset**, vendor it locally:
- JS lib → `frontend/vendor/<name>.js` (shasum, MIT/Apache/BSD, keep banner)
- Font → `frontend/fonts/<name>.woff2` (latin + latin-ext)
- UI icon → `<symbol id="icon-…">` into the inline sprite in `index.html`
- Category icon → `<symbol id="cat-…">` in `sprite.svg` + `CAT_ICON_GROUPS` in `categories.js`; Phosphor Regular (MIT) only

## API Endpoints (FastAPI)
```
# Public
GET    /api/health | /api/version | /api/auth/setup-status
POST   /api/auth/setup | /api/auth/login | /api/auth/logout

# User (session cookie + X-CSRF-Token on non-GET)
GET    /api/auth/me
POST   /api/auth/change-password
GET    /api/transactions?year=&month=&from=&to=
POST|PUT|DELETE /api/transactions/{id}
POST   /api/transactions/bulk        ← set_category | add_tags | remove_tags | delete
GET|POST|PUT|DELETE /api/categories/{id}
GET|POST /api/goals
PUT|DELETE /api/goals/{id}
GET|POST /api/budgets
PUT|DELETE /api/budgets/{id}
GET|POST /api/tags
PUT|DELETE /api/tags/{name}
GET|PUT  /api/settings
POST   /api/import/csv               ← ImportUser (session OR Bearer w/ import scope)
GET    /api/export/csv
GET    /api/export/json              ← full-account JSON backup (ReadUser)
POST   /api/import/json              ← restore backup; session-only, requires empty ledger (409 restore_not_empty)
GET|POST /api/api-keys               ← session-only; POST returns raw plk_ key once
DELETE /api/api-keys/{id}
GET|POST /api/recurring
PUT|DELETE /api/recurring/{id}
POST   /api/recurring/{id}/skip-next
DELETE /api/recurring/{id}/skip/{date}
DELETE /api/admin/transactions | /api/admin/all-data   ← self-service

# Admin (+ admin role)
GET|POST /api/admin/users
POST   /api/admin/users/{id}/reset-password | deactivate | activate
DELETE /api/admin/users/{id}
```

## Database Schema (SQLite default / MariaDB option)
```
users           id, username UNIQUE, password_hash (argon2id), is_admin, is_active,
                force_change_password, failed_login_count, lockout_until
sessions        id, user_id FK CASCADE, token_hash CHAR(64) UNIQUE, csrf_token CHAR(64),
                created_at, last_seen_at, expires_at, absolute_expires_at, remember_me
categories      id, user_id FK CASCADE, name, icon, color — UNIQUE(user_id, name)
transactions    id, user_id FK CASCADE, amount DECIMAL(12,2), description,
                category_id FK RESTRICT, date, type ENUM('in','out'),
                source_rule_id FK SET NULL → recurring_rules.id
tags            id, user_id FK CASCADE, name VARCHAR(64) — UNIQUE(user_id, name)
transaction_tags  transaction_id FK CASCADE, tag_id FK CASCADE — PK(both)
user_settings   user_id PK FK CASCADE, theme, default_view, locale (BCP-47), currency (ISO 4217)
goals           id, user_id FK CASCADE, name, direction ENUM('save_up','pay_down'),
                category_id FK CASCADE, initial_amount, target_amount DECIMAL(12,2),
                start_date, icon, color — UNIQUE(user_id, category_id) [1:1 goal↔category]
budgets         id, user_id FK CASCADE, category_id FK CASCADE, amount DECIMAL(12,2),
                frequency ENUM('monthly','quarterly','yearly')
                UNIQUE(user_id, category_id) [1:1 budget↔category; independent of goals]
recurring_rules id, user_id FK CASCADE, name, amount DECIMAL(12,2), type ENUM('in','out'),
                category_id FK RESTRICT, description, frequency, interval,
                weekday (nullable), day_of_month (nullable; 31=last), start_date, end_date,
                max_occurrences, next_occurrence_date (cursor; NULL=terminated),
                occurrences_count, active BOOL — INDEX(user_id, active, next_occurrence_date)
recurring_rule_tags   rule_id FK CASCADE, tag_id FK CASCADE — PK(both)
recurring_rule_skips  rule_id FK CASCADE, skip_date DATE — PK(both)
```
Tags many-to-many via `transaction_tags`. Goals/budgets: progress/consumption **derived in frontend** (no SQL SUM — money rule). Category deletion blocked (409) while a goal, budget, or recurring rule references it (`_CATEGORY_DELETE_GUARDS` in `crud.delete_category`).

## Auth Concept

Cookie `pocketlog_session` (HttpOnly, SHA256 in DB) + `pocketlog_csrf` (Double-Submit). `get_current_user()`: cookie → lookup → expiry → active → CSRF (`hmac.compare_digest`) → sliding refresh. `Secure` flag via `SESSION_COOKIE_SECURE` (`auto`: reads `X-Forwarded-Proto` from trusted proxies only). `CurrentUser` blocks on `force_change_password` (except `/me`, `/logout`, `/change-password`). Brute-force: exponential per-user lockout from attempt 5 (1 s → 60 s cap) **plus** per-IP throttle on login+setup (`rate_limit.py`: threshold 20 per window, cap 600 s; key = trusted proxy's *rightmost* XFF entry — never `client_ip()`, which is audit-only and client-seedable). `GET /api/auth/me` also opportunistically runs `auth.maybe_cleanup_expired_sessions` (damped, at most once/hour per process) — no separate cron/scheduler in this deployment.

**API keys:** `plk_…` Bearer tokens; raw key shown once, only SHA256 stored. Scopes: `read` < `import` < `write`. Session users bypass scope checks. No `admin` scope — user management and bulk-delete are session-only, never token-reachable.

## Logging & Audit

Central config in `logging_config.py`. Loggers: `pocketlog.api`, `pocketlog.crud`, `pocketlog.audit` (security events). Format: `%(asctime)s %(levelname)s %(name)s %(message)s` (datefmt `%Y-%m-%d %H:%M:%S`). `uvicorn.access` pinned to WARNING. `LOG_FORMAT=json` for structured output. Optional `LOG_FILE` (rotating). Audit events logged in the **router layer only** — never in `crud/*`/`deps.py`/`auth.py`. **Never log** passwords, tokens, cookies, or user-supplied free text.

## Offline / PWA
`sw.js`: network-first for HTML + GET /api/\*, cache-first for vendor/fonts/icons. Offline outbox (POST/PUT/DELETE) via `db.js` (IndexedDB). Cache keys from `__APP_VERSION__` (Dockerfile substitutes at build time). Both i18n bundles in SHELL precache.

## i18n (Locale & Currency)
Two static bundles (`i18n/de.json`, `i18n/en.json`); `i18n.js` provides `window.I18N` + `tr()`. Full BCP-47 locale stored; translation bundle = primary subtag. `SUPPORTED_LOCALES` must stay in sync across `i18n.js`, `schemas.py`, and `<option>` pickers. Currency is display-only. Both JSON catalogs must have **identical keys**. API returns **stable error codes** for CSV import and password validation; frontend translates them (`importExport.error.*`, `pwd.*`).

## Deployment → [`README.md`](README.md)
## Design Conventions (Frontend) → Consult [`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md) before every frontend change.

## Conventions

**Branching/PR workflow:** `feature/*` → `dev` (PRs always against `dev`); `dev → main` = release. `main`/`dev` are protected. Details: [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Language:** Everything in English — code, comments, docs, commits, PRs.

**Backend:**
- CRUD functions always with `user_id: int`; pass `user.id` from `CurrentUser` in the endpoint
- New endpoints: add to `app/routers/<domain>.py` + `schemas.py` + `app/crud/<domain>.py`. New domain: declare `router = APIRouter()`, re-export in `routers/__init__.py`, `app.include_router` in `main.py`.
- `app/crud/` is a package; one module per domain; `__init__` re-exports full surface — call sites always use `crud.<fn>`. `_shared` is the lowest leaf; keep dependency graph acyclic.
- Audit events in the **router layer only**; `crud/*`/`deps.py`/`auth.py` remain audit-free.
- `from_attributes=True` on output schemas; `populate_by_name=True` only with `Field(alias=…)`
- Schema changes: Alembic revision only — never manual `ALTER TABLE`
- `StaticFiles` mount last in `main.py`
- **Money** (`DECIMAL(12,2)`): never `SQL SUM()` — SQLite rounds through float. Sum in Python over ORM `Decimal` values. `tests/test_money_precision.py` pins this.

**Frontend:**
- **Classic scripts, no bundler** (CSP `script-src 'self'`). Script order: `i18n.js`, `utils.js`, `reportsData.js`, `state.js`, feature modules (`core.js` → … → `settings.js`), `app.js` last. Top-level statements may only call functions from the same file or an earlier one (hoisting doesn't cross script boundaries). Any new `.js` must be added in **four places**: `index.html` (script tag), `sw.js` (SHELL precache), `sw.js` (network-first list), `Dockerfile` (static COPY).
- **App state in `state.js`** as `appState` — no loose module-global `let`s in feature modules.
- **Pure helpers** (`utils.js`, `reportsData.js`): no DOM/state/I18N; unit-tested with Vitest (`frontend/unit/*.test.js`).

**Alembic migrations:**
- Revision ID ≤ 24 characters (pytest guard in `test_migrations.py`)
- DDL idempotent: guard with `sa.inspect()` (see `0007_tx_category_idx.py`)
- MariaDB-only SQL split by `dialect.name`
- `drop_constraint`/`alter_column` always inside `batch_alter_table`

## Subagents (`.claude/agents/`)

| Agent | Responsible for |
|---|---|
| `review` | Code review (conventions, correctness) |
| `security-review` | Auth, queries, header validation, uploads |
| `ui-review` | Design conventions, layout, responsiveness |
| `db-review` | Alembic migrations, schema changes |
| `token-audit` | Hardcoded CSS values instead of design tokens |
| `copy-review` | UI copy, Apple Style Guide |
| `pwa-review` | Service worker, cache strategy, offline outbox |
| `vendor-audit` | Vendored JS/fonts/icons — license, source, privacy |
| `test-review` | pytest quality: coverage gaps, CSRF, data isolation |

Update affected agents when conventions change.
