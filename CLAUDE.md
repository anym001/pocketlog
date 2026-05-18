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

Ein Container, zwei Rollen: PWA (StaticFiles) + JSON-API. MariaDB ist extern (Unraid).

## Projektstruktur
```
PocketLog/
├── unraid/
│   └── pocketlog.xml                 ← Community-Apps-Template für die Unraid-GUI
├── swag/
│   └── pocketlog.subdomain.conf      ← SWAG-Snippet, proxy_pass → pocketlog:8000
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

Im fertigen Image landen die PWA-Files unter `/app/static`. FastAPI mountet
diesen Ordner via `StaticFiles(html=True)` auf `/`, nachdem alle `/api/*`
Routes registriert sind.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS, aufgeteilt in `frontend/index.html` (Shell + Markup), `frontend/styles.css` (Styles) und `frontend/app.js` (Logik) + Service Worker. Nur das Theme-Bootstrap-Snippet bleibt inline in `index.html`, damit es vor dem ersten Paint läuft.
- **Backend:** FastAPI (Python 3.12), uvicorn auf Port 8000
- **Datenbank:** MariaDB 11 (extern, InnoDB, utf8mb4)
- **Auth:** Authentik Forward Auth (Standard-Flow inkl. MFA) + Shared-Secret-Header zwischen SWAG und Backend
- **Fonts:** DM Serif Display + DM Sans (selbst gehostet in `frontend/fonts/`, kein Google-Fonts-CDN)
- **Charts:** Chart.js 4.4.1 (selbst gehostet in `frontend/vendor/`, im SW gecached)
- **Kategorie-Icons:** Phosphor Regular (MIT) als Sprite-File in `frontend/icons/categories/sprite.svg`; ID-basiert in `categories.icon` gespeichert, beim Boot ins DOM injiziert
- **Migrationen:** Alembic, läuft im Container-Entrypoint vor uvicorn

## Drittanbieter & Privacy

Alle Assets (Fonts, JS, Icons) kommen vom eigenen Origin — keine CDNs, kein Tracking.

**Vor jedem neuen Asset prüfen**, ob es sich lokal versionieren lässt:

- JS-Lib → `frontend/vendor/<name>.js` (Tarball von npm-Registry, Shasum gegen
  Registry-Eintrag verifizieren, MIT/Apache/BSD-Lizenz bestätigen, Banner
  erhalten).
- Font → `frontend/fonts/<name>.woff2`. Subset wenn möglich (latin + latin-ext
  reichen für PocketLog), keine variable-axis-Files die wir nicht brauchen.
- Chrome-Icon (Menu, Chevron, etc.) → SVG ins Inline-Sprite in `frontend/index.html` (`<symbol id="icon-…">`).
- Kategorie-Icon → `<symbol id="cat-…">` ins externe Sprite `frontend/icons/categories/sprite.svg`
  einfügen, dann zur Catalogue-Konstante `CAT_ICON_GROUPS` in `frontend/app.js` hinzufügen.
  Quelle ist Phosphor Regular (`github.com/phosphor-icons/core/assets/regular/`, MIT) — niemals
  Icons aus anderen Sets mischen, sonst bricht der einheitliche Strichcharakter.

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

## Offline / PWA
- `frontend/sw.js`: precached App-Shell, network-first für die HTML-Shell (`/`, `/index.html`, `/styles.css`, `/app.js`, `/db.js`, `/manifest.webmanifest`) und für GET /api/*, cache-first für Icons, Fonts und das Chart.js-Vendor-Bundle; Offline-Outbox für POST/PUT/DELETE. Cache-Keys werden aus `__APP_VERSION__` gebildet — das Dockerfile substituiert beim Build die echte Release-Version, sodass jede Release neue Caches anlegt und der activate-Hook alte automatisch räumt.
- `frontend/db.js`: IndexedDB-Wrapper für die Outbox (`enqueue`, `drain`, `count`).
- Sync-Button im UI (`syncNow()`) triggert manuell den Outbox-Flush; bei wieder hergestellter Verbindung läuft Background-Sync.

## Deployment

→ [`docs/SETUP.md`](docs/SETUP.md)

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
  ohne via `fmtCurrency(n)` — beide stehen in `frontend/app.js`.

Wenn unklar ist, ob ein passendes Token existiert: erst in `:root` von
`frontend/styles.css` und in `DESIGN_CONVENTIONS.md` schauen, bevor neue
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

**Pflege:** Wenn sich Konventionen in `CLAUDE.md` oder `DESIGN_CONVENTIONS.md` ändern, prüfen ob die betroffenen Agents in `.claude/agents/` ebenfalls aktualisiert werden müssen. Faustregel: neue Tokens → `token-audit.md` + `ui-review.md`; neues Schema-Muster → `db-review.md`; neue Vendor-Policy → `vendor-audit.md`; neue UI-Terminologie → `copy-review.md`.

## Bekannte Einschränkungen / TODO (Backlog)

Siehe [`TODO.md`](TODO.md) für offene Punkte (Features, PWA-Limits, Security).
