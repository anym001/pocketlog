# PocketLog – Deployment & Setup

## Deployment

PocketLog läuft als einzelner Docker-Container (FastAPI + statische PWA-Files).
Image: `ghcr.io/anym001/pocketlog:latest`

Minimales `docker run`-Beispiel (weitere ENV-Variablen siehe
[`README.md`](../README.md#konfiguration)):

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

Beim Start läuft automatisch `alembic upgrade head`, dann startet uvicorn auf
Port 8000.

## Auth-Konzept

PocketLog verwaltet Identitäten vollständig selbst:

- **Session-Cookie** (`pocketlog_session`, HttpOnly): opakes Token; die DB hält
  nur den SHA256-Hash. Sliding-Lifetime (Standard 24h) + absolute Obergrenze
  (Standard 7d). Mit „Eingeloggt bleiben": 30d / 90d.
- **CSRF-Schutz** (Double-Submit): ein zweites Cookie `pocketlog_csrf`
  (non-HttpOnly) enthält den CSRF-Token, den das Frontend bei jedem
  POST/PUT/DELETE als `X-CSRF-Token`-Header zurückschickt.
- **Passwort-Policy:** mindestens 12 Zeichen, alle vier Zeichenklassen
  (Groß, Klein, Zahl, Sonderzeichen).
- **Admin-Rolle:** genau ein Admin pro Installation; der Admin legt weitere
  Benutzer an und kann Passwörter zurücksetzen.

Ein vorgelagerter Identity-Provider (Authentik o.ä.) ist nicht erforderlich;
PocketLog kann optional hinter einem solchen betrieben werden, wertet aber
keine Proxy-Header aus.

## Erstanmeldung (Setup-Modus)

Beim allerersten Aufruf zeigt PocketLog automatisch die Setup-View:

- **Frische Installation:** Setup-Maske fragt Username + Passwort des ersten
  Admins. Direkt danach ist die App eingeloggt; weitere Benutzer legt der Admin
  über _Einstellungen → Benutzerverwaltung_ an.
- **Migration aus Pre-App-Auth-Zeiten:** Migration `0009_auth_local` promoviert
  den ältesten User-Eintrag zum Admin und setzt für alle Bestandsuser das
  `force_change_password`-Flag. Im Setup-View ist der Username vorausgefüllt
  und read-only – er gibt nur sein Passwort ein. Andere migrierte Benutzer
  können sich erst anmelden, nachdem der Admin ihnen per _Passwort zurücksetzen_
  einen Zugang anlegt; beim ersten Login landen sie im Force-Change-View.

## Notfall-Recovery

### Admin-Passwort vergessen

```bash
docker exec -it pocketlog python -m app.cli reset-admin-password
```

Setzt Passwort + Lockout des Admins zurück und markiert ihn als
„muss beim nächsten Login wechseln". Mit `--username U` adressiert man einen
bestimmten Account (nötig, wenn über die DB mehrere Admins angelegt wurden).
`--password` nimmt das neue Passwort entgegen; ohne den Parameter wird
interaktiv gefragt.

### Festhängender Force-Change-View

Wenn der Admin im Force-Change-View festhängt (Passwort gesetzt, Flag lässt
sich aus dem Browser nicht clearen – z.B. wegen gecachter SW-Response):

```bash
docker exec -it pocketlog python -m app.cli clear-force-change-password
```

Löscht nur das `force_change_password`-Flag, lässt Passwort und Session
unberührt. `--username U` für einen bestimmten Account. Der Browser-Tab muss
danach einmal neu geladen werden.

## Brute-Force- & CSRF-Schutz

- Login zählt Fehlversuche pro User. Ab dem 5. Versuch greift ein
  Backoff, der sich exponentiell bis maximal 60 Sekunden verdoppelt
  (5 → 1s, 6 → 2s, …, 11+ → 60s). Erfolgreicher Login resettet den Counter.
  Admins können ihn über _Passwort zurücksetzen_ explizit clearen.
- Alle state-ändernden Anfragen (POST/PUT/DELETE) müssen den
  `X-CSRF-Token`-Header mit dem Wert aus dem `pocketlog_csrf`-Cookie
  schicken (Double-Submit-Pattern). Das Frontend macht das automatisch;
  bei eigenen API-Skripten ist der Header zwingend.

## Session-Konfiguration (ENV, optional)

| Variable | Default | Bedeutung |
|---|---|---|
| `SESSION_COOKIE_SECURE` | `1` | `Secure`-Flag auf den Cookies. Nur für lokales HTTP-Testing auf `0` setzen. |
| `SESSION_LIFETIME_HOURS` | `24` | Sliding-Lifetime ohne „Eingeloggt bleiben". |
| `SESSION_REMEMBER_DAYS` | `30` | Sliding-Lifetime mit „Eingeloggt bleiben". |
| `SESSION_ABSOLUTE_DAYS` | `7` | Absolute Obergrenze ohne Remember-Me. |
| `SESSION_REMEMBER_ABSOLUTE_DAYS` | `90` | Absolute Obergrenze mit Remember-Me. |

## Lokales Testen (ohne Reverse Proxy)

Da die App ihren eigenen Login mitbringt, läuft sie lokal ohne Proxy:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt

DATABASE_URL="sqlite:///./pocketlog-dev.db" .venv/bin/alembic upgrade head

DATABASE_URL="sqlite:///./pocketlog-dev.db" \
  SESSION_COOKIE_SECURE=0 \
  .venv/bin/uvicorn app.main:app --reload --port 8000
```

API-Aufrufe mit curl – erst Setup, dann Login, dann mit Cookie + CSRF-Header
arbeiten:

```bash
curl -c c.txt -b c.txt -X POST -H 'Content-Type: application/json' \
     -d '{"username":"alice","password":"valid-password-2026!"}' \
     http://127.0.0.1:8000/api/auth/setup

CSRF=$(grep pocketlog_csrf c.txt | awk '{print $NF}')
curl -b c.txt -H "X-CSRF-Token: $CSRF" \
     -X POST -H 'Content-Type: application/json' \
     -d '{"name":"Test","icon":"house","color":"#123456"}' \
     http://127.0.0.1:8000/api/categories
```

## Entwicklung & Tests

Für lokale Entwicklung und die pytest-Suite reicht SQLite:

```bash
cd backend
.venv/bin/pytest                  # alle Tests
.venv/bin/pytest -x -v            # erster Fehler stoppt, mit Detail
```

Die Suite nutzt eine eigene SQLite-DB (automatisch erstellt und nach dem
Run entfernt). Jeder Test bekommt einen einzigartigen Username, damit
Daten zwischen Tests isoliert bleiben.

### Migrations-Hinweis für neue Revisionen

Neue Alembic-Revisionen müssen auf beiden Dialekten laufen (SQLite in Dev/CI,
MariaDB in Produktion):

- `UPDATE … JOIN` → MariaDB-only; SQLite-Pfad via `op.get_bind().dialect.name`
  (Beispiel: `0002_user_id_fk.py`)
- `REGEXP`, `CHAR_LENGTH` → MariaDB-only; SQLite-Pfad nutzt Python-Loop bzw.
  `LENGTH` (Beispiel: `0005_category_icon_ids.py`)
- `drop_constraint`, `alter_column`, `drop_column` → immer in
  `with op.batch_alter_table(...) as batch:` packen (SQLite-Pflicht); auf
  Eltern-Tabellen mit FK-abhängigen Children ggf. per Dialekt splitten
  (Beispiel: `0009_auth_local.py`)
- `ADD COLUMN … DEFAULT CURRENT_TIMESTAMP` → lehnt SQLite ab; Dialekt-Pfad:
  Spalte nullable hinzufügen, dann `UPDATE … SET col = CURRENT_TIMESTAMP`

Revisisions-ID ≤ 24 Zeichen (MariaDB `VARCHAR(32)`, Konvention 24 für Puffer);
ein pytest-Guard prüft das automatisch – niemals umgehen.

---

## Unraid & SWAG (optional)

Wer PocketLog auf **Unraid** hinter **SWAG** betreibt:

**Unraid-Template:**
`unraid/pocketlog.xml` nach
`/boot/config/plugins/dockerMan/templates-user/` kopieren → in
_Apps → Add Container_ steht `pocketlog` im Template-Dropdown mit allen
Feldern vorbelegt.

**SWAG-Konfiguration:**
`swag/pocketlog.subdomain.conf` nach `/config/nginx/proxy-confs/` legen,
SWAG neu laden. Weitere optionale Snippets:

| Datei | Zweck |
|---|---|
| `swag/internal.conf` | LAN-Allowlist (10/8, 172.16/12, 192.168/16) |
| `swag/geoblock.conf` + `maxmind.conf` | GeoIP-Whitelist |
| `swag/errors.conf` | Custom-Error-Pages |

**Authentik (optionale zusätzliche Schutzschicht):**
PocketLog benötigt keinen vorgelagerten Identity-Provider. Wer Authentik
trotzdem als Forward-Auth-Gate nutzen möchte, richtet in Authentik einen
Forward-Auth-Provider + Application für die Subdomain ein und weist ihn dem
Outpost zu. PocketLog ignoriert die von Authentik gesetzten Header
(`X-Authentik-Username`, `Authorization`) vollständig.
