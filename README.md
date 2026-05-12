# Haushaltsbuch v2

PWA + FastAPI + PostgreSQL, geschützt durch SWAG + Authentik.

## Setup

```bash
# 1. .env anlegen
cp .env.example .env
nano .env   # DB_PASSWORD, AUTHENTIK_URL, PROXY_NETWORK ausfüllen

# 2. Stack starten
docker compose up -d

# 3. SWAG Config einspielen
cp haushaltsbuch.subdomain.conf /pfad/zu/swag/config/nginx/proxy-confs/
docker restart swag

# 4. In Authentik: neue Application + Provider für haushaltsbuch.deinedomain.de anlegen
#    → Forward Auth / Proxy Provider
```

## Mit Claude Code weiterentwickeln

```bash
npm install -g @anthropic-ai/claude-code  # einmalig
cd haushaltsbuch-v2
claude
```

Beispiel-Prompts:
```
"Füge einen Swipe-to-delete für Buchungen hinzu"
"Implementiere Alembic für Datenbankmigrationen"
"Baue einen Service Worker für Offline-Support"
"Füge wiederkehrende Buchungen hinzu – monatlich und wöchentlich"
```

## API testen
```
https://haushaltsbuch.deinedomain.de/api/docs
```
