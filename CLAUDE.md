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

Ein einzelner Container liefert sowohl die PWA (StaticFiles-Mount in FastAPI)
als auch die JSON-API aus. MariaDB ist NICHT Teil des Stacks – sie wird vom
User selbst bereitgestellt (typisch: bestehender MariaDB-Container auf Unraid).

## Projektstruktur
```
PocketLog/
├── unraid/
│   └── pocketlog.xml                 ← Community-Apps-Template für die Unraid-GUI
├── swag/
│   └── pocketlog.subdomain.conf      ← SWAG-Snippet, proxy_pass → pocketlog:8000
├── frontend/                         ← reine Source-Files, werden ins Image kopiert
│   ├── index.html                    ← PWA (HTML+CSS+JS)
│   ├── manifest.webmanifest
│   ├── sw.js                         ← Service Worker (Cache + Outbox)
│   ├── db.js                         ← IndexedDB-Helper für Outbox
│   └── icons/                        ← 192/512/maskable + apple-touch-icon
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
└── CLAUDE.md
```

Im fertigen Image landen die PWA-Files unter `/app/static`. FastAPI mountet
diesen Ordner via `StaticFiles(html=True)` auf `/`, nachdem alle `/api/*`
Routes registriert sind.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS in einer Datei (`frontend/index.html`) + Service Worker
- **Backend:** FastAPI (Python 3.12), uvicorn auf Port 8000
- **Datenbank:** MariaDB 11 (extern, InnoDB, utf8mb4)
- **Auth:** Authentik Forward Auth (Standard-Flow inkl. MFA) + Shared-Secret-Header zwischen SWAG und Backend
- **Fonts:** DM Serif Display + DM Sans
- **Charts:** Chart.js 4.4.1 (CDN, im SW gecached)
- **Migrationen:** Alembic, läuft im Container-Entrypoint vor uvicorn

## API Endpoints (FastAPI)
```
GET    /api/health
GET    /api/version                      ← liefert {"version": "X.Y.Z"}, kein Auth
GET    /api/transactions?year=&month=    ← month optional → ganzes Jahr
POST   /api/transactions
PUT    /api/transactions/{id}
DELETE /api/transactions/{id}
GET    /api/categories                   ← legt beim 1. Aufruf Default-Kategorien an
POST   /api/categories
PUT    /api/categories/{id}
DELETE /api/categories/{id}              ← nur wenn keine TX referenziert
GET    /api/tags                         ← alle Tags des Users (distinct, sortiert)
PUT    /api/tags/{name}                  ← umbenennen in allen Transaktionen
DELETE /api/tags/{name}                  ← aus allen Transaktionen entfernen
POST   /api/import/csv                   ← max. 5 MB, UTF-8 oder CP1252
GET    /api/export/csv
```
→ Interaktive Doku unter `/api/docs` (FastAPI Swagger).

## Datenbankschema (MariaDB)
```sql
-- categories
id INT PK AUTO_INCREMENT
username VARCHAR(150) INDEX
name VARCHAR(100)
icon VARCHAR(8)              -- Emoji (mb4)
color CHAR(7)                -- #RRGGBB
UNIQUE (username, name)

-- transactions
id INT PK AUTO_INCREMENT
username VARCHAR(150)        -- composite-index mit date
amount DECIMAL(12,2)
description VARCHAR(255)     -- im JSON heißt das Feld "desc" (Pydantic-Alias)
category_id INT FK -> categories.id (ON DELETE RESTRICT)
date DATE
type ENUM('in','out')
tags JSON                    -- Array von Strings
```
Jeder User bekommt beim ersten `GET /api/categories` Default-Kategorien
(siehe `crud.ensure_default_categories`).

## Auth-Konzept
- Authentik schützt die gesamte Domain per Forward Auth über SWAG (Standard-Redirect-Flow, MFA von Authentik abgewickelt)
- Nach erfolgreicher Session setzt Authentik den Header `X-Authentik-Username`
- SWAG injiziert zusätzlich einen statischen Header `X-Auth-Secret: <token>` in jeden Backend-Request (`swag/pocketlog.subdomain.conf`)
- FastAPI prüft in `get_current_user()` (`backend/app/main.py`):
  1. Wenn `AUTH_SECRET`-ENV gesetzt: `X-Auth-Secret` muss matchen (timing-safe via `hmac.compare_digest`), sonst 401
  2. `X-Authentik-Username` muss vorhanden sein, sonst 401
- `AUTH_SECRET`-ENV leer/ungesetzt: Backend warnt beim Start und überspringt den Check (Port 8000 darf dann nur intern erreichbar sein)
- Lokales Testen ohne Authentik/SWAG: beide Header manuell mitschicken, z.B. `curl -H "X-Authentik-Username: test" -H "X-Auth-Secret: <token>" http://localhost:8080/api/health`
- Alle DB-Queries filtern nach `username` – Multi-User-fähig ohne extra Login-Code

## Frontend API-Aufruf
```js
// Default same-origin; per Settings auf andere Domain umstellbar
const API_BASE_KEY = 'pocketlog.apiBase';
let API = (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '');
API = API ? API + '/api' : '/api';
const data = await api('GET', '/transactions?year=2026&month=5');
```

## Offline / PWA
- `frontend/sw.js`: precached App-Shell, network-first für GET /api/*, Offline-Outbox für POST/PUT/DELETE.
- `frontend/db.js`: IndexedDB-Wrapper für die Outbox (`enqueue`, `drain`, `count`).
- Sync-Button im UI (`syncNow()`) triggert manuell den Outbox-Flush; bei wieder hergestellter Verbindung läuft Background-Sync.

## Deployment

Template `unraid/pocketlog.xml` in Unraid importieren oder ENV-Variablen in der
"Add Container"-GUI manuell setzen. Image kommt aus
`ghcr.io/anym001/pocketlog:latest` (oder lokal selbst gebaut). Anschließend
`swag/pocketlog.subdomain.conf` nach `/swag/config/nginx/proxy-confs/` legen.
Vor dem ersten SWAG-Reload: in der Config den Platzhalter beim
`proxy_set_header X-Auth-Secret` durch ein langes zufälliges Token ersetzen
(`openssl rand -hex 32`) und denselben Wert als `AUTH_SECRET`-ENV im PocketLog-
Container setzen. In Authentik einen Forward-Auth-Provider + Application für
`pocketlog.<domain>` anlegen und dem Outpost zuweisen (MFA kann normal über die
Authentik-Flow-Policy konfiguriert werden).

## Design-Prinzipien (Frontend)
- Mobile-first, max-width 430px, safe-area-inset für iPhone
- CSS-Variablen für alle Farben – automatischer Light/Dark Mode
- `--accent: #d96434` (Light) / `#ef8a5a` (Dark) – Ausgaben
- `--green: #2f8d5e` (Light) / `#5cc28d` (Dark) – Einnahmen
- `fmtCurrency(n)` für alle Beträge (de-DE Locale)
- Datum intern: ISO 8601 (YYYY-MM-DD)
- NIEMALS Inter/Roboto/Arial – DM Serif Display + DM Sans

## Sprach-Konventionen

- **Code, Kommentare, Workflow-YAML, Skripte:** Englisch
- **Dokumentation (CLAUDE.md, TODO.md, README.md, unraid/pocketlog.xml):** Deutsch

## Konventionen Backend
- CRUD-Funktionen immer mit `username` Parameter (Datenisolation)
- Neue Endpoints: `main.py` + Schema in `schemas.py` + Logik in `crud.py`
- Pydantic v2 Syntax: `model_config = ConfigDict(from_attributes=True, populate_by_name=True)`
- Schemaänderungen: Alembic-Revision generieren, nicht manuell ALTER TABLE
- StaticFiles-Mount IMMER zuletzt registrieren, damit `/api/*` vorher matcht

## Bekannte Einschränkungen / TODO (Backlog)

Siehe [`TODO.md`](TODO.md) für offene Punkte (Features, PWA-Limits, Security).
