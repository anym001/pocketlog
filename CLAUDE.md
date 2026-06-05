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
   SQLite file /config/db/pocketlog.db (default)
   · OR external MariaDB (opt-in via DB_*)
```
Backend selection is implicit (`database.py:_build_url`): `DATABASE_URL` wins;
otherwise MariaDB as soon as any `DB_*` variable is set (`DB_PASSWORD`
then required); otherwise SQLite at `SQLITE_PATH` (default `/config/db/pocketlog.db`).

## Project Structure
```
PocketLog/
├── frontend/
│   ├── index.html          ← PWA shell (markup + inline theme bootstrap)
│   ├── styles.css          ← complete CSS (tokens, layout, components)
│   ├── app.js              ← complete app logic
│   ├── i18n.js             ← i18n runtime (window.I18N, tr(), locale/currency)
│   ├── i18n/               ← translation bundles (de.json, en.json)
│   ├── sw.js               ← service worker (cache + outbox)
│   ├── db.js               ← IndexedDB helper for outbox
│   ├── manifest.webmanifest
│   ├── icons/categories/sprite.svg  ← category glyphs (Phosphor Regular, MIT)
│   ├── fonts/              ← DM Sans + DM Serif Display woff2
│   └── vendor/             ← third-party bundles (Chart.js)
├── backend/
│   ├── Dockerfile
│   ├── migrations/
│   └── app/
│       ├── main.py         ← FastAPI endpoints + StaticFiles mount
│       ├── models.py       ← SQLAlchemy ORM
│       ├── schemas.py      ← Pydantic v2
│       ├── crud.py         ← user_id-scoped queries
│       ├── auth.py         ← session, CSRF, brute-force
│       ├── recurring.py    ← catch-up / materialization engine
│       ├── database.py     ← engine selection: SQLite (default) | MariaDB (pymysql)
│       ├── logging_config.py ← central logging setup (configure_logging())
│       └── cli.py          ← operator CLI (reset-admin-password)
├── backend/
│   └── docker-entrypoint.sh  ← chown /config, drop to PUID/PGID via gosu
├── tests/                    ← pytest suite (backend)
├── CLAUDE.md
├── CONTRIBUTING.md
└── DESIGN_CONVENTIONS.md
```

## Third-Party Assets & Privacy

All assets from own origin — no CDNs, no tracking.
**Before adding any new asset**, vendor it locally:
- JS lib → `frontend/vendor/<name>.js` (shasum, MIT/Apache/BSD, keep banner)
- Font → `frontend/fonts/<name>.woff2` (latin + latin-ext)
- UI icon → `<symbol id="icon-…">` into the inline sprite in `index.html`
- Category icon → `<symbol id="cat-…">` in `sprite.svg` + `CAT_ICON_GROUPS` in `app.js`; Phosphor Regular (MIT) only

## API Endpoints (FastAPI)
```
# Public
GET    /api/health
GET    /api/version
GET    /api/auth/setup-status
POST   /api/auth/setup           ← only while no admin exists
POST   /api/auth/login           ← cookie + CSRF; 429 + Retry-After on lockout
POST   /api/auth/logout

# User (session cookie + X-CSRF-Token on non-GET)
GET    /api/auth/me
POST   /api/auth/change-password ← invalidates all other sessions
GET    /api/transactions?year=&month=&from=&to=
POST|PUT|DELETE /api/transactions/{id}
GET|POST|PUT|DELETE /api/categories/{id}   ← DELETE only when no referenced transactions **and** no linked goal
GET|POST /api/goals
PUT|DELETE /api/goals/{id}       ← 1:1 to category; 409 if category already has a goal. Progress is calculated in the frontend (no aggregate in the API)
GET|POST /api/tags
PUT|DELETE /api/tags/{name}      ← PUT renames across all transactions
GET|PUT  /api/settings
POST   /api/import/csv           ← max. 5 MB, UTF-8 or CP1252
GET    /api/export/csv
GET|POST /api/recurring
PUT|DELETE /api/recurring/{id}   ← DELETE leaves existing transactions intact (source_rule_id → NULL)
POST   /api/recurring/{id}/skip-next   ← skips the next occurrence, returns new cursor
DELETE /api/recurring/{id}/skip/{date} ← un-skips a previously skipped date
DELETE /api/admin/transactions   ← self-service: own transactions
DELETE /api/admin/all-data       ← self-service: transactions + recurring rules + goals + tags + categories

# Admin (+ admin role)
GET|POST /api/admin/users
POST   /api/admin/users/{id}/reset-password  ← force_change=true, sessions killed
POST   /api/admin/users/{id}/deactivate|activate
DELETE /api/admin/users/{id}     ← cascade; not on self
```

## Database Schema (SQLite default / MariaDB option)
```
users           id, username UNIQUE, password_hash NULL (argon2id),
                is_admin, is_active, force_change_password,
                failed_login_count, lockout_until

sessions        id, user_id FK CASCADE, token_hash CHAR(64) UNIQUE,
                csrf_token CHAR(64), created_at, last_seen_at,
                expires_at, absolute_expires_at, remember_me, user_agent
                INDEX(expires_at)

categories      id, user_id FK CASCADE, name, icon, color
                UNIQUE(user_id, name)

transactions    id, user_id FK CASCADE, amount DECIMAL(12,2),
                description, category_id FK RESTRICT, date, type ENUM('in','out'),
                source_rule_id FK SET NULL → recurring_rules.id

tags            id, user_id FK CASCADE, name VARCHAR(64)
                UNIQUE(user_id, name)

transaction_tags  transaction_id FK CASCADE, tag_id FK CASCADE
                  PK(transaction_id, tag_id)

user_settings   user_id PK FK CASCADE, theme, default_view,
                locale (BCP-47, e.g. de-DE/de-AT/en-GB), currency (ISO 4217,
                display-only), updated_at

goals           id, user_id FK CASCADE, name, direction ENUM('save_up','pay_down'),
                category_id FK CASCADE, initial_amount DECIMAL(12,2),
                target_amount DECIMAL(12,2), start_date, icon, color,
                created_at, updated_at
                UNIQUE(user_id, category_id)   ← 1:1 category↔goal

recurring_rules id, user_id FK CASCADE, name UNIQUE(user_id),
                amount DECIMAL(12,2), type ENUM('in','out'),
                category_id FK RESTRICT, description,
                frequency ENUM('daily','weekly','monthly','quarterly','yearly'),
                interval, weekday (nullable, weekly only),
                day_of_month (nullable, monthly+; 31 = last day),
                start_date, end_date (nullable), max_occurrences (nullable),
                next_occurrence_date (nullable cursor; NULL = terminated),
                occurrences_count, active BOOL,
                created_at, updated_at
                INDEX(user_id, active, next_occurrence_date)  ← catch-up scan

recurring_rule_tags  rule_id FK CASCADE, tag_id FK CASCADE
                     PK(rule_id, tag_id)   ← tags inherited by every materialized transaction

recurring_rule_skips rule_id FK CASCADE, skip_date DATE
                     PK(rule_id, skip_date)  ← idempotent; consulted during materialization
```
Tags are many-to-many via `transaction_tags` (no JSON array any more, removed in migration 0008). Default categories are seeded once in `crud.create_user`.

**Goals (`goals`, migration 0011):** unified savings goal + debt tracker. A category carries at most one goal (`uq_goals_user_category`). Progress is **derived, never stored**: the frontend sums the transactions of the linked category from `start_date` (`in` for `save_up`, `out` for `pay_down`) — money rule observed (no SQL `SUM`). A goal **never** affects ledger totals. Category deletion is blocked (409) while a goal references it (`crud.delete_category`); CASCADE remains the DB safety net for user deletion.

**Recurring rules (`recurring_rules`, migrations 0012+):** booking templates materialized by `app.recurring.materialize_due` / `catch_up_safely`. Called on every `/api/auth/me` and `/api/transactions` GET — never on a separate schedule. The cursor (`next_occurrence_date`) is advanced per occurrence; NULL means terminated (end_date passed or max_occurrences reached). `active=False` rules are skipped entirely by the catch-up (`WHERE active = TRUE`). Skips (`recurring_rule_skips`) are consulted before each materialization step. Tags are linked via `recurring_rule_tags` and copied to each materialized transaction. Deleting a rule leaves its transactions intact (`source_rule_id → NULL`). Category deletion is blocked (409) while a rule references it.

## Auth Concept

Sessions as HttpOnly cookie `pocketlog_session` (opaque token, DB holds SHA256) + non-HttpOnly `pocketlog_csrf` for Double-Submit. `get_current_user()`: cookie → SHA256 lookup → `expires_at`/`absolute_expires_at` → `is_active` → CSRF check (non-GET, `hmac.compare_digest`) → sliding refresh (5-min damper).

Dependencies: `CurrentUser` = `require_active_password` (blocks on `force_change_password`; exceptions: `/api/auth/me`, `/api/auth/logout`, `/api/auth/change-password`). `AdminUser` = `require_admin` → `require_active_password`.

Brute-force protection: from the 5th failed attempt, exponential lockout (1 s → 60 s cap). Unknown users run through `verify_password_dummy()` (timing protection).

## Logging & Audit
Central config in `app/logging_config.py` (`configure_logging()`, called on import of `main.py`). Logger namespace `pocketlog` with its own stderr handler + `propagate=False`; modules use `pocketlog.api`/`pocketlog.crud`, **security events** use `pocketlog.audit`. **Uniform format** `%(asctime)s %(levelname)s %(name)s %(message)s` with `datefmt %Y-%m-%d %H:%M:%S` (second precision, **no** milliseconds): the `dictConfig` also redirects the `uvicorn`/`uvicorn.error`/`uvicorn.access` loggers to it (runs on app import after uvicorn's default, so it wins), and `alembic.ini` (separate migrations process) mirrors format + datefmt. This keeps Docker logs consistently formatted throughout. `uvicorn.access` is intentionally pinned to `WARNING` (per-request lines are noise; errors still come through `uvicorn.error` + app logs). **Short logger names:** a handler filter (`_ShortLoggerNameFilter`) trims framework names to the top-level package (`uvicorn.error`/`uvicorn.access`→`uvicorn`, `alembic.runtime.migration`→`alembic`) — severity is in the level, not the name; `pocketlog.*` remains intact (audit/api/crud are semantically significant). The migrations process configures logging separately via `alembic.ini`, so `migrations/env.py` attaches the same filter via `install_short_logger_names()`. ENV `LOG_LEVEL` (default INFO) and `LOG_FORMAT` (default `text`; `json` reserved, falls back to `text` until implemented — enabling it would be a pure dictConfig switch with no call-site changes). Optional `LOG_FILE` (+ `LOG_FILE_MAX_BYTES`/`LOG_FILE_BACKUPS`): an additional `RotatingFileHandler`, attached programmatically after the dictConfig and wrapped in try/except — an unwritable file only warns and lets the app continue on stderr (never crashes). Persistence is an operations concern (volume mount or Docker log driver), see README.

**App directory convention:** Persistent container state lives under `/config` (LinuxServer/Unraid standard, mounted to e.g. `/mnt/user/appdata/pocketlog`). Contents: the SQLite DB (`/config/db/pocketlog.db`, unless an external MariaDB is used) and the audit trail (`/config/logs/`, recommended `LOG_FILE` path). Future persistent data (uploads, backups) belong in the same `/config`, not in scattered paths — a single mount covers the entire app state.

**Container permissions (PUID/PGID):** The image starts as root; the entrypoint (`backend/docker-entrypoint.sh`) chowns `/config` to `PUID:PGID` (default `1000:1000`, Unraid `99:100`) and drops privileges via `gosu` before `alembic`+`uvicorn` run. This allows the SQLite file on the mount to be written with the correct host permissions. **SQLite pragmas** (`database.py`): `foreign_keys=ON` (cascades), `journal_mode=WAL` (concurrent reads/writes for PWA sync), `busy_timeout=5000`.

Audit events are logged **in the endpoint layer** (`main.py`) (where request IP via `client_ip()` + DB facts are available); `auth.py`/`crud.py` remain audit-free. Events: `auth.login.success/failure/lockout_triggered/during_lockout`, `auth.logout`, `auth.password.change_self/reset_admin`, `admin.user.create/deactivate/activate/delete`, `setup.admin_created`, `recurring.create/update/delete`, `data.reset_all_data`. **Never log:** passwords, hashes, session/CSRF tokens, cookies — only IDs, username, IP, counts. `tests/test_audit_logging.py` pins level/fields **and** the secret-leak protection. Logs in English.

## Offline / PWA
`sw.js`: network-first for HTML shell + GET /api/\*, cache-first for vendor/fonts/icons. Offline outbox (POST/PUT/DELETE) via `db.js` (IndexedDB). Cache keys from `__APP_VERSION__` (Dockerfile substitutes at build time). Both i18n bundles (`i18n/de.json`, `i18n/en.json`) are in the SHELL precache so that language switching works offline.

## i18n (Locale & Currency)
Two static JSON bundles at `frontend/i18n/<bundle>.json` (de/en today), shipped with the code — **no** DB translation table. `i18n.js` provides `window.I18N` + global `tr(key, params)`; `t` is reserved as a transaction loop variable, hence the helper is named `tr`.

- **The full locale (BCP-47) is stored**, e.g. `de-DE`, `de-AT`, `en-GB`, `en-US`. The **translation bundle** is the **primary subtag** (`de-AT`→`de`, `I18N.getBundle()`): one `en.json` serves all English variants; only **formatting** (date/number via `Intl`, `I18N.getLocale()`) differs between en-GB and en-US. Curated list in `SUPPORTED_LOCALES` (i18n.js + schemas.py + picker `<option>`s must stay in sync).
- **Static markup:** `data-i18n="key"` (textContent) or `data-i18n-attr="attr:key;attr2:key2"`. `I18N.applyStatic()` re-translates on locale change.
- **Dynamic strings:** `tr('key', { n: 3 })` with `{placeholder}` interpolation.
- **Currency is a separate ISO code** (`fmtCurrency`, `Intl`), display only — no conversion. **Month names** from `Intl` (`rebuildMonthNames()`).
- **Deployment default → user override:** `DEFAULT_LOCALE` / `DEFAULT_CURRENCY` as ENV (validated, fallback `de-DE`/`EUR`) seed new users; `/api/auth/setup-status` delivers `default_locale` to the setup screen. Per-user values in `user_settings` (+ localStorage mirror), reconciled on login via `reconcileSettingsFromServer`. `i18n:changed` event → re-render.
- Both JSON catalogs must have **identical keys** (pytest/CI-verifiable: key diff = empty).
- **CSV import example** exists per bundle (`example-import-de.csv` / `-en.csv`), `downloadExampleCSV()` selects by `I18N.getBundle()`.

- **Backend errors as codes (phase 3, done):** The API returns **stable codes** instead of prose for CSV import and password policy; the frontend translates them.
  - CSV import: `ImportRowError = {row, code, params}`; codes via `crud.CsvRowError` (e.g. `date_unrecognised {value}`, `row_limit {max}`, `db_conflict`). Frontend keys under `importExport.error.*`, displayed as a translated row list.
  - Password: `validate_password_complexity` raises `PydanticCustomError('password_complexity', …, {missing})`; 422 `type`/`ctx` are mapped in the frontend (`_passwordErrorMessage`) to `pwd.*`. Length uses the stable Pydantic codes `string_too_short`/`string_too_long`.
  - Import fallback category follows the user locale (`bundle_for_locale`), no hard-coded `Sonstiges` any more.
  - **CLI output is intentionally English-only** (operator tooling convention; no end user sees it). Logs likewise English.
  - **Intentionally static German:** `manifest.webmanifest` (`name`/`description`/`lang`) — a single served file; true localisation would require server-side content negotiation on `Accept-Language`.

## Deployment → [`README.md`](README.md)

## Design Conventions (Frontend)

→ Consult [`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md) before every frontend change.

Quick rules: mobile-first 430 px · `env(safe-area-inset-*)` · **DM Serif Display** + **DM Sans** only · `fmtCurrency(n)` / `fmtSignedCurrency(n)` · ISO 8601 · touch ≥ 44×44 px · WCAG-AA · app name always "PocketLog" · **no hardcoded inline text** — use `data-i18n`/`tr()` (see i18n section).

Tokens: `var(--accent/--green/--red/--text/--bg-canvas …)` · `--fs-*` · `--space-*` · `--r-*/--shadow-*/--z-*/--dur-*`. No hex/px literals — hardcoded values are almost always a bug.

## Conventions

**Branching/PR workflow (mandatory):** Development always on short-lived
`feature/*` branches, branched from `dev`. **PRs always against `dev`**,
**never** directly against `main`. `main` is updated exclusively via a PR
`dev → main` (= release; triggers the versioned image build).
`main` and `dev` are protected by ruleset (PR required, green checks, no
direct/force pushes). Image channels: `:dev` = maintainer staging, `:vX.Y.Z` =
production. Details: [`CONTRIBUTING.md`](CONTRIBUTING.md).

**Language:** Everything is English — code, comments, YAML, scripts, all docs (README.md, CLAUDE.md, CONTRIBUTING.md, DESIGN_CONVENTIONS.md), commit messages, and PR titles/descriptions.

**Backend:**
- CRUD functions always with `user_id: int`; pass `user.id` from `CurrentUser` in the endpoint
- New endpoints: `main.py` + `schemas.py` + `crud.py`
- `from_attributes=True` on output schemas; `populate_by_name=True` only with `Field(alias=…)`
- Schema changes: generate an Alembic revision, never manual `ALTER TABLE`
- Always register the `StaticFiles` mount last
- **Money** (`DECIMAL(12,2)`) must never be aggregated via SQL `SUM()`/`func.sum` — SQLite has no native decimal type and would round through float. Compute sums in Python over ORM `Decimal` values (the frontend calculates totals itself anyway). Per-row the round-trip is exact; `tests/test_money_precision.py` pins this.

**Alembic migrations:**
- Revision ID ≤ 24 characters (pytest guard in `test_migrations.py`)
- DDL idempotent: guard `op.create_*`/`op.drop_*` with `sa.inspect()` (example: `0007_tx_category_idx.py`)
- MariaDB-only SQL (`UPDATE…JOIN`, `REGEXP`, `CHAR_LENGTH`) split by `dialect.name`
- `drop_constraint`/`alter_column` always inside a `batch_alter_table` block

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
