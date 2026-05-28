# PocketLog – Haushaltsbuch PWA – Claude Code Projektkontext

## Architektur-Übersicht
```
iPhone/iPad/Mac (installierte PWA)
        ↓ HTTPS
     SWAG Proxy          ← pocketlog.deinedomain.de
        ↓                  Domain-Tor: forward auth → Authentik
     Authentik           ← Passwort + MFA. KEINE Identität an die App;
        ↓                  X-Authentik-Username/Authorization werden ignoriert.
  ┌─────────────────────────────────────┐
  │  FastAPI-Container :8000            │  /          → statische PWA-Files
  │  (uvicorn, Python 3.12)             │  /api/*     → Python API
  │  App-Auth: pocketlog_session-Cookie + X-CSRF-Token-Header (Double-Submit).
  └──────────────────┬──────────────────┘
                     ↓
            externe MariaDB (vom User selbst betrieben)
            DB: pocketlog   User: pocketlog
```

## Projektstruktur
```
PocketLog/
├── unraid/
│   └── pocketlog.xml                 ← Community-Apps-Template für die Unraid-GUI
├── swag/                              ← Nur die Site-spezifischen SWAG-Configs
│   ├── pocketlog.subdomain.conf      ← App-Conf, gehört in /config/nginx/proxy-confs/
│   ├── internal.conf                  ← LAN-Only Allowlist (10/8, 172.16/12, 192.168/16, …)
│   ├── geoblock.conf, maxmind.conf    ← GeoIP2-Whitelist (LAN + zugelassene Länder)
│   └── errors.conf                    ← Custom-Error-Pages (linuxserver.io snippet)
│   (ssl.conf, proxy.conf, resolver.conf, authentik-{server,location}.conf
│    sind SWAG-Defaults aus dem Image und liegen nicht im Repo — siehe
│    „Auth-Konzept" weiter unten für die relevanten Annahmen.)
├── frontend/                         ← reine Source-Files, werden ins Image kopiert
│   ├── index.html                    ← PWA-Shell (Markup + Inline-Theme-Bootstrap)
│   ├── styles.css                    ← komplettes CSS (Tokens, Layout, Komponenten)
│   ├── app.js                        ← komplette App-Logik
│   ├── manifest.webmanifest
│   ├── sw.js                         ← Service Worker (Cache + Outbox)
│   ├── db.js                         ← IndexedDB-Helper für Outbox
│   ├── icons/                        ← 192/512/maskable + apple-touch-icon
│   │   └── categories/sprite.svg     ← Kategorie-Glyphen (Phosphor Regular, MIT)
│   ├── fonts/                        ← DM Sans + DM Serif Display woff2
│   └── vendor/                       ← Drittanbieter-Bundles (Chart.js)
├── backend/
│   ├── Dockerfile                    ← builds aus Repo-Root, kopiert backend/ und frontend/
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── migrations/
│   └── app/
│       ├── main.py                   ← FastAPI Endpoints + StaticFiles-Mount
│       ├── models.py                 ← SQLAlchemy ORM
│       ├── schemas.py                ← Pydantic v2
│       ├── crud.py                   ← username-skopierte Queries
│       └── database.py               ← MariaDB Engine (pymysql)
├── CLAUDE.md
├── DESIGN_CONVENTIONS.md             ← Frontend-Design- und Schreibregeln
└── docs/SETUP.md                     ← Deployment- und Auth-Setup-Anleitung
```

## Drittanbieter & Privacy

Alle Assets (Fonts, JS, Icons) kommen vom eigenen Origin — keine CDNs, kein Tracking.
**Vor jedem neuen Asset** lokal versionieren:
- JS-Lib → `frontend/vendor/<name>.js` (Shasum verifizieren, MIT/Apache/BSD, Banner erhalten)
- Font → `frontend/fonts/<name>.woff2` (latin + latin-ext subset)
- UI-Icon → `<symbol id="icon-…">` ins Inline-Sprite in `index.html`
- Kategorie-Icon → `<symbol id="cat-…">` ins `frontend/icons/categories/sprite.svg` + `CAT_ICON_GROUPS` in `app.js`; nur Phosphor Regular (MIT), keine Mischsets

Falls eine Abhängigkeit nur online verfügbar ist, im Code-Kommentar **und** hier dokumentieren.

## API Endpoints (FastAPI)
```
# Public (kein App-Login nötig)
GET    /api/health
GET    /api/version                      ← liefert {"version": "X.Y.Z"}
GET    /api/auth/setup-status            ← {needs_setup, suggested_username}
POST   /api/auth/setup                   ← nur solange kein Admin gesetzt ist
POST   /api/auth/login                   ← Cookie + CSRF; 429 + Retry-After bei Lockout
POST   /api/auth/logout                  ← braucht X-CSRF-Token

# User (Session-Cookie + X-CSRF-Token bei non-GET)
GET    /api/auth/me                      ← {id, username, is_admin, force_change_password, csrf_token}
POST   /api/auth/change-password         ← invalidiert alle anderen Sessions des Users
GET    /api/transactions?year=&month=    ← month optional → ganzes Jahr
POST   /api/transactions
PUT    /api/transactions/{id}
DELETE /api/transactions/{id}
GET    /api/categories                   ← Default-Kategorien werden bei User-Anlage geseedet (nicht hier)
POST   /api/categories
PUT    /api/categories/{id}
DELETE /api/categories/{id}              ← nur wenn keine TX referenziert
GET    /api/tags                         ← alle Tags des Users als [{name, count}] (alphabetisch sortiert; count = Anzahl Transaktionen mit diesem Tag in den letzten 30 Tagen)
POST   /api/tags                         ← neuen eigenständigen Tag anlegen (ohne Buchung) — landet in der tags-Tabelle und ist sofort im Picker sichtbar
PUT    /api/tags/{name}                  ← umbenennen in allen Transaktionen
DELETE /api/tags/{name}                  ← aus allen Transaktionen entfernen
GET    /api/settings                     ← {theme, default_view}, legt Default-Row beim 1. Aufruf an
PUT    /api/settings                     ← partial: theme?, default_view?
POST   /api/import/csv                   ← max. 5 MB, UTF-8 oder CP1252
GET    /api/export/csv
DELETE /api/admin/transactions           ← User-Self-Service: löscht alle Buchungen DES EIGENEN Users
DELETE /api/admin/all-data               ← User-Self-Service: löscht eigene Buchungen, Kategorien, Tags (User + Settings bleiben)

# Admin (Session-Cookie + admin-Rolle + X-CSRF-Token)
GET    /api/admin/users                  ← User-Liste mit Status
POST   /api/admin/users                  ← Username + Passwort; setzt force_change_password=true
POST   /api/admin/users/{id}/reset-password   ← neues Passwort, force_change=true, alle Sessions gekillt
POST   /api/admin/users/{id}/deactivate       ← nicht auf self, nicht auf andere Admins
POST   /api/admin/users/{id}/activate         ← nicht auf self
DELETE /api/admin/users/{id}                  ← Cascade-Löschung; nicht auf self
```

## Datenbankschema (MariaDB)
```sql
-- users                       -- App-eigene Identität; Authentik kommt
                               -- nicht mehr ans Backend.
id INT PK AUTO_INCREMENT
username VARCHAR(150) UNIQUE
password_hash VARCHAR(255) NULL          -- argon2id, NULL = noch nicht vergeben
is_admin BOOLEAN NOT NULL DEFAULT FALSE  -- genau ein Admin pro Installation
is_active BOOLEAN NOT NULL DEFAULT TRUE
force_change_password BOOLEAN NOT NULL DEFAULT FALSE
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
failed_login_count INT NOT NULL DEFAULT 0   -- Brute-Force-Backoff
lockout_until TIMESTAMP NULL                -- aktive Sperre, NULL = frei

-- sessions                    -- Server-seitige Session-Records.
                               -- Plain-Token nur im Cookie, DB hat sha256.
id INT PK AUTO_INCREMENT
user_id INT FK -> users.id (ON DELETE CASCADE) INDEX
token_hash CHAR(64) UNIQUE              -- sha256 hex des Cookie-Werts
csrf_token CHAR(64)                     -- separat, Double-Submit-Pattern
created_at TIMESTAMP
last_seen_at TIMESTAMP                  -- Sliding-Refresh-Damper: 5 min
expires_at TIMESTAMP                    -- sliding (24h / 30d bei Remember-Me)
absolute_expires_at TIMESTAMP           -- hard cap (7d / 90d)
remember_me BOOLEAN
user_agent VARCHAR(255) NULL
INDEX (expires_at)                       -- cleanup-Job

-- categories
id INT PK AUTO_INCREMENT
user_id INT FK -> users.id (ON DELETE CASCADE) INDEX
name VARCHAR(100)
icon VARCHAR(64)               -- Phosphor-Icon-ID, z.B. 'house' (siehe frontend/icons/categories/sprite.svg)
color CHAR(7)                  -- #RRGGBB
UNIQUE (user_id, name)

-- transactions
id INT PK AUTO_INCREMENT
user_id INT FK -> users.id (ON DELETE CASCADE)  -- composite-index mit date
amount DECIMAL(12,2)
description VARCHAR(255)       -- im JSON heißt das Feld "desc" (Pydantic-Alias)
category_id INT FK -> categories.id (ON DELETE RESTRICT) INDEX
date DATE
type ENUM('in','out')
-- Tags liegen NICHT mehr als JSON-Array in dieser Tabelle (entfernt
-- in Migration 0008). Stattdessen Many-to-Many via transaction_tags.

-- tags                         -- alle Tags des Users; einzige Source of
                                -- Truth für Tag-Namen. Jeder Tag existiert
                                -- pro User genau einmal (case-insensitive
                                -- via casefold-Lookup in crud._resolve_tags).
id INT PK AUTO_INCREMENT
user_id INT FK -> users.id (ON DELETE CASCADE) INDEX
name VARCHAR(64)
UNIQUE (user_id, name)

-- transaction_tags              -- Junction; jede Verbindung Buchung↔Tag.
                                -- Rename eines Tags ändert tags.name
                                -- einmal und ist überall sichtbar.
                                -- Delete eines Tags → ON DELETE CASCADE
                                -- entfernt nur die Verknüpfungen, die
                                -- Buchung selbst bleibt.
transaction_id INT FK -> transactions.id (ON DELETE CASCADE)
tag_id         INT FK -> tags.id (ON DELETE CASCADE) INDEX
PRIMARY KEY (transaction_id, tag_id)

-- user_settings                -- UI-Präferenzen, gespiegelt aus localStorage
user_id INT PK FK -> users.id (ON DELETE CASCADE)
theme VARCHAR(16)              -- 'system' | 'light' | 'dark'
default_view VARCHAR(32)       -- 'transactions' | 'categories'
updated_at TIMESTAMP           -- DEFAULT/ON UPDATE CURRENT_TIMESTAMP
```
User werden über `crud.create_user` angelegt — entweder im Setup-Flow
(erster Admin) oder vom Admin über `POST /api/admin/users` (alle weiteren
Konten, mit `force_change_password=true`). `create_user` seedet in demselben
Schritt die Default-Kategorien (`crud._seed_default_categories`). Das Seeding
läuft bewusst nur beim Anlegen des Users — nicht bei jedem
`GET /api/categories` — damit `DELETE /api/admin/all-data` die Kategorien
nicht direkt wieder auferstehen lässt.

## Auth-Konzept

Zwei klar getrennte Schichten:

1. **Domain-Tor (SWAG + Authentik):** Forward Auth über
   `/config/nginx/authentik-location.conf`. Authentik macht
   Passwort + MFA. SWAG forwarded danach KEINE Identitäts-Header an die
   App — `Authorization` wird explizit geleert, `X-Authentik-Username`
   nicht mehr gesetzt.
2. **App-Login (PocketLog):** Eigene Username/Passwort-Login-View,
   eigene `users`-Tabelle, eigene Admin-Rolle. Sessions als
   HttpOnly-Cookie `pocketlog_session` (opakes Token; DB hält sha256
   davon) + non-HttpOnly `pocketlog_csrf`-Cookie für Double-Submit.

`get_current_user()` in `main.py`:
1. liest `pocketlog_session` aus den Cookies,
2. holt die Session-Row via sha256-Hash, prüft `expires_at` +
   `absolute_expires_at`,
3. lädt den User, prüft `is_active`,
4. für non-GET-Methoden: vergleicht `X-CSRF-Token`-Header gegen
   `session.csrf_token` (timing-safe via `hmac.compare_digest`),
5. sliding-refresht `last_seen_at`/`expires_at` mit 5-Minuten-Damper,
6. gibt das `User`-ORM-Objekt zurück.

Alle Queries filtern weiterhin nach `user_id`. Weitere Dependencies:
`require_active_password` blockt jeden App-Endpoint, solange der User
das `force_change_password`-Flag trägt (Ausnahmen: `/api/auth/me`,
`/api/auth/logout`, `/api/auth/change-password`). `require_admin` ist
die Stacking-Dep für `/api/admin/users/*`. → Setup-Details:
[`docs/SETUP.md`](docs/SETUP.md)

### Brute-Force-Backoff (in `auth.py`)

`record_failed_login` zählt pro User; ab dem 5. Fehlversuch verdoppelt
sich der Lockout (Start: 1s, Cap: 60s). Erfolgreicher Login resettet,
genauso wie ein Admin-`reset-password`. Login gegen unbekannten User
läuft durch `verify_password_dummy()` (konstante-Zeit Argon2-Verify
gegen einen Dummy-Hash), damit Username-Enumeration via Timing zu ist.

### Threat-Model

- **Multi-User auf Backend-Ebene** — beliebig viele PocketLog-Identitäten teilen sich die DB; jede Query filtert nach `user_id`.
- **Ein User pro Gerät** — gleiche PWA-Installation wird nicht zwischen verschiedenen Konten geteilt. Daraus folgt: Service-Worker-Cache und IndexedDB-Outbox müssen nicht user-scopiert sein. Beim Logout wird der API-Cache via `CLEAR_API_CACHE`-Message an den SW explizit geleert, plus „Cache leeren"-Button in der Verwaltung als Defense-in-Depth.
- **Cookie-Replay nach Diebstahl** — sliding 24h/30d + absolute 7d/90d. Stillem Angreifer reicht ein Request alle 23h nicht aus, weil die absolute Frist greift.
- **Direktzugriff hinter den Proxy** — kein `X-Auth-Secret`-Shared-Secret mehr; an `pocketlog_session` kommt der Angreifer nur durch valides Cookie-Stealing. SWAG bleibt davor als zusätzliche LAN/Geo-Allowlist.

### SWAG-Setup (extern, Referenz)

PocketLog läuft hinter `linuxserver/swag`. Die SWAG-Default-Snippets liegen
nicht im Repo (Container-Image), sind aber für Reviews relevant:

**Globale Security-Header aus `ssl.conf`** (gelten für ALLE Apps am Proxy):
- `Strict-Transport-Security: max-age=15768000; includeSubDomains; preload`
- `Referrer-Policy: same-origin`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN` — Backend-CSP setzt `frame-ancestors 'none'` strikter
- `Permissions-Policy: interest-cohort=()` (nur FLoC-Opt-out)
- `X-XSS-Protection: 1; mode=block`, `X-Robots-Tag`, `X-Download-Options: noopen`, `Alt-Svc`
- TLS 1.2/1.3, Mozilla intermediate cipher suite, HTTP/2 + HTTP/3 (QUIC) aktiv

→ Diese Header NICHT in der App nochmal setzen — nginx `add_header` ist additiv und würde Doppel-Header senden. Einzig **Content-Security-Policy** wird in der FastAPI-Middleware (`backend/app/main.py`) gesetzt, weil SWAG keine liefert.

**Forward-Auth aus `authentik-{server,location}.conf`**:
- `/outpost.goauthentik.io/*` ist auf den Authentik-Outpost gemountet
- `auth_request /outpost.goauthentik.io/auth/nginx` läuft pro Request; bei 401 → Redirect zum Login (inkl. MFA via Authentik-Flow)
- `Authorization` wird in `pocketlog.subdomain.conf` explizit geleert. Authentik-Identitäts-Header werden NICHT mehr durchgereicht — die App liest sie ohnehin nicht.

**Site-spezifische Layer** (im Repo unter `swag/`):
- `geoblock.conf` + `maxmind.conf` — return 404 außerhalb LAN + Länder-Whitelist
- `internal.conf` — zusätzlich harte LAN-Allowlist (10/8, 172.16/12, 192.168/16, IPv6 ULA/link-local)
- `errors.conf` — Custom-Error-Pages

## Offline / PWA
- `frontend/sw.js`: precached App-Shell, network-first für die HTML-Shell und GET /api/*, cache-first für Icons, Fonts und das Chart.js-Vendor-Bundle; Offline-Outbox für POST/PUT/DELETE. Cache-Keys werden aus `__APP_VERSION__` gebildet — das Dockerfile substituiert beim Build die echte Release-Version.
- `frontend/db.js`: IndexedDB-Wrapper für die Outbox (`enqueue`, `drain`, `count`).
- Sync-Button im UI (`syncNow()`) triggert manuell den Outbox-Flush; bei wieder hergestellter Verbindung läuft Background-Sync.

## Deployment

→ [`docs/SETUP.md`](docs/SETUP.md)

## Design Conventions (Frontend)

Alle Design- und UI-Konventionen (Layout, Farbe, Typografie, Liquid Glass, Barrierefreiheit, Apple Style Guide) sind in [`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md) ausgelagert — vor jeder Frontend-Änderung nachschlagen.

Harte Kurzregeln: Mobile-first 430 px · `env(safe-area-inset-*)` · nur **DM Serif Display** + **DM Sans** · `fmtCurrency(n)` / `fmtSignedCurrency(n)` für Beträge · Datum ISO 8601 · Touch-Targets ≥ 44×44 px · WCAG-AA · App-Name immer „PocketLog".

**Tokens:** Farben via `var(--accent/--green/--red/--text/--bg-canvas …)`, Typografie via `--fs-*`, Spacing via `--space-*`, Radien/Schatten/Z-Layer/Motion via `--r-*/--shadow-*/--z-*/--dur-*`. Keine Hex-/px-Literale neu einführen — bei Unklarheit erst in `:root` von `styles.css` und in `DESIGN_CONVENTIONS.md` nachschlagen. Hardcodierte Werte sind fast immer ein Bug.

## Sprach-Konventionen

- **Code, Kommentare, Workflow-YAML, Skripte, Nginx-Configs (`swag/`):** Englisch
- **Dokumentation (CLAUDE.md, TODO.md, README.md, unraid/pocketlog.xml):** Deutsch

## Konventionen Backend
- CRUD-Funktionen immer mit `user_id: int` Parameter (Datenisolation); im Endpoint `user.id` aus der `CurrentUser`-Dep übergeben
- Neue Endpoints: `main.py` + Schema in `schemas.py` + Logik in `crud.py`
- `from_attributes=True` auf allen „Out"-Schemas, die via `model_validate()` aus einem ORM-Objekt gebaut werden
- `populate_by_name=True` nur wenn `Field(alias=…)` oder `Field(serialization_alias=…)` verwendet wird
- Schemaänderungen: Alembic-Revision generieren, nicht manuell ALTER TABLE
- StaticFiles-Mount IMMER zuletzt registrieren, damit `/api/*` vorher matcht

### Konventionen Alembic-Migrationen

Migrationen laufen im Container-Entrypoint **vor** uvicorn. Ein Crash blockiert das gesamte Deployment, und MariaDB committet DDL auto-transactionally — eine halb gelaufene Migration hinterlässt also bleibenden Zustand, den der nächste Startversuch wieder findet. Daraus folgen zwei harte Regeln:

- **Revision-IDs ≤ 24 Zeichen.** `alembic_version.version_num` ist `VARCHAR(32)`, harte Obergrenze. Konvention: 24, damit Puffer für Tippfehler/Suffixe bleibt. Wird per pytest geprüft (`backend/tests/test_migrations.py`).
- **DDL immer idempotent.** Jedes `op.create_index` / `op.create_table` / `op.add_column` / `op.drop_*` davor mit `sa.inspect(op.get_bind())` prüfen, ob die Operation schon angewendet ist, und im Trefferfall `return`. Beispiel: `0007_tx_category_idx.py`. Grund: ein halb-applied Container muss sich beim Neustart selbst erholen können, ohne dass jemand händisch SQL ausführt.

## Subagents (`.claude/agents/`)

PocketLog hat projektspezifische Claude-Code-Subagents für Review-Aufgaben:

| Agent | Zuständig für |
|---|---|
| `review` | Allgemeines Code-Review (Konventionen, Korrektheit) |
| `security-review` | Auth, Queries, Header-Validierung, Uploads |
| `ui-review` | Design-Konventionen, Layout, Responsiveness |
| `db-review` | Alembic-Migrationen, Schema-Änderungen |
| `token-audit` | Hardcodierte CSS-Werte statt Design-Tokens |
| `copy-review` | UI-Texte, Apple Style Guide (Deutsch) |
| `pwa-review` | Service Worker, Cache-Strategie, Offline-Outbox |
| `vendor-audit` | Vendored JS/Fonts/Icons — Lizenz, Quelle, Privacy |
| `test-review` | pytest-Testqualität: Coverage-Lücken, CSRF in Tests, Datenisolation, Migrationsidempotenz |

**Pflege:** Bei Konventionsänderungen die betroffenen Agents in `.claude/agents/` mitpflegen (neue Tokens → `token-audit.md`/`ui-review.md`; Schema → `db-review.md`; Vendor-Policy → `vendor-audit.md`; UI-Texte → `copy-review.md`).

## Bekannte Einschränkungen / TODO (Backlog)

Siehe [`TODO.md`](TODO.md) für offene Punkte (Features, PWA-Limits, Security).
