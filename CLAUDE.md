# Haushaltsbuch v2 – Claude Code Projektkontext

## Architektur-Übersicht
```
iPhone/iPad/Mac (PWA)
        ↓ HTTPS
     SWAG Proxy          ← haushaltsbuch.deinedomain.de
        ↓
     Authentik           ← Forward Auth, setzt X-Authentik-Username Header
        ↓
  ┌─────────────────────────────────────┐
  │  nginx (frontend-Container)         │  /          → index.html
  │  FastAPI (backend-Container) :8000  │  /api/*     → Python API
  └──────────────────┬──────────────────┘
                     ↓
               PostgreSQL :5432
               DB: haushaltsbuch
```

## Projektstruktur
```
haushaltsbuch-v2/
├── docker-compose.yml          ← 3 Services: postgres, backend, frontend
├── .env                        ← DB_PASSWORD, AUTHENTIK_URL, PROXY_NETWORK
├── .env.example                ← Vorlage
├── haushaltsbuch.subdomain.conf ← SWAG nginx Config
├── frontend/
│   └── index.html              ← Gesamte PWA (HTML+CSS+JS)
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py             ← FastAPI Endpoints
│       ├── models.py           ← SQLAlchemy ORM Models
│       ├── schemas.py          ← Pydantic Schemas
│       ├── crud.py             ← Datenbankoperationen
│       └── database.py         ← DB-Verbindung
└── CLAUDE.md                   ← Diese Datei
```

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS, eine Datei (frontend/index.html)
- **Backend:** FastAPI (Python 3.12), läuft auf Port 8000
- **Datenbank:** PostgreSQL 16, eigene Instanz im Stack
- **Auth:** Authentik Forward Auth via SWAG – kein Login in der App
- **Fonts:** DM Serif Display + DM Sans
- **Charts:** Chart.js 4.4.1 (CDN)

## API Endpoints (FastAPI)
```
GET    /api/health
GET    /api/transactions?year=&month=   ← monatlich oder jahresweise
POST   /api/transactions
PUT    /api/transactions/{id}
DELETE /api/transactions/{id}
GET    /api/categories
POST   /api/categories
DELETE /api/categories/{id}
GET    /api/export/csv
```
→ Interaktive Doku: https://haushaltsbuch.deinedomain.de/api/docs

## Datenbankschema (PostgreSQL)
```sql
-- categories
id, username, name, icon, color

-- transactions
id, username, amount, desc, category_id (FK), date, type ('out'|'in'), tags (ARRAY)
```
Jeder User bekommt beim ersten Aufruf Default-Kategorien angelegt (CRUD: ensure_default_categories).

## Auth-Konzept
- Authentik schützt die gesamte Domain per Forward Auth
- Nach Login setzt Authentik den Header `X-Authentik-Username`
- FastAPI liest diesen Header in `get_current_user()` (main.py)
- Alle DB-Queries filtern nach `username` – Multi-User-fähig ohne extra Aufwand

## Frontend API-Aufruf
```js
const API = '/api';  // relativer Pfad, SWAG routet intern
const data = await api('GET', '/transactions?year=2025&month=6');
```

## Deployment (Erststart)
```bash
cp .env.example .env
# .env ausfüllen (DB_PASSWORD, AUTHENTIK_URL, PROXY_NETWORK)

docker compose up -d
# Tabellen werden automatisch erstellt (SQLAlchemy create_all)

# SWAG Config kopieren:
cp haushaltsbuch.subdomain.conf /path/to/swag/config/nginx/proxy-confs/
docker restart swag
```

## Design-Prinzipien (Frontend)
- Mobile-first, max-width 430px, safe-area-inset für iPhone
- CSS-Variablen für alle Farben – automatischer Light/Dark Mode
- --accent: #c8623a (Ausgaben), --green: #3a7d5c (Einnahmen)
- fmtCurrency(n) für alle Beträge (de-DE Locale)
- Datum intern: ISO 8601 (YYYY-MM-DD)
- NIEMALS Inter/Roboto/Arial – DM Serif Display + DM Sans

## Konventionen Backend
- CRUD-Funktionen immer mit `username` Parameter (Datenisolation)
- Neue Endpoints: in main.py hinzufügen, Schema in schemas.py, Logik in crud.py
- Pydantic v2 Syntax: `model_config = {"from_attributes": True}`

## Bekannte Einschränkungen / TODO
- Kein Service Worker (Offline-Support fehlt noch)
- Kein PWA-Manifest (manifest.json)
- Buchungen löschen noch nicht per UI möglich (API-Endpoint existiert)
- Keine Datenbankmigrationen (Alembic) – bei Schemaänderungen manuell

## Nächste Features (Backlog)
- [ ] Service Worker + manifest.json
- [ ] Buchungen löschen (Swipe-Geste)
- [ ] Wiederkehrende Buchungen
- [ ] Budget-Grenzen pro Kategorie
- [ ] Alembic für Datenbankmigrationen
