# PocketLog

Haushaltsbuch als Progressive Web App (PWA) – läuft im Browser auf allen
gängigen Plattformen (iOS, Android, macOS, Windows, Linux) und lässt sich
als App auf dem Homescreen installieren.

Konzipiert für **privates Self-Hosting**: Daten liegen ausschließlich in
deiner eigenen MariaDB, die App läuft in deinem eigenen Container. Alle
Assets (Fonts, Icons, JS-Bibliotheken) werden vom eigenen Server
ausgeliefert – keine CDN-Aufrufe, keine externen Verbindungen, kein
Tracking, keine Telemetrie.

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Voraussetzungen](#voraussetzungen)
- [Schnellstart](#schnellstart)
- [Konfiguration](#konfiguration)
- [Reverse Proxy](#reverse-proxy)
- [Auth & Sessions](#auth--sessions)
- [Notfall-Recovery](#notfall-recovery)
- [Entwicklung](#entwicklung)
- [API](#api)
- [Image-Builds](#image-builds)

## Funktionsumfang

- **Transaktionen** – Einnahmen & Ausgaben mit Datum, Betrag, Kategorie und Tags
- **Kategorien** – frei definierbar (Name, Icon, Farbe); Standardset wird beim
  ersten Aufruf angelegt
- **Tags** – freie Schlagwörter pro Transaktion; zentral umbenennen oder löschen
- **Berichte & Charts** – Monats-/Jahresübersicht, Kategorien- und Tag-Auswertung,
  Trendansicht und Prognose (Chart.js, lokal eingebettet)
- **Suche** – Volltext, Kategorie- und Tag-Filter in der Transaktionsliste
- **CSV-Import / -Export** – UTF-8 oder CP1252, max. 5 MB; Export aller
  Transaktionen als Semikolon-CSV
- **Offline-Fähigkeit** – Service Worker cached die App-Shell; POST/PUT/DELETE
  landen in einer Outbox und werden beim nächsten Online-Sein nachgesendet
- **Themes** – Hell, Dunkel, System (wird aus den Einstellungen gespeichert)
- **Multi-User** – jede Identität hat eigene Daten; Admin legt weitere Benutzer an
- **Eigener Login** – Username/Passwort mit Admin-Rolle, Setup-Flow und
  Brute-Force-Schutz

## Voraussetzungen

- Docker (oder Podman)
- MariaDB 10.6+ (externe Instanz)

## Schnellstart

### 1. Datenbank anlegen

```sql
CREATE DATABASE pocketlog CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pocketlog'@'%' IDENTIFIED BY 'dein-passwort';
GRANT ALL ON pocketlog.* TO 'pocketlog'@'%';
FLUSH PRIVILEGES;
```

### 2. Container starten

```bash
docker run -d \
  --name pocketlog \
  -p 8000:8000 \
  -e DB_HOST=mariadb \
  -e DB_NAME=pocketlog \
  -e DB_USER=pocketlog \
  -e DB_PASSWORD=dein-passwort \
  -e TZ=Europe/Berlin \
  ghcr.io/anym001/pocketlog:latest
```

Der Container spielt beim Start automatisch alle Schema-Migrationen ein,
dann startet uvicorn.

### 3. Ersteinrichtung

Beim ersten Aufruf (`http://<host>:8000`) erscheint die Setup-View. Lege den
ersten Admin an (Username + Passwort, mindestens 12 Zeichen mit Groß-/Klein-
buchstaben, Zahl und Sonderzeichen). Weitere Benutzer legt der Admin danach
unter _Einstellungen → Benutzerverwaltung_ an.

**Migration aus einer älteren Installation:** Migration `0009_auth_local`
promoviert den ältesten User-Eintrag zum Admin und setzt für alle Bestandsuser
das `force_change_password`-Flag. Im Setup-View ist der Username vorausgefüllt
und read-only – er gibt nur sein Passwort ein. Weitere migrierte Benutzer
erhalten ihren Zugang, sobald der Admin per _Passwort zurücksetzen_ einen
Einstieg anlegt.

## Konfiguration

| Variable | Default | Bedeutung |
|---|---|---|
| `DB_HOST` | `mariadb` | Hostname oder IP der MariaDB |
| `DB_PORT` | `3306` | MariaDB-Port |
| `DB_NAME` | – | Datenbankname |
| `DB_USER` | – | Datenbankbenutzer |
| `DB_PASSWORD` | – | Datenbankpasswort |
| `DATABASE_URL` | – | Vollständige DB-URL; überschreibt `DB_*`-Variablen (z.B. `sqlite:///./dev.db` für lokale Entwicklung) |
| `TZ` | `UTC` | Zeitzone des Containers |
| `SESSION_COOKIE_SECURE` | `1` | `Secure`-Flag auf den Cookies. Nur für lokales HTTP-Testing auf `0` setzen. |
| `SESSION_LIFETIME_HOURS` | `24` | Sliding-Session ohne „Eingeloggt bleiben" |
| `SESSION_REMEMBER_DAYS` | `30` | Sliding-Session mit „Eingeloggt bleiben" |
| `SESSION_ABSOLUTE_DAYS` | `7` | Absolute Session-Obergrenze (normal) |
| `SESSION_REMEMBER_ABSOLUTE_DAYS` | `90` | Absolute Session-Obergrenze (Remember-Me) |
| `ENABLE_DOCS` | – | Auf `1` setzen, um Swagger UI unter `/api/docs` zu aktivieren |

## Reverse Proxy

PocketLog läuft als einzelner Container auf Port 8000 und bringt seinen eigenen
Login mit – kein vorgelagerter Identity-Provider nötig. Dahinter kann ein
beliebiger Reverse Proxy sitzen (nginx, Caddy, Traefik …). Nginx-Beispiel:

```nginx
server {
    listen 443 ssl;
    server_name pocketlog.example.com;

    location / {
        proxy_pass         http://localhost:8000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

## Auth & Sessions

PocketLog verwaltet Identitäten vollständig selbst:

- **Session-Cookie** (`pocketlog_session`, HttpOnly): opakes Token; die DB hält
  nur den SHA256-Hash. Sliding-Lifetime + absolute Obergrenze (Defaults:
  24h / 7d normal, 30d / 90d mit „Eingeloggt bleiben").
- **CSRF-Schutz** (Double-Submit): ein zweites Cookie `pocketlog_csrf`
  (non-HttpOnly) enthält den CSRF-Token; das Frontend schickt ihn bei jedem
  POST/PUT/DELETE als `X-CSRF-Token`-Header zurück. Bei eigenen API-Skripten
  ist dieser Header zwingend.
- **Brute-Force-Schutz**: Login zählt Fehlversuche pro User. Ab dem 5. Versuch
  greift ein exponentieller Backoff (1s → 2s → … → 60s Cap). Erfolgreicher
  Login resettet den Counter; Admins können ihn per _Passwort zurücksetzen_
  explizit clearen.
- **Passwort-Policy**: mindestens 12 Zeichen, alle vier Zeichenklassen (Groß,
  Klein, Zahl, Sonderzeichen).

## Notfall-Recovery

### Admin-Passwort vergessen

```bash
docker exec -it pocketlog python -m app.cli reset-admin-password
```

Setzt Passwort + Lockout zurück und markiert den Admin als „muss beim nächsten
Login wechseln". `--username U` adressiert einen bestimmten Account (nötig,
wenn mehrere Admins existieren).

## Entwicklung

Lokales Starten ohne MariaDB:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

DATABASE_URL="sqlite:///./pocketlog-dev.db" .venv/bin/alembic upgrade head

DATABASE_URL="sqlite:///./pocketlog-dev.db" \
  SESSION_COOKIE_SECURE=0 \
  .venv/bin/uvicorn app.main:app --reload --port 8000
```

Tests ausführen:

```bash
cd backend
.venv/bin/pytest           # alle Tests
.venv/bin/pytest -x -v     # erster Fehler stoppt, mit Detail
```

Die Suite nutzt eine eigene SQLite-DB (automatisch erstellt und nach dem Run
entfernt). Jeder Test bekommt einen einzigartigen Username, damit Daten
zwischen Tests isoliert bleiben.

### Neue Alembic-Migrationen

Migrationen müssen auf beiden Dialekten laufen (SQLite in Dev/CI, MariaDB in
Produktion):

- `UPDATE … JOIN` → MariaDB-only; SQLite-Pfad via `op.get_bind().dialect.name`
  (Beispiel: `0002_user_id_fk.py`)
- `REGEXP`, `CHAR_LENGTH` → MariaDB-only (Beispiel: `0005_category_icon_ids.py`)
- `drop_constraint`, `alter_column` → immer in
  `with op.batch_alter_table(...) as batch:` packen (SQLite-Pflicht); bei
  FK-abhängigen Eltern-Tabellen ggf. Dialekt-Pfad splitten
  (Beispiel: `0009_auth_local.py`)
- Revisions-ID ≤ 24 Zeichen (MariaDB `VARCHAR(32)`); ein pytest-Guard prüft
  das automatisch – nicht umgehen
- **DDL muss idempotent sein**: jedes `op.create_*` / `op.drop_*` mit
  `sa.inspect()` absichern, damit ein halb-gestarteter Container beim Neustart
  nicht crasht (Beispiel: `0007_tx_category_idx.py`)

## API

- Health: `GET /api/health`
- Version: `GET /api/version`
- Swagger UI: standardmäßig deaktiviert; mit `ENABLE_DOCS=1` starten

## Image-Builds

Der Workflow `.github/workflows/build.yml` baut bei jedem Push auf `main` ein
neues Image und pusht es nach `ghcr.io/anym001/pocketlog`. Die Patch-Version
wird automatisch hochgezählt und ein GitHub-Release erstellt. Tags:

- `:latest` – letzter Stand von `main`
- `:X.Y.Z` – versionierter Release (z.B. `v0.3.2`)

---

Entwickelt mit [Claude Code](https://claude.ai/code)
