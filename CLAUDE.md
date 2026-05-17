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
│   ├── icons/                        ← 192/512/maskable + apple-touch-icon
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
└── DESIGN_CONVENTIONS.md             ← Frontend-Design- und Schreibregeln
```

Im fertigen Image landen die PWA-Files unter `/app/static`. FastAPI mountet
diesen Ordner via `StaticFiles(html=True)` auf `/`, nachdem alle `/api/*`
Routes registriert sind.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS in einer Datei (`frontend/index.html`) + Service Worker
- **Backend:** FastAPI (Python 3.12), uvicorn auf Port 8000
- **Datenbank:** MariaDB 11 (extern, InnoDB, utf8mb4)
- **Auth:** Authentik Forward Auth (Standard-Flow inkl. MFA) + Shared-Secret-Header zwischen SWAG und Backend
- **Fonts:** DM Serif Display + DM Sans (selbst gehostet in `frontend/fonts/`, kein Google-Fonts-CDN)
- **Charts:** Chart.js 4.4.1 (selbst gehostet in `frontend/vendor/`, im SW gecached)
- **Migrationen:** Alembic, läuft im Container-Entrypoint vor uvicorn

## Drittanbieter & Privacy

PocketLog ist ein selbst gehostetes Haushaltsbuch — die Buchungen liegen
zwischen dem User, seiner Instanz und sonst niemandem. Damit das auch beim
Frontend-Laden gilt, ist die App bewusst **frei von externen Quellen**:

- Schriften, JS-Bibliotheken (Chart.js), Icons, CSS — alles vom eigenen Origin.
- Keine CDNs (Google Fonts, gstatic, cdnjs, jsdelivr, unpkg …).
- Keine Analytics, kein Tracking, keine externen Telemetrie-Endpoints.
- Keine externen iFrames / Embeds.

**Vor jedem neuen Asset prüfen**, ob es sich lokal versionieren lässt:

- JS-Lib → `frontend/vendor/<name>.js` (Tarball von npm-Registry, Shasum gegen
  Registry-Eintrag verifizieren, MIT/Apache/BSD-Lizenz bestätigen, Banner
  erhalten).
- Font → `frontend/fonts/<name>.woff2`. Subset wenn möglich (latin + latin-ext
  reichen für PocketLog), keine variable-axis-Files die wir nicht brauchen.
- Icon → SVG ins Sprite in `frontend/index.html` (`<symbol id="icon-…">`).

Falls eine Abhängigkeit beim besten Willen nur online verfügbar ist (z. B.
ein Auth-Provider-Login), das in einem Code-Kommentar **und** hier
dokumentieren, damit jeder spätere Reviewer den Trade-off nachvollziehen
kann.

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
→ Interaktive Doku unter `/api/docs` (FastAPI Swagger).

## Datenbankschema (MariaDB)
```sql
-- users
id INT PK AUTO_INCREMENT
username VARCHAR(150) UNIQUE   -- gespiegelter Authentik-Username

-- categories
id INT PK AUTO_INCREMENT
user_id INT FK -> users.id (ON DELETE CASCADE) INDEX
name VARCHAR(100)
icon VARCHAR(8)                -- Emoji (mb4)
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
- Authentik schützt die gesamte Domain per Forward Auth über SWAG (Standard-Redirect-Flow, MFA von Authentik abgewickelt)
- Nach erfolgreicher Session setzt Authentik den Header `X-Authentik-Username`
- SWAG injiziert zusätzlich einen statischen Header `X-Auth-Secret: <token>` in jeden Backend-Request (`swag/pocketlog.subdomain.conf`)
- FastAPI prüft in `get_current_user()` (`backend/app/main.py`):
  1. Wenn `AUTH_SECRET`-ENV gesetzt: `X-Auth-Secret` muss matchen (timing-safe via `hmac.compare_digest`), sonst 401
  2. `X-Authentik-Username` muss vorhanden sein, sonst 401
  3. Lookup oder Lazy-Insert in `users`; gibt das `User`-ORM-Objekt zurück
- `AUTH_SECRET`-ENV leer/ungesetzt: Backend warnt beim Start und überspringt den Check (Port 8000 darf dann nur intern erreichbar sein)
- Lokales Testen ohne Authentik/SWAG: beide Header manuell mitschicken, z.B. `curl -H "X-Authentik-Username: test" -H "X-Auth-Secret: <token>" http://localhost:8080/api/health`
- Alle DB-Queries filtern nach `user_id` – Multi-User-fähig ohne extra Login-Code

## Frontend API-Aufruf
```js
// Default same-origin; per Settings auf andere Domain umstellbar
const API_BASE_KEY = 'pocketlog.apiBase';
let API = (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '');
API = API ? API + '/api' : '/api';
const data = await api('GET', '/transactions?year=2026&month=5');
```

## Offline / PWA
- `frontend/sw.js`: precached App-Shell, network-first für die HTML-Shell (`/`, `/index.html`, `/db.js`, `/manifest.webmanifest`) und für GET /api/*, cache-first für Icons, Fonts und das Chart.js-Vendor-Bundle; Offline-Outbox für POST/PUT/DELETE. Cache-Keys werden aus `__APP_VERSION__` gebildet — das Dockerfile substituiert beim Build die echte Release-Version, sodass jede Release neue Caches anlegt und der activate-Hook alte automatisch räumt.
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

## Design Conventions (Frontend)

Alle Design- und UI-Konventionen (Layout, Farbe, Typografie, Materialien,
Liquid Glass, App-Icons, Toolbars, Suchfelder, Barrierefreiheit sowie der
komplette Apple Style Guide für UI-Texte) sind in
[`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md) ausgelagert. Vor jeder
Frontend-Änderung kurz nachschlagen.

Kurzfassung der harten Regeln:

- Mobile-first, max-width 430 px, `env(safe-area-inset-*)` für iPhone
- CSS-Variablen für alle Farben – automatischer Light/Dark Mode über
  `prefers-color-scheme`
- Schriften ausschließlich **DM Serif Display** + **DM Sans** – niemals
  Inter, Roboto, Arial, System-Stack
- Beträge via `fmtCurrency(n)` (de-DE), Datum intern ISO 8601
- Touch-Targets mindestens 44 × 44 px, WCAG-AA-Kontrast in beiden Modi
- App-Name immer „PocketLog"

## Konventionen Frontend

**Vor jeder CSS-/Markup-Änderung erst prüfen, ob es schon ein zentrales
Steuerelement gibt.** PocketLog ist absichtlich tokenisiert; ein
hardgecodeter Wert ist fast immer ein Bug, weil er sich nicht mit dem
Rest mitbewegt (Light/Dark, Theme-Wechsel, Größenanpassung). Es ist
schon mehrfach passiert, dass neue Code-Stellen Tokens dupliziert oder
ignoriert haben.

- **Farben:** ausschließlich über `var(--accent)`, `var(--green)`,
  `var(--red)` / `--red-2`, `var(--text)`, `var(--bg-canvas)` etc. Keine
  Hex-/RGBA-Literale neu einführen — alle Themes (Light + Dark) leben
  von den Tokens. Akzent-/Status-Schatten via
  `color-mix(in oklab, var(--accent) X%, transparent)`, nicht via
  hartcodierter rgba.
- **Typografie:** Größen nur aus der `--fs-*`-Skala (`--fs-display` …
  `--fs-micro`); Icon-Glyphen aus `--fs-icon-sm/md/lg/xl`.
- **Spacing:** ausschließlich `--space-*`-Token (2, 4, 8, 10, 12, 14,
  16, 20, 24 …); keine freien `px` für Margins/Paddings.
- **Radien, Schatten, Z-Layer, Motion-Dauern, Focus-Ring, Borders:** die
  jeweiligen Tokens (`--r-*`, `--shadow-*`, `--z-*`, `--dur-*`,
  `--focus-ring`, `--border-hairline*`).
- **Glyphen / Icons:** den vorhandenen Inline-SVG-Sprite verwenden
  (`#icon-menu`, `#icon-chevron-left/-right`, `#icon-close`,
  `#icon-search`, `#icon-plus`). Neue Glyphen als zusätzliches
  `<symbol>` ergänzen, nicht ad-hoc Unicode oder eigene SVG inline.
- **Wiederholungen:** sobald ein Inline-`style="…"` oder ein Style-Block
  ≥ 2× auftaucht → Klasse extrahieren (siehe `.btn-destructive`,
  `.radio-row`, `.ui-icon` als Beispiele) statt copy-pasten.
- **Format-Helfer:** Beträge mit Vorzeichen via `fmtSignedCurrency(n)`,
  ohne via `fmtCurrency(n)` — beide stehen in `frontend/index.html`.

Wenn unklar ist, ob ein passendes Token existiert: erst in `:root` von
`frontend/index.html` und in `DESIGN_CONVENTIONS.md` schauen, bevor neue
Werte eingeführt werden.

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

## Bekannte Einschränkungen / TODO (Backlog)

Siehe [`TODO.md`](TODO.md) für offene Punkte (Features, PWA-Limits, Security).
