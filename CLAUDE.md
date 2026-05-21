# PocketLog – Haushaltsbuch PWA – Claude Code Projektkontext

## Architektur-Übersicht
```
iPhone/iPad/Mac (installierte PWA)
        ↓ HTTPS
     SWAG Proxy          ← pocketlog.deinedomain.de
        ↓                  injiziert X-Auth-Secret in jeden Backend-Request
     Authentik           ← Forward Auth + MFA, setzt X-Authentik-Username
        ↓
  ┌─────────────────────────────────────┐
  │  FastAPI-Container :8000            │  /          → statische PWA-Files
  │  (uvicorn, Python 3.12)             │  /api/*     → Python API
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
GET    /api/health
GET    /api/version                      ← liefert {"version": "X.Y.Z"}, kein Auth
GET    /api/transactions?year=&month=    ← month optional → ganzes Jahr
POST   /api/transactions
PUT    /api/transactions/{id}
DELETE /api/transactions/{id}
GET    /api/categories                   ← Default-Kategorien werden bei User-Anlage geseedet (nicht hier)
POST   /api/categories
PUT    /api/categories/{id}
DELETE /api/categories/{id}              ← nur wenn keine TX referenziert
GET    /api/tags                         ← alle Tags des Users als [{name, count}] (alphabetisch sortiert; count = Anzahl Transaktionen mit diesem Tag in den letzten 30 Tagen)
PUT    /api/tags/{name}                  ← umbenennen in allen Transaktionen
DELETE /api/tags/{name}                  ← aus allen Transaktionen entfernen
GET    /api/settings                     ← {theme, default_view}, legt Default-Row beim 1. Aufruf an
PUT    /api/settings                     ← partial: theme?, default_view?
POST   /api/import/csv                   ← max. 5 MB, UTF-8 oder CP1252
GET    /api/export/csv
DELETE /api/admin/transactions           ← löscht alle Buchungen des Users
DELETE /api/admin/all-data               ← löscht Buchungen, Kategorien, Tags (User + Settings bleiben)
```

## Datenbankschema (MariaDB)
```sql
-- users
id INT PK AUTO_INCREMENT
username VARCHAR(150) UNIQUE   -- gespiegelter Authentik-Username

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
category_id INT FK -> categories.id (ON DELETE RESTRICT)
date DATE
type ENUM('in','out')
tags JSON                      -- Array von Strings

-- user_settings                -- UI-Präferenzen, gespiegelt aus localStorage
user_id INT PK FK -> users.id (ON DELETE CASCADE)
theme VARCHAR(16)              -- 'system' | 'light' | 'dark'
default_view VARCHAR(32)       -- 'transactions' | 'categories'
updated_at TIMESTAMP           -- DEFAULT/ON UPDATE CURRENT_TIMESTAMP
```
Beim ersten Request eines Users legt `crud.get_or_create_user` automatisch
einen Eintrag in `users` an (Lookup über `X-Authentik-Username`) und seedet
in demselben Schritt die Default-Kategorien (`crud._seed_default_categories`).
Das Seeding läuft bewusst nur beim Anlegen des Users — nicht bei jedem
`GET /api/categories` — damit `DELETE /api/admin/all-data` die Kategorien
nicht direkt wieder auferstehen lässt.

## Auth-Konzept
SWAG (Authentik Forward Auth) setzt `X-Authentik-Username`; injiziert außerdem `X-Auth-Secret`.
`get_current_user()` in `main.py` prüft beide Header (timing-safe); gibt das `User`-ORM-Objekt zurück.
Alle Queries filtern nach `user_id`. → Setup-Details: [`docs/SETUP.md`](docs/SETUP.md)

### Threat-Model

- **Multi-User auf Backend-Ebene** — beliebig viele Authentik-Identitäten teilen sich die DB; jede Query filtert nach `user_id`.
- **Ein User pro Gerät** — gleiche PWA-Installation wird nicht zwischen verschiedenen Authentik-Accounts geteilt. Daraus folgt: Service-Worker-Cache und IndexedDB-Outbox müssen nicht user-scopiert sein. Defense-in-Depth: bei 401 leert der SW den API-Cache, plus „Cache leeren"-Button in der Verwaltung.

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
- Nach erfolgreicher Auth setzt SWAG mehrere Header: `X-authentik-username`, `-email`, `-groups`, `-name`, `-uid`. Backend nutzt nur **username**; `Authorization` wird in `pocketlog.subdomain.conf` explizit geleert.

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

**Pflege:** Bei Konventionsänderungen die betroffenen Agents in `.claude/agents/` mitpflegen (neue Tokens → `token-audit.md`/`ui-review.md`; Schema → `db-review.md`; Vendor-Policy → `vendor-audit.md`; UI-Texte → `copy-review.md`).

## Bekannte Einschränkungen / TODO (Backlog)

Siehe [`TODO.md`](TODO.md) für offene Punkte (Features, PWA-Limits, Security).
