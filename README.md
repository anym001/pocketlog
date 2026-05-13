# PocketLog

Haushaltsbuch als Progressive Web App. Läuft auf iPhone / iPad / Mac, speichert
Daten in einer MariaDB auf dem eigenen (Unraid-)Server und nutzt Authentik per
Forward Auth über SWAG für die Anmeldung — die App selbst hat keinen Login.

## Setup

```bash
# 1. Konfiguration
cp .env.example .env
nano .env          # DB_PASSWORD, DB_ROOT_PASSWORD und PROXY_NETWORK setzen

# 2. Stack starten
docker compose up -d --build
# Beim ersten Start läuft alembic upgrade head im backend-Entrypoint automatisch

# 3. SWAG-Config einspielen
cp swag/pocketlog.subdomain.conf /pfad/zu/swag/config/nginx/proxy-confs/
docker restart swag

# 4. In Authentik
#    - Provider "Proxy Provider" / Forward Auth (single application)
#    - Application für pocketlog.<deinedomain> verknüpfen
#    - Outpost auf die Application zuweisen
```

## Lokales Dev ohne Authentik

```bash
echo "DEV_FAKE_USER=test" >> .env
docker compose up -d --build
curl http://localhost:8080/api/health
```

Solange `DEV_FAKE_USER` gesetzt ist, ersetzt FastAPI den fehlenden
`X-Authentik-Username`-Header durch diesen Wert.

## Optional: bereits laufende MariaDB wiederverwenden

Wer schon einen MariaDB-Container auf Unraid betreibt, kann diesen mitnutzen:

```bash
# in .env
DB_HOST=<container-name oder host-ip>
DB_PORT=3306
DB_USER=pocketlog
DB_PASSWORD=...
DB_NAME=pocketlog

# Stack ohne den internen mariadb-Service starten:
docker compose --profile no-internal-db up -d --build
```

Datenbank und User in der externen MariaDB vorab anlegen:
```sql
CREATE DATABASE pocketlog CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pocketlog'@'%' IDENTIFIED BY '...';
GRANT ALL ON pocketlog.* TO 'pocketlog'@'%';
FLUSH PRIVILEGES;
```

## API testen

- Swagger UI: `https://pocketlog.<deinedomain>/api/docs`
- Health: `https://pocketlog.<deinedomain>/api/health`

## Mit Claude Code weiterentwickeln

```bash
npm install -g @anthropic-ai/claude-code     # einmalig
cd PocketLog
claude
```

Beispiel-Prompts:
```
"Füge wiederkehrende Buchungen hinzu – monatlich und wöchentlich"
"Baue eine Budget-Grenze pro Kategorie inkl. Warnung im UI"
"Implementiere Swipe-to-Delete für Buchungen"
"Schreibe einen nightly mariadb-dump als Unraid-User-Script"
```
