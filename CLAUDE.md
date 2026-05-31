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
│   ├── i18n.js             ← i18n-Runtime (window.I18N, tr(), Locale/Currency)
│   ├── i18n/               ← Übersetzungs-Bundles (de.json, en.json)
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

user_settings   user_id PK FK CASCADE, theme, default_view,
                locale (BCP-47, z.B. de-DE/de-AT/en-GB), currency (ISO 4217,
                display-only), updated_at
```
Tags sind Many-to-Many via `transaction_tags` (kein JSON-Array mehr, entfernt in Migration 0008). Default-Kategorien werden einmalig bei `crud.create_user` geseedet.

## Auth-Konzept

Sessions als HttpOnly-Cookie `pocketlog_session` (opakes Token, DB hält SHA256) + non-HttpOnly `pocketlog_csrf` für Double-Submit. `get_current_user()`: Cookie → SHA256-Lookup → `expires_at`/`absolute_expires_at` → `is_active` → CSRF-Check (non-GET, `hmac.compare_digest`) → Sliding-Refresh (5-min-Damper).

Dependencies: `CurrentUser` = `require_active_password` (blockt bei `force_change_password`; Ausnahmen: `/api/auth/me`, `/api/auth/logout`, `/api/auth/change-password`). `AdminUser` = `require_admin` → `require_active_password`.

Brute-Force: ab 5. Fehlversuch exponentieller Lockout (1s → 60s Cap). Unbekannte User laufen durch `verify_password_dummy()` (Timing-Schutz).

## Logging & Audit
Zentrale Config in `app/logging_config.py` (`configure_logging()`, beim Import von `main.py` aufgerufen). Logger-Namespace `pocketlog` mit eigenem stderr-Handler + `propagate=False`; Module nutzen `pocketlog.api`/`pocketlog.crud`, **Security-Events** `pocketlog.audit`. ENV `LOG_LEVEL` (Default INFO) und `LOG_FORMAT` (Default `text`; `json` reserviert, fällt bis zur Implementierung auf `text` zurück — Aktivierung wäre ein reiner dictConfig-Switch ohne Call-Site-Änderung).

Audit-Events werden **im Endpoint-Layer** (`main.py`) geloggt (dort sind Request-IP via `client_ip()` + DB-Fakten verfügbar); `auth.py`/`crud.py` bleiben audit-frei. Events: `auth.login.success/failure/lockout_triggered/during_lockout`, `auth.logout`, `auth.password.change_self/reset_admin`, `admin.user.create/deactivate/activate/delete`, `setup.admin_created`. **Nie loggen:** Passwörter, Hashes, Session-/CSRF-Tokens, Cookies — nur IDs, Username, IP, Counts. `tests/test_audit_logging.py` pinnt Level/Felder **und** den Secret-Leak-Schutz. Logs Englisch.

## Offline / PWA
`sw.js`: network-first für HTML-Shell + GET /api/\*, cache-first für Vendor/Fonts/Icons. Offline-Outbox (POST/PUT/DELETE) via `db.js` (IndexedDB). Cache-Keys aus `__APP_VERSION__` (Dockerfile substituiert beim Build). Beide i18n-Bundles (`i18n/de.json`, `i18n/en.json`) liegen im SHELL-Precache, damit der Sprachwechsel offline funktioniert.

## i18n (Locale & Währung)
Zwei statische JSON-Bundles unter `frontend/i18n/<bundle>.json` (de/en heute), ausgeliefert mit dem Code — **keine** DB-Übersetzungstabelle. `i18n.js` stellt `window.I18N` + globales `tr(key, params)` bereit; `t` ist als TX-Loop-Variable belegt, deshalb heißt der Helper `tr`.

- **Gespeichert wird die volle Locale (BCP-47)**, z.B. `de-DE`, `de-AT`, `en-GB`, `en-US`. Das **Übersetzungs-Bundle** ist der **Primär-Subtag** (`de-AT`→`de`, `I18N.getBundle()`): ein `en.json` bedient jedes Englisch, nur die **Formatierung** (Datum/Zahl via `Intl`, `I18N.getLocale()`) unterscheidet en-GB vs en-US. Kuratierte Liste in `SUPPORTED_LOCALES` (i18n.js + schemas.py + Picker-`<option>`s synchron halten).
- **Statisches Markup:** `data-i18n="key"` (textContent) bzw. `data-i18n-attr="attr:key;attr2:key2"`. `I18N.applyStatic()` übersetzt beim Locale-Wechsel neu.
- **Dynamische Strings:** `tr('key', { n: 3 })` mit `{platzhalter}`-Interpolation.
- **Währung ist ein separater ISO-Code** (`fmtCurrency`, `Intl`), reine Anzeige — keine Umrechnung. **Monatsnamen** aus `Intl` (`rebuildMonthNames()`).
- **Deployment-Default → Nutzer-Override:** `DEFAULT_LOCALE` / `DEFAULT_CURRENCY` als ENV (validiert, Fallback `de-DE`/`EUR`) seeden neue User; `/api/auth/setup-status` liefert `default_locale` an den Setup-Screen. Per-User-Werte in `user_settings` (+ localStorage-Spiegel), beim Login per `reconcileSettingsFromServer` abgeglichen. `i18n:changed`-Event → Re-Render.
- Beide JSON-Kataloge müssen **deckungsgleiche Keys** haben (Pytest/CI-tauglich: Key-Diff = leer).
- **CSV-Import-Beispiel** liegt pro Bundle vor (`example-import-de.csv` / `-en.csv`), `downloadExampleCSV()` wählt nach `I18N.getBundle()`.

- **Backend-Fehler als Codes (Phase 3, erledigt):** Die API liefert für CSV-Import und Passwort-Policy **stabile Codes** statt deutscher Prosa; das Frontend übersetzt.
  - CSV-Import: `ImportRowError = {row, code, params}`; Codes via `crud.CsvRowError` (z.B. `date_unrecognised {value}`, `row_limit {max}`, `db_conflict`). Frontend-Keys unter `importExport.error.*`, Anzeige als übersetzte Zeilenliste.
  - Passwort: `validate_password_complexity` wirft `PydanticCustomError('password_complexity', …, {missing})`; 422-`type`/`ctx` werden im Frontend (`_passwordErrorMessage`) auf `pwd.*` gemappt. Länge nutzt die stabilen Pydantic-Codes `string_too_short`/`string_too_long`.
  - Import-Fallback-Kategorie folgt der User-Locale (`bundle_for_locale`), kein hartes „Sonstiges" mehr.
  - **CLI-Ausgaben sind bewusst Englisch-only** (Operator-Tooling-Konvention; kein User sieht sie). Logs ebenfalls Englisch.
  - **Bewusst statisch deutsch:** `manifest.webmanifest` (`name`/`description`/`lang`) — eine einzelne ausgelieferte Datei; echte Lokalisierung bräuchte Server-Content-Negotiation nach `Accept-Language`.

## Deployment → [`README.md`](README.md)

## Design Conventions (Frontend)

→ [`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md) vor jeder Frontend-Änderung nachschlagen.

Kurzregeln: Mobile-first 430 px · `env(safe-area-inset-*)` · nur **DM Serif Display** + **DM Sans** · `fmtCurrency(n)` / `fmtSignedCurrency(n)` · ISO 8601 · Touch ≥ 44×44 px · WCAG-AA · App-Name immer „PocketLog" · **keine deutschen Inline-Texte** — `data-i18n`/`tr()` verwenden (siehe i18n-Abschnitt).

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

