# PocketLog

Haushaltsbuch als Progressive Web App (PWA) – läuft auf iPhone, iPad, Mac und
Desktop-Browser. Daten liegen in deiner eigenen MariaDB; kein Cloud-Dienst,
kein Tracking.

## Funktionsumfang

- **Transaktionen** – Einnahmen & Ausgaben mit Datum, Betrag, Kategorie und Tags
- **Kategorien** – frei definierbar (Name, Icon, Farbe); Standardset wird beim
  ersten Aufruf angelegt
- **Tags** – freie Schlagwörter pro Transaktion; zentral umbenennen oder löschen
- **CSV-Import / -Export** – UTF-8 oder CP1252, max. 5 MB; Export aller
  Transaktionen als Semikolon-CSV
- **Offline-Fähigkeit** – Service Worker cached die App-Shell; POST/PUT/DELETE
  landen in einer Outbox und werden beim nächsten Online-Sein nachgesendet
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

## Konfiguration

| Variable | Default | Bedeutung |
|---|---|---|
| `DB_HOST` | – | Hostname oder IP der MariaDB |
| `DB_PORT` | `3306` | MariaDB-Port |
| `DB_NAME` | – | Datenbankname |
| `DB_USER` | – | Datenbankbenutzer |
| `DB_PASSWORD` | – | Datenbankpasswort |
| `TZ` | `UTC` | Zeitzone des Containers |
| `SESSION_COOKIE_SECURE` | `1` | Auf `0` setzen für lokales HTTP-Testing |
| `SESSION_LIFETIME_HOURS` | `24` | Sliding-Session ohne „Eingeloggt bleiben" |
| `SESSION_REMEMBER_DAYS` | `30` | Sliding-Session mit „Eingeloggt bleiben" |
| `SESSION_ABSOLUTE_DAYS` | `7` | Absolute Session-Obergrenze (normal) |
| `SESSION_REMEMBER_ABSOLUTE_DAYS` | `90` | Absolute Session-Obergrenze (Remember-Me) |
| `ENABLE_DOCS` | – | Auf `1` setzen, um Swagger UI unter `/api/docs` zu aktivieren |

## Reverse Proxy

PocketLog läuft als einzelner Container auf Port 8000 und bringt seinen eigenen
Login mit – kein vorgelagerter Identity-Provider nötig. Dahinter kann ein
beliebiger Reverse Proxy sitzen. Nginx-Beispiel:

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

## Entwicklung

Lokales Starten ohne MariaDB (SQLite reicht für Entwicklung):

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
.venv/bin/pytest
```

Weitere Details zu Auth-Konzept, Recovery-Kommandos und Migrations-Konventionen
in [`docs/SETUP.md`](docs/SETUP.md).

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

## Unraid & SWAG (optional)

Wer PocketLog auf **Unraid** hinter **SWAG** betreibt:

- **Unraid-Template:** `unraid/pocketlog.xml` nach
  `/boot/config/plugins/dockerMan/templates-user/` kopieren → in der Apps-GUI
  erscheint ein vorbelegtes Template mit allen ENV-Variablen.
- **SWAG-Proxy-Config:** `swag/pocketlog.subdomain.conf` nach
  `/config/nginx/proxy-confs/` legen, SWAG neu laden.
- Weitere optionale SWAG-Snippets (GeoIP-Block, LAN-Allowlist) liegen unter
  `swag/`.

PocketLog benötigt keinen vorgelagerten Identity-Provider. Authentik kann
optional als zusätzliche Schutzschicht vor dem Container gesetzt werden
(Forward Auth), ist aber nicht erforderlich.
