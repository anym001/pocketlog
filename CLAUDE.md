# PocketLog – Haushaltsbuch PWA – Claude Code Projektkontext

## Architektur-Übersicht
```
PWA (Browser / Homescreen)
        ↓ HTTPS
   Reverse Proxy          ← beliebig (nginx, Caddy, Traefik …)
        ↓
  ┌─────────────────────────────────────┐
  │  FastAPI-Container :8000            │  /        → statische PWA-Files
  │  (uvicorn, Python 3.12)             │  /api/*   → Python API
  │  App-Auth: pocketlog_session-Cookie + X-CSRF-Token-Header (Double-Submit).
  └──────────────────┬──────────────────┘
                     ↓
            externe MariaDB  (DB: pocketlog  User: pocketlog)
```

## Projektstruktur
```
PocketLog/
├── frontend/
│   ├── index.html          ← PWA-Shell (Markup + Inline-Theme-Bootstrap)
│   ├── styles.css          ← komplettes CSS (Tokens, Layout, Komponenten)
│   ├── app.js              ← komplette App-Logik
│   ├── sw.js               ← Service Worker (Cache + Outbox)
│   ├── db.js               ← IndexedDB-Helper für Outbox
│   ├── manifest.webmanifest
│   ├── icons/categories/sprite.svg  ← Kategorie-Glyphen (Phosphor Regular, MIT)
│   ├── fonts/              ← DM Sans + DM Serif Display woff2
│   └── vendor/             ← Drittanbieter-Bundles (Chart.js)
├── backend/
│   ├── Dockerfile
│   ├── migrations/
│   └── app/
│       ├── main.py         ← FastAPI Endpoints + StaticFiles-Mount
│       ├── models.py       ← SQLAlchemy ORM
│       ├── schemas.py      ← Pydantic v2
│       ├── crud.py         ← user_id-skopierte Queries
│       ├── auth.py         ← Session, CSRF, Brute-Force
│       └── database.py     ← MariaDB Engine (pymysql)
├── CLAUDE.md
└── DESIGN_CONVENTIONS.md
```

## Drittanbieter & Privacy

Alle Assets vom eigenen Origin — keine CDNs, kein Tracking.
**Vor jedem neuen Asset** lokal versionieren:
- JS-Lib → `frontend/vendor/<name>.js` (Shasum, MIT/Apache/BSD, Banner erhalten)
- Font → `frontend/fonts/<name>.woff2` (latin + latin-ext)
- UI-Icon → `<symbol id="icon-…">` ins Inline-Sprite in `index.html`
- Kategorie-Icon → `<symbol id="cat-…">` in `sprite.svg` + `CAT_ICON_GROUPS` in `app.js`; nur Phosphor Regular (MIT)

## API Endpoints (FastAPI)
```
# Public
GET    /api/health
GET    /api/version
GET    /api/auth/setup-status
POST   /api/auth/setup           ← nur solange kein Admin gesetzt ist
POST   /api/auth/login           ← Cookie + CSRF; 429 + Retry-After bei Lockout
POST   /api/auth/logout

# User (Session-Cookie + X-CSRF-Token bei non-GET)
GET    /api/auth/me
POST   /api/auth/change-password ← invalidiert alle anderen Sessions
GET    /api/transactions?year=&month=&from=&to=
POST|PUT|DELETE /api/transactions/{id}
GET|POST|PUT|DELETE /api/categories/{id}   ← DELETE nur ohne referenzierte TX
GET|POST /api/tags
PUT|DELETE /api/tags/{name}      ← PUT benennt in allen TX um
GET|PUT  /api/settings
POST   /api/import/csv           ← max. 5 MB, UTF-8 oder CP1252
GET    /api/export/csv
DELETE /api/admin/transactions   ← Self-Service: eigene Buchungen
DELETE /api/admin/all-data       ← Self-Service: Buchungen + Kategorien + Tags

# Admin (+ admin-Rolle)
GET|POST /api/admin/users
POST   /api/admin/users/{id}/reset-password  ← force_change=true, Sessions gekillt
POST   /api/admin/users/{id}/deactivate|activate
DELETE /api/admin/users/{id}     ← Cascade; nicht auf self
```

## Datenbankschema (MariaDB)
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
                description, category_id FK RESTRICT, date, type ENUM('in','out')

tags            id, user_id FK CASCADE, name VARCHAR(64)
                UNIQUE(user_id, name)

transaction_tags  transaction_id FK CASCADE, tag_id FK CASCADE
                  PK(transaction_id, tag_id)

user_settings   user_id PK FK CASCADE, theme, default_view, updated_at
```
Tags sind Many-to-Many via `transaction_tags` (kein JSON-Array mehr, entfernt in Migration 0008). Default-Kategorien werden einmalig bei `crud.create_user` geseedet.

## Auth-Konzept

Sessions als HttpOnly-Cookie `pocketlog_session` (opakes Token, DB hält SHA256) + non-HttpOnly `pocketlog_csrf` für Double-Submit. `get_current_user()`: Cookie → SHA256-Lookup → `expires_at`/`absolute_expires_at` → `is_active` → CSRF-Check (non-GET, `hmac.compare_digest`) → Sliding-Refresh (5-min-Damper).

Dependencies: `CurrentUser` = `require_active_password` (blockt bei `force_change_password`; Ausnahmen: `/api/auth/me`, `/api/auth/logout`, `/api/auth/change-password`). `AdminUser` = `require_admin` → `require_active_password`.

Brute-Force: ab 5. Fehlversuch exponentieller Lockout (1s → 60s Cap). Unbekannte User laufen durch `verify_password_dummy()` (Timing-Schutz).

## Offline / PWA
`sw.js`: network-first für HTML-Shell + GET /api/\*, cache-first für Vendor/Fonts/Icons. Offline-Outbox (POST/PUT/DELETE) via `db.js` (IndexedDB). Cache-Keys aus `__APP_VERSION__` (Dockerfile substituiert beim Build).

## Deployment → [`README.md`](README.md)

## Design Conventions (Frontend)

→ [`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md) vor jeder Frontend-Änderung nachschlagen.

Kurzregeln: Mobile-first 430 px · `env(safe-area-inset-*)` · nur **DM Serif Display** + **DM Sans** · `fmtCurrency(n)` / `fmtSignedCurrency(n)` · ISO 8601 · Touch ≥ 44×44 px · WCAG-AA · App-Name immer „PocketLog".

Tokens: `var(--accent/--green/--red/--text/--bg-canvas …)` · `--fs-*` · `--space-*` · `--r-*/--shadow-*/--z-*/--dur-*`. Keine Hex-/px-Literale — hardcodierte Werte sind fast immer ein Bug.

## Konventionen

**Sprache:** Code/Kommentare/YAML/Skripte → Englisch · Docs (CLAUDE.md, README.md) → Deutsch

**Backend:**
- CRUD-Funktionen immer mit `user_id: int`; im Endpoint `user.id` aus `CurrentUser` übergeben
- Neue Endpoints: `main.py` + `schemas.py` + `crud.py`
- `from_attributes=True` auf Out-Schemas; `populate_by_name=True` nur bei `Field(alias=…)`
- Schemaänderungen: Alembic-Revision generieren, nie manuell ALTER TABLE
- `StaticFiles`-Mount immer zuletzt registrieren

**Alembic-Migrationen:**
- Revision-ID ≤ 24 Zeichen (pytest-Guard in `test_migrations.py`)
- DDL idempotent: `op.create_*`/`op.drop_*` mit `sa.inspect()` absichern (Beispiel: `0007_tx_category_idx.py`)
- MariaDB-only SQL (`UPDATE…JOIN`, `REGEXP`, `CHAR_LENGTH`) per `dialect.name` splitten
- `drop_constraint`/`alter_column` immer in `batch_alter_table`-Block

## Subagents (`.claude/agents/`)

| Agent | Zuständig für |
|---|---|
| `review` | Code-Review (Konventionen, Korrektheit) |
| `security-review` | Auth, Queries, Header-Validierung, Uploads |
| `ui-review` | Design-Konventionen, Layout, Responsiveness |
| `db-review` | Alembic-Migrationen, Schema-Änderungen |
| `token-audit` | Hardcodierte CSS-Werte statt Design-Tokens |
| `copy-review` | UI-Texte, Apple Style Guide (Deutsch) |
| `pwa-review` | Service Worker, Cache-Strategie, Offline-Outbox |
| `vendor-audit` | Vendored JS/Fonts/Icons — Lizenz, Quelle, Privacy |
| `test-review` | pytest-Testqualität: Coverage-Lücken, CSRF, Datenisolation |

Bei Konventionsänderungen betroffene Agents mitpflegen.

