# PocketLog – Deployment & Setup

## Deployment (Unraid)

Template `unraid/pocketlog.xml` in Unraid importieren oder ENV-Variablen in der
„Add Container"-GUI manuell setzen. Image kommt aus
`ghcr.io/anym001/pocketlog:latest` (oder lokal selbst gebaut). Anschließend
`swag/pocketlog.subdomain.conf` nach `/swag/config/nginx/proxy-confs/` legen.

Vor dem ersten SWAG-Reload: in der Config den Platzhalter beim
`proxy_set_header X-Auth-Secret` durch ein langes zufälliges Token ersetzen
(`openssl rand -hex 32`) und denselben Wert als `AUTH_SECRET`-ENV im
PocketLog-Container setzen. In Authentik einen Forward-Auth-Provider +
Application für `pocketlog.<domain>` anlegen und dem Outpost zuweisen (MFA
kann normal über die Authentik-Flow-Policy konfiguriert werden).

## Auth-Konzept (Details)

- Authentik schützt die gesamte Domain per Forward Auth über SWAG
  (Standard-Redirect-Flow, MFA von Authentik abgewickelt)
- Nach erfolgreicher Session setzt Authentik den Header `X-Authentik-Username`
- SWAG injiziert zusätzlich einen statischen Header `X-Auth-Secret: <token>`
  in jeden Backend-Request (`swag/pocketlog.subdomain.conf`)
- FastAPI prüft in `get_current_user()` (`backend/app/main.py`):
  1. Wenn `AUTH_SECRET`-ENV gesetzt: `X-Auth-Secret` muss matchen
     (timing-safe via `hmac.compare_digest`), sonst 401
  2. `X-Authentik-Username` muss vorhanden sein, sonst 401
  3. Lookup oder Lazy-Insert in `users`; gibt das `User`-ORM-Objekt zurück
- `AUTH_SECRET`-ENV leer/ungesetzt: Backend warnt beim Start und überspringt
  den Check (Port 8000 darf dann nur intern erreichbar sein)
- Alle DB-Queries filtern nach `user_id` – Multi-User-fähig ohne extra Login-Code

## Lokales Testen (ohne Authentik/SWAG)

Beide Header manuell mitschicken:

```bash
curl -H "X-Authentik-Username: test" \
     -H "X-Auth-Secret: <token>" \
     http://localhost:8000/api/health
```

API-Aufruf-Muster im Frontend:

```js
// Default same-origin; per Settings auf andere Domain umstellbar
const API_BASE_KEY = 'pocketlog.apiBase';
let API = (localStorage.getItem(API_BASE_KEY) || '').trim().replace(/\/+$/, '');
API = API ? API + '/api' : '/api';
const data = await api('GET', '/transactions?year=2026&month=5');
```
