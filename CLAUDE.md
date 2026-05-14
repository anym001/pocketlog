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
- Farbpalette basiert auf [html-effectiveness](https://thariqs.github.io/html-effectiveness/) von Thariq Shihipar:
  - `--bg-canvas: #FAF9F5` (ivory) / dark: `#0f0e0c`
  - `--accent: #D97757` (clay) / dark: `#E8926E` – Ausgaben
  - `--green: #788C5D` (olive) / dark: `#9AB07A` – Einnahmen
  - `--text: #141413` (slate) / dark: `#F0EEE6`
  - `--text2: #3D3D3A` / dark: `#B0ADA6`
  - `--text3: #87867F` / dark: `#87867F`
- `fmtCurrency(n)` für alle Beträge (de-DE Locale)
- Datum intern: ISO 8601 (YYYY-MM-DD)
- NIEMALS Inter/Roboto/Arial – DM Serif Display + DM Sans

## Sprach-Konventionen

- **Code, Kommentare, Workflow-YAML, Skripte, Nginx-Configs (`swag/`):** Englisch
- **Dokumentation (CLAUDE.md, TODO.md, README.md, unraid/pocketlog.xml):** Deutsch

## Konventionen Backend
- CRUD-Funktionen immer mit `username` Parameter (Datenisolation)
- Neue Endpoints: `main.py` + Schema in `schemas.py` + Logik in `crud.py`
- `from_attributes=True` auf allen „Out"-Schemas, die via `model_validate()` aus einem ORM-Objekt gebaut werden
- `populate_by_name=True` nur wenn `Field(alias=…)` oder `Field(serialization_alias=…)` verwendet wird
- Schemaänderungen: Alembic-Revision generieren, nicht manuell ALTER TABLE
- StaticFiles-Mount IMMER zuletzt registrieren, damit `/api/*` vorher matcht

## Apple Style Guide – UI-Konventionen (Frontend)

Gilt für alle sichtbaren Texte in `frontend/index.html` (deutsche UI). Regeln basieren auf dem [Apple Style Guide](https://help.apple.com/pdf/applestyleguide/en_US/apple-style-guide.pdf) und den [Apple Human Interface Guidelines: Writing](https://developer.apple.com/design/human-interface-guidelines/writing).

### Groß-/Kleinschreibung

Apple unterscheidet strikt zwischen **Title Case** und **Sentence case**:

| UI-Element | Stil |
|---|---|
| Navigationstitel, Tab-Labels | Title Case |
| **Button-Labels (Aktionen)** | **Title Case** |
| Alert-Button-Labels | Title Case |
| Menüeinträge | Title Case |
| Alert-Titel (Überschrift) | Sentence case |
| Alert-Text (Nachricht) | Sentence case |
| Formular-Feldlabels | Sentence case |
| Platzhaltertexte | Sentence case |
| Hilfetexte / Hinweise | Sentence case |
| Fehlermeldungen | Sentence case |
| Checkbox- / Toggle-Labels | Sentence case |
| Abschnittsüberschriften (Listen) | Sentence case |

**Title Case Regel (Deutsch):** Alle bedeutungstragenden Wörter groß, Artikel/Präpositionen klein – außer am Satzanfang. Substantive in Deutsch ohnehin immer groß.

- **Abkürzungen** CSV, API, URL, WLAN immer in Großbuchstaben.
- Kein ALL-CAPS in UI-Labels (wirkt aggressiv, schlechte Lesbarkeit).
- **App-Name:** „PocketLog" – immer genau so, nie „Pocketlog" oder „pocket log".

### Aktions-Buttons
- Verb-first: „Speichern", „Löschen", „Importieren" – nicht „OK", „Ja", „Nein".
- „OK" (nicht „Ok" oder „Okay") nur für einfache Bestätigungen ohne Handlungsalternative.
- Destruktive Aktionen (Löschen) immer mit „Abbrechen"-Button ergänzt, destruktiver Button visuell abgesetzt (bereits: `border:1px solid var(--accent)`).
- „Abbrechen" beendet Dialog ohne Änderungen; „Schließen" nur wenn nichts geändert werden konnte.
- Buttons, die einen weiteren Dialog öffnen, enden mit Ellipse: „Importieren…" (Unicode `…`, nicht `...`).

### Ton & Formulierung
- **Direkt und spezifisch:** „Betrag muss größer als null sein." – nicht „Ungültige Eingabe."
- **Aktiv statt passiv:** „Buchung löschen" – nicht „Die Buchung wird gelöscht."
- **Kein „Bitte" / kein „Sorry":** Klingt hohl und umständlich. Stattdessen direkt formulieren.
- **Keine Vorwürfe:** Nicht „Du hast ein ungültiges Datum eingegeben." → „Das eingegebene Datum ist ungültig."
- **Zweite Person (du/Sie):** Nutzer direkt ansprechen – „Deine Buchungen", nicht „Die Buchungen".
- **Präsens bevorzugen:** „Tippe auf +, um eine Buchung hinzuzufügen." – nicht „Durch Tippen wird eine Buchung hinzugefügt."
- **Keine Füllphrasen:** „Um…" statt „Um…zu" kürzen. Adjektive/Adverbien weglassen wenn sie keinen Informationsgehalt haben.
- **Keine Ausrufezeichen:** Klingen bevormundend und unaufrichtig.
- Kontraktionen (Kurzformen) sparsam – erschwerern die Lokalisierung.

### Alerts & Fehlermeldungen
Struktur: **[Was ist passiert.] [Wie beheben.]**

- Gut: „Der Betrag ist ungültig. Bitte eine Zahl größer als null eingeben."
- Schlecht: „Fehler.", „Bitte alles ausfüllen."
- Alert-Titel: ein Satz oder Satzfragment, kein abschließender Punkt wenn Satzfragment.
- Alert-Text: vollständige Sätze, mit Punkt.
- Keine technischen Fehlercodes / Stack Traces in nutzer-sichtbaren Meldungen.
- Kurze Labels (Button-Text, einzelne Labels) **ohne** abschließenden Punkt.
- Mehrsätzige Hilfetexte und Beschreibungen enden **mit** Punkt.

### Terminologie (Deutsch)

| Verwenden | Nicht verwenden |
|---|---|
| Tippen | Klicken (Touch-Kontext) |
| Auswählen | Klicken (plattformneutral) |
| Wischen, Ziehen | Swipen, Draggen |
| Anmelden / Abmelden | Einloggen / Ausloggen / Login |
| App | Applikation, Anwendung |
| WLAN | WiFi, W-LAN |
| E-Mail | Email, eMail |
| Gerät | Device |
| Einstellungen | Settings, Optionen (als Menüpunkt) |
| Buchung | Transaktion (in der UI; im Code weiter `transaction`) |
| Leere-Zustand-Meldung | „Noch keine Buchungen. Tippe auf + um die erste hinzuzufügen." |

### Zahlen & Währung
- Alle Beträge via `fmtCurrency(n)` (de-DE Locale): `1.234,56 €`
- Währungssymbol **nach** der Zahl: `12,50 €` – nicht `€12,50`
- Negativbeträge: Minuszeichen U+2212 (`−`), kein ASCII-Bindestrich – `Intl.NumberFormat` erledigt dies korrekt.
- Einheiten mit Leerzeichen: `5 MB`, `100 %` – nicht `5MB`, `100%`
- Prozent: Leerzeichen vor `%` in Deutsch: `42 %`

### Datum & Zeit
- Anzeige: `DD.MM.YYYY` oder relative Begriffe „Heute", „Gestern" (bereits umgesetzt).
- Monatsnamen ausschreiben wenn Platz vorhanden; nur kürzen wenn nötig (Jan, Feb, …).
- Intern immer ISO 8601: `YYYY-MM-DD`.
- Niemals Datums- / Zahlenformate hardcoden – immer `Intl.DateTimeFormat` / `Intl.NumberFormat`.

### Satzzeichen & Typografie
- Anführungszeichen: `„Text"` (deutschen Standard, bereits umgesetzt für Buchungstitel).
- Ellipse: `…` (U+2026), niemals drei Punkte `...`.
- Gedankenstrich: `–` (En-Dash, U+2013) für Einschübe in Deutsch; kein `--`.
- Apostroph: `'` (U+2019), nicht ASCII `'`.
- Keine doppelten Leerzeichen, kein harter Zeilenumbruch in UI-Labels.

### Touch & Interaktion
- Mindest-Tippfläche: **44 × 44 pt** für alle interaktiven Elemente.
- Berührungsaktionen mit „tippen" beschreiben – nicht „klicken" oder „drücken".
- Swipe-Gesten explizit benennen wenn nötig: „Wische nach links zum Löschen".

### Barrierefreiheit (Accessibility)
- Alle Icon-only-Buttons **müssen** `aria-label` tragen (bereits umgesetzt: `aria-label="Buchung löschen"`).
- `aria-label` beschreibt den **Zweck**, nicht das Aussehen: „Buchung löschen" – nicht „Mülleimer-Symbol".
- Keine Richtungsangaben in UI-Text (`aria-label`): nicht „Button rechts oben" – Screenreader-Nutzer sehen kein Layout.
- `aria-live="polite"` für Statusänderungen (Sync, Laden).
- Farbe darf **nicht** das einzige Unterscheidungsmerkmal sein (Einnahmen/Ausgaben: `+`/`–`-Vorzeichen zusätzlich – bereits umgesetzt).
- Kein „Hier klicken" als Link-/Buttontext – beschreibenden Text verwenden: „CSV-Export herunterladen".

### Offline- & Sync-Zustand
Spezifisch statt generisch – Benutzer wissen, was gerade passiert:

| Zustand | Text |
|---|---|
| Aktiv | „Wird synchronisiert…" |
| Abgeschlossen | „Gespeichert" |
| Offline | „Offline – Änderungen werden gespeichert" |
| Fehler | „Synchronisation fehlgeschlagen – Verbindung prüfen" |
| Laden | „Buchungen werden geladen…" (nicht nur „Laden…") |

## Bekannte Einschränkungen / TODO (Backlog)

Siehe [`TODO.md`](TODO.md) für offene Punkte (Features, PWA-Limits, Security).
