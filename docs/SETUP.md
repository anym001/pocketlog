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
  1. `X-Auth-Secret` muss zu `AUTH_SECRET` matchen (timing-safe via
     `hmac.compare_digest`), sonst 401
  2. `X-Authentik-Username` muss dem Allowlist-Regex entsprechen
     (`[A-Za-z0-9._@+-]{1,150}`), sonst 401
  3. Lookup oder Lazy-Insert in `users`; gibt das `User`-ORM-Objekt zurück
- **`AUTH_SECRET` ist Pflicht** – ohne den Wert verweigert der Container den
  Start (`SystemExit`). Nur für lokale Dev-Setups, in denen Port 8000
  garantiert nicht öffentlich erreichbar ist, kann `ALLOW_NO_AUTH_SECRET=1`
  gesetzt werden; der Backend warnt dann beim Start und überspringt den Check
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
// Hardcoded same-origin. PWA und Backend sitzen hinter demselben SWAG-vhost;
// CSP `connect-src 'self'` würde Cross-Origin ohnehin blockieren.
const API = '/api';
const data = await api('GET', '/transactions?year=2026&month=5');
```

## Entwicklung & Tests mit SQLite

Für lokale Entwicklung und die pytest-Suite kann PocketLog gegen ein
SQLite-File-Backend laufen — keine MariaDB nötig.

> **Nicht für Produktion.** SQLite ist single-writer und für die
> Multi-User-Concurrency-Anforderungen von PocketLog nicht geeignet.
> Produktions-Setups bleiben bei MariaDB.

Wenn die Env-Variable `DATABASE_URL` gesetzt ist, hat sie Vorrang vor
den `DB_*`-Variablen. Beispiel:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt    # production + pytest/httpx

# Migrationen gegen frische SQLite-DB laufen lassen
DATABASE_URL="sqlite:///./pocketlog-dev.db" .venv/bin/alembic upgrade head

# Dev-Server starten — entweder ein Dev-Secret setzen oder den Check
# explizit deaktivieren (nur, wenn Port 8000 garantiert nicht öffentlich ist).
DATABASE_URL="sqlite:///./pocketlog-dev.db" \
  ALLOW_NO_AUTH_SECRET=1 \
  .venv/bin/uvicorn app.main:app --reload --port 8000
```

### Tests laufen lassen

```bash
cd backend
.venv/bin/pytest                  # alle Smoke-Tests
.venv/bin/pytest -x -v            # erster Fehler stoppt, mit Detail
```

Die Suite nutzt eine eigene SQLite-DB (`backend/test-pocketlog.db`,
automatisch erstellt und nach dem Run entfernt). Jeder Test bekommt
einen einzigartigen `X-Authentik-Username`, damit Daten zwischen Tests
isoliert bleiben.

### Migrations-Hinweis für künftige Revisionen

Neue Alembic-Revisionen müssen auf beiden Dialekten laufen — die CI/Dev-
Welt nutzt SQLite, die Produktion MariaDB. Konkrete Stolpersteine:

- `UPDATE ... JOIN` und andere MariaDB-Erweiterungen über
  `op.get_bind().dialect.name == "sqlite"`-Zweig nach SQLite-Subqueries
  umsetzen (siehe `0002_user_id_fk.py`).
- `REGEXP`, `CHAR_LENGTH` und ähnliche Funktionen sind MariaDB-only;
  SQLite-Pfad nutzt Python-Loop bzw. `LENGTH` (siehe
  `0005_category_icon_ids.py`).
- Schema-Mutationen wie `drop_constraint`, `alter_column`, `drop_column`
  IMMER in einen `with op.batch_alter_table(...) as batch:`-Block packen.
  Auf SQLite ist das Pflicht; auf MariaDB ist es ein transparenter
  Wrapper, der direkt ALTER TABLE emittiert.
