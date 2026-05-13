# PocketLog – Haushaltsbuch PWA – Claude Code Projektkontext

## Architektur-Übersicht
```
iPhone/iPad/Mac (PWA)
        ↓ HTTPS
     SWAG Proxy          ← pocketlog.deinedomain.de
        ↓
     Authentik           ← Forward Auth, setzt X-Authentik-Username Header
        ↓
  ┌─────────────────────────────────────┐
  │  nginx (frontend-Container)         │  /          → index.html, sw.js, manifest
  │  FastAPI (backend-Container) :8000  │  /api/*     → Python API
  └──────────────────┬──────────────────┘
                     ↓
               MariaDB 11 :3306
               DB: pocketlog    User: pocketlog
```

## Projektstruktur
```
PocketLog/
├── docker-compose.yml                ← 3 Services: mariadb, backend, frontend
├── .env / .env.example               ← DB-Credentials, PROXY_NETWORK, TZ, DEV_FAKE_USER
├── swag/
│   └── pocketlog.subdomain.conf      ← SWAG nginx Config mit Authentik Forward Auth
├── frontend/
│   ├── Dockerfile                    ← nginx:alpine + Static
│   ├── nginx.conf                    ← /api → backend:8000, sonst static
│   ├── index.html                    ← PWA (HTML+CSS+JS)
│   ├── manifest.webmanifest
│   ├── sw.js                         ← Service Worker (Cache + Outbox)
│   ├── db.js                         ← IndexedDB-Helper für Outbox
│   └── icons/                        ← 192/512/maskable + apple-touch-icon
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── migrations/
│   └── app/
│       ├── main.py                   ← FastAPI Endpoints, get_current_user
│       ├── models.py                 ← SQLAlchemy ORM
│       ├── schemas.py                ← Pydantic v2
│       ├── crud.py                   ← username-skopierte Queries
│       └── database.py               ← MariaDB Engine
├── data/
│   └── mariadb/                      ← Volume für MariaDB-Datenfiles
└── CLAUDE.md
```

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS, eine Datei (`frontend/index.html`) + Service Worker
- **Backend:** FastAPI (Python 3.12), uvicorn auf Port 8000
- **Datenbank:** MariaDB 11 (InnoDB, utf8mb4)
- **Auth:** Authentik Forward Auth via SWAG – kein Login in der App
- **Fonts:** DM Serif Display + DM Sans
- **Charts:** Chart.js 4.4.1 (CDN, im SW gecached)
- **Migrationen:** Alembic, läuft im Entrypoint des Backend-Containers

## API Endpoints (FastAPI)
```
GET    /api/health
GET    /api/transactions?year=&month=    ← month optional → ganzes Jahr
POST   /api/transactions
PUT    /api/transactions/{id}
DELETE /api/transactions/{id}
GET    /api/categories                   ← legt beim 1. Aufruf Default-Kategorien an
POST   /api/categories
DELETE /api/categories/{id}              ← nur wenn keine TX referenziert
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
description VARCHAR(255)
category_id INT FK -> categories.id (ON DELETE RESTRICT)
date DATE
type ENUM('in','out')
tags JSON                    -- Array von Strings
```
Jeder User bekommt beim ersten `GET /api/categories` Default-Kategorien (siehe `crud.ensure_default_categories`).

## Auth-Konzept
- Authentik schützt die gesamte Domain per Forward Auth
- Nach Login setzt Authentik den Header `X-Authentik-Username`
- FastAPI liest den Header in `get_current_user()` (`backend/app/main.py`)
- Lokales Dev ohne Authentik: ENV `DEV_FAKE_USER=test` setzen → wird als Username genommen
- Alle DB-Queries filtern nach `username` – Multi-User-fähig ohne extra Login-Code

## Frontend API-Aufruf
```js
const API = '/api';   // relativer Pfad, frontend-nginx proxypasst /api → backend:8000
const data = await api('GET', '/transactions?year=2026&month=5');
```

## Offline / PWA
- `frontend/sw.js`: precached App-Shell, network-first für GET /api/*, Offline-Outbox für POST/PUT/DELETE.
- `frontend/db.js`: IndexedDB-Wrapper für die Outbox (`enqueue`, `drain`).
- Sync-Button im UI (`syncNow()`) triggert manuell den Outbox-Flush, sonst läuft Background-Sync.

## Deployment (Erststart)
```bash
cp .env.example .env
# .env ausfüllen (DB_PASSWORD, DB_ROOT_PASSWORD, PROXY_NETWORK)

docker compose up -d --build
# Backend-Container ruft im Entrypoint `alembic upgrade head` auf

cp swag/pocketlog.subdomain.conf /pfad/zu/swag/config/nginx/proxy-confs/
docker restart swag
# In Authentik: Forward-Auth-Provider + Application für pocketlog.<domain> anlegen
```

## Design-Prinzipien (Frontend)
- Mobile-first, max-width 430px, safe-area-inset für iPhone
- CSS-Variablen für alle Farben – automatischer Light/Dark Mode
- `--accent: #c8623a` (Ausgaben), `--green: #3a7d5c` (Einnahmen)
- `fmtCurrency(n)` für alle Beträge (de-DE Locale)
- Datum intern: ISO 8601 (YYYY-MM-DD)
- NIEMALS Inter/Roboto/Arial – DM Serif Display + DM Sans

## Konventionen Backend
- CRUD-Funktionen immer mit `username` Parameter (Datenisolation)
- Neue Endpoints: `main.py` + Schema in `schemas.py` + Logik in `crud.py`
- Pydantic v2 Syntax: `model_config = {"from_attributes": True}`
- Schemaänderungen: Alembic-Revision generieren, nicht manuell ALTER TABLE

## Bekannte Einschränkungen / TODO (Backlog)
- Icons sind Platzhalter, müssen durch echte App-Icons ersetzt werden
- Swipe-to-Delete als zusätzliche UX (aktuell nur Modal-Button)
- Wiederkehrende Buchungen, Budget-Grenzen pro Kategorie
- Push-Benachrichtigungen bei Budget-Überschreitung
- Backup-Job: nächtlicher `mariadb-dump` via Unraid-User-Script
