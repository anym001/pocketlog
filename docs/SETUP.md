# PocketLog – Deployment & Setup

## Deployment (Unraid)

Template `unraid/pocketlog.xml` in Unraid importieren oder ENV-Variablen in der
„Add Container"-GUI manuell setzen. Image kommt aus
`ghcr.io/anym001/pocketlog:latest` (oder lokal selbst gebaut). Anschließend
`swag/pocketlog.subdomain.conf` nach `/swag/config/nginx/proxy-confs/` legen
und in Authentik einen Forward-Auth-Provider + Application für
`pocketlog.<domain>` anlegen (MFA über die übliche Authentik-Flow-Policy).

## Auth-Konzept (zwei Schichten)

PocketLog trennt Domain-Schutz und App-Identität sauber:

1. **Domain-Tor (Authentik via SWAG):** Der `authentik-location.conf`-Include
   in `swag/pocketlog.subdomain.conf` lässt nur Requests durch, die eine
   gültige Authentik-Session haben (Passwort + MFA gemäß Authentik-Flow).
   Identische Schicht für alle Apps am Proxy.
2. **App-Login (PocketLog):** Hinter dem Tor läuft die App mit eigenem
   Username/Passwort-Login. Eigene `users`-Tabelle, eigene Admin-Rolle,
   eigene Sessions (HttpOnly-Cookie + opakes Token, sha256-Hash in der DB).
   Kein Authentik-Header wird mehr ausgewertet.

### Erstanmeldung (Setup-Modus)

Beim allerersten Aufruf zeigt PocketLog automatisch die Setup-View:

- **Frische Installation:** Setup-Maske fragt Username + Passwort des
  ersten Admins (Mindestlänge 12 Zeichen). Direkt danach ist die App
  eingeloggt; weitere Benutzer legt der Admin über _Einstellungen →
  Benutzerverwaltung_ an.
- **Bestand aus Pre-App-Auth-Zeiten:** Migration `0009_auth_local`
  promoviert den ältesten User-Eintrag zum Admin und setzt für ihn (und
  alle anderen Bestandsuser) das `force_change_password`-Flag. Im
  Setup-View ist der Username vorausgefüllt und read-only — er gibt sich
  nur sein Passwort. Andere migrierte Benutzer können sich solange
  nicht anmelden, bis der Admin ihnen per _Passwort zurücksetzen_ einen
  Zugang anlegt; bei ihrem ersten Login landen sie im Force-Change-View.

### Notfall-Recovery: Admin-Passwort vergessen

Im Container:

```bash
docker exec -it pocketlog python -m app.cli reset-admin-password
```

Setzt für den einen Admin Passwort + Lockout zurück und markiert ihn als
„muss beim nächsten Login wechseln". Hilfsoption `--username` ist nötig,
falls (über die DB direkt) mehrere Admins existieren. `--password` füllt
das Passwort interaktiv ein, falls weggelassen.

## Brute-Force- & CSRF-Schutz (Kurzfassung)

- Login zählt Fehlversuche pro User. Ab dem 5. Versuch greift ein
  Backoff, das sich exponentiell bis maximal 60 Sekunden verdoppelt.
  Erfolgreicher Login resettet den Counter. Admins können den Counter
  über _Passwort zurücksetzen_ explizit clearen.
- Jede state-changing Anfrage (POST/PUT/DELETE) muss den
  `X-CSRF-Token`-Header mit dem Wert aus dem `pocketlog_csrf`-Cookie
  schicken (Double-Submit-Pattern). Das Frontend macht das automatisch;
  bei eigenen Skripten ist der Header zwingend.

## Session-Konfiguration (ENV, optional)

| Variable                          | Default | Bedeutung |
| --------------------------------- | ------- | --------- |
| `SESSION_COOKIE_SECURE`           | `1`     | `Secure`-Flag auf den Cookies. Nur für lokale HTTP-Tests auf `0` setzen. |
| `SESSION_LIFETIME_HOURS`          | `24`    | Sliding-Lifetime ohne „Eingeloggt bleiben". |
| `SESSION_REMEMBER_DAYS`           | `30`    | Sliding-Lifetime mit „Eingeloggt bleiben". |
| `SESSION_ABSOLUTE_DAYS`           | `7`     | Absolute Obergrenze ohne Remember-Me. |
| `SESSION_REMEMBER_ABSOLUTE_DAYS`  | `90`    | Absolute Obergrenze mit Remember-Me. |

## Lokales Testen (ohne Authentik/SWAG)

Da die App jetzt ihren eigenen Login mitbringt, läuft sie lokal auch
ganz ohne Reverse-Proxy:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

DATABASE_URL="sqlite:///./pocketlog-dev.db" .venv/bin/alembic upgrade head

DATABASE_URL="sqlite:///./pocketlog-dev.db" \
  SESSION_COOKIE_SECURE=0 \
  .venv/bin/uvicorn app.main:app --reload --port 8000
```

API-Aufrufe mit curl: zuerst Setup ausführen, dann Login, anschließend
mit `-c cookies.txt -b cookies.txt` plus `X-CSRF-Token`-Header arbeiten:

```bash
curl -c c.txt -b c.txt -X POST -H 'Content-Type: application/json' \
     -d '{"username":"alice","password":"valid-password-2026"}' \
     http://127.0.0.1:8000/api/auth/setup

CSRF=$(grep pocketlog_csrf c.txt | awk '{print $NF}')
curl -b c.txt -H "X-CSRF-Token: $CSRF" \
     -X POST -H 'Content-Type: application/json' \
     -d '{"name":"Test","icon":"house","color":"#123456"}' \
     http://127.0.0.1:8000/api/categories
```

API-Aufruf-Muster im Frontend:

```js
// Hardcoded same-origin. PWA und Backend sitzen hinter demselben
// SWAG-vhost; CSP `connect-src 'self'` würde Cross-Origin ohnehin
// blockieren. credentials: 'same-origin' im api()-Helper schickt das
// Session-Cookie automatisch mit; window._csrfToken wird beim Login
// gesetzt und als X-CSRF-Token-Header bei jedem non-GET hinzugefügt.
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
den `DB_*`-Variablen.

### Tests laufen lassen

```bash
cd backend
.venv/bin/pytest                  # alle Tests
.venv/bin/pytest -x -v            # erster Fehler stoppt, mit Detail
```

Die Suite nutzt eine eigene SQLite-DB (`backend/test-pocketlog.db`,
automatisch erstellt und nach dem Run entfernt). Jeder Test bekommt
einen einzigartigen Username, damit Daten zwischen Tests isoliert bleiben.

### Migrations-Hinweis für künftige Revisionen

Neue Alembic-Revisionen müssen auf beiden Dialekten laufen — die CI/Dev-
Welt nutzt SQLite, die Produktion MariaDB. Konkrete Stolpersteine:

- `UPDATE ... JOIN` und andere MariaDB-Erweiterungen über
  `op.get_bind().dialect.name == "sqlite"`-Zweig nach SQLite-Subqueries
  umsetzen (siehe `0002_user_id_fk.py`).
- `REGEXP`, `CHAR_LENGTH` und ähnliche Funktionen sind MariaDB-only;
  SQLite-Pfad nutzt Python-Loop bzw. `LENGTH` (siehe
  `0005_category_icon_ids.py`).
- Schema-Mutationen wie `drop_constraint`, `alter_column` IMMER in einen
  `with op.batch_alter_table(...) as batch:`-Block packen. Achtung: auf
  Eltern-Tabellen (z.B. `users`) blockt `batch_alter_table` auf SQLite,
  wenn Child-Tabellen FKs darauf halten — dann auf native `op.drop_column`
  ausweichen (SQLite ≥ 3.35) oder den Pfad pro Dialekt splitten
  (`bind.dialect.name`), siehe `0009_auth_local.py`.
- `ALTER TABLE ADD COLUMN ... DEFAULT CURRENT_TIMESTAMP` lehnt SQLite ab
  („non-constant default"). Pfad pro Dialekt aufteilen: auf MariaDB den
  Server-Default direkt setzen, auf SQLite die Spalte nullable hinzufügen
  und mit `UPDATE ... SET col = CURRENT_TIMESTAMP` backfillen.
