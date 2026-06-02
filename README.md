# PocketLog

Haushaltsbuch als Progressive Web App (PWA) – läuft im Browser auf allen
gängigen Plattformen (iOS, Android, macOS, Windows, Linux) und lässt sich
als App auf dem Homescreen installieren.

Konzipiert für **privates Self-Hosting**: Daten liegen ausschließlich auf
deinem eigenen Server – standardmäßig in einer eingebetteten SQLite-Datei
(keine separate Datenbank nötig), optional in einer externen MariaDB. Die
App läuft in deinem eigenen Container. Alle Assets (Fonts, Icons,
JS-Bibliotheken) werden vom eigenen Server ausgeliefert – keine
CDN-Aufrufe, keine externen Verbindungen, kein Tracking, keine Telemetrie.

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Voraussetzungen](#voraussetzungen)
- [Schnellstart](#schnellstart)
- [Konfiguration](#konfiguration)
- [Reverse Proxy](#reverse-proxy)
- [Login & Sicherheit](#login--sicherheit)
- [Logging & Audit-Trail](#logging--audit-trail)
- [Notfall-Recovery](#notfall-recovery)
- [Image](#image)
- [Lizenz](#lizenz)

## Funktionsumfang

- **Transaktionen** – Einnahmen & Ausgaben mit Datum, Betrag, Kategorie und Tags
- **Kategorien** – frei definierbar (Name, Icon, Farbe); Standardset wird beim
  ersten Aufruf angelegt
- **Tags** – freie Schlagwörter pro Transaktion; zentral umbenennen oder löschen
- **Ziele** – Sparziele und Schulden-Tracker in einem: ein Ziel wird 1:1 mit einer
  Kategorie verknüpft, der Fortschritt ergibt sich aus deren Buchungen ab dem
  Startdatum (Ansparen zählt Einnahmen hoch, Schuldenabbau zählt Ausgaben herunter).
  Reine Anzeige – die Kassenbuch-Summen bleiben unberührt
- **Berichte & Charts** – Monats-/Jahresübersicht, Kategorien- und Tag-Auswertung,
  Trendansicht und Prognose (Chart.js, lokal eingebettet)
- **Suche** – Volltext, Kategorie- und Tag-Filter in der Transaktionsliste
- **CSV-Import / -Export** – UTF-8 oder CP1252, max. 5 MB; Export aller
  Transaktionen als Semikolon-CSV
- **Offline-Fähigkeit** – App funktioniert ohne Verbindung; Änderungen werden
  beim nächsten Online-Sein automatisch synchronisiert
- **Themes** – Hell, Dunkel, System (wird aus den Einstellungen gespeichert)
- **Sprache & Währung** – Deutsch/Englisch mit Regionsvarianten (de-DE, de-AT,
  de-CH, en-GB, en-US) steuern Übersetzung *und* Datums-/Zahlenformat; Anzeige­-
  währung (EUR, USD, GBP, CHF, JPY) frei wählbar. Pro Benutzer einstellbar,
  Instanz-Default über `DEFAULT_LOCALE` / `DEFAULT_CURRENCY` (siehe
  [Konfiguration](#konfiguration))
- **Multi-User** – jede Identität hat eigene Daten; Admin legt weitere Benutzer an
- **Eigener Login** – Username/Passwort mit Admin-Rolle, Setup-Flow und
  Brute-Force-Schutz

## Voraussetzungen

- Docker (oder Podman)
- **Optional:** MariaDB 10.6+ (externe Instanz) — nur wenn du nicht die
  eingebaute SQLite-Datenbank nutzen möchtest

## Schnellstart

Standardmäßig nutzt PocketLog eine eingebettete **SQLite-Datenbank** unter
`/config/db/pocketlog.db` — keine separate Datenbank, keine DB-Variablen
nötig. Mounte `/config` auf den Host, damit die Daten Container-Updates
überleben.

### 1. Container starten

```bash
docker run -d \
  --name pocketlog \
  -p 8000:8000 \
  -e PUID=1000 -e PGID=1000 \
  -e TZ=Europe/Berlin \
  -v /mnt/user/appdata/pocketlog:/config \
  ghcr.io/anym001/pocketlog:latest
```

`PUID`/`PGID` bestimmen, welchem Host-Benutzer die Dateien unter `/config`
gehören (siehe [Konfiguration](#konfiguration)). Auf Unraid typischerweise
`PUID=99` / `PGID=100`.

### 2. Ersteinrichtung

Beim ersten Aufruf (`http://<host>:8000`) erscheint die Setup-View. Lege den
ersten Admin an (Username + Passwort, mindestens 12 Zeichen mit Groß-/Klein-
buchstaben, Zahl und Sonderzeichen). Weitere Benutzer legt der Admin danach
unter _Einstellungen → Benutzerverwaltung_ an.

### Externe MariaDB (optional)

Wer lieber eine externe MariaDB betreibt, legt dort eine Datenbank an …

```sql
CREATE DATABASE pocketlog CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pocketlog'@'%' IDENTIFIED BY 'dein-passwort';
GRANT ALL ON pocketlog.* TO 'pocketlog'@'%';
FLUSH PRIVILEGES;
```

… und setzt die `DB_*`-Variablen beim Start. **Sobald eine `DB_*`-Variable
gesetzt ist, schaltet PocketLog auf MariaDB um** (statt SQLite); `DB_PASSWORD`
ist dann Pflicht:

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

## Konfiguration

| Variable | Default | Bedeutung |
|---|---|---|
| `PUID` | `1000` | Host-User-ID, der die Dateien unter `/config` gehören (Unraid: `99`) |
| `PGID` | `1000` | Host-Group-ID für `/config` (Unraid: `100`) |
| `SQLITE_PATH` | `/config/db/pocketlog.db` | Pfad der SQLite-Datei (nur ohne `DB_*`) |
| `DB_HOST` | `mariadb` | **Nur MariaDB-Option:** Hostname oder IP. Eine gesetzte `DB_*`-Variable schaltet von SQLite auf MariaDB um. |
| `DB_PORT` | `3306` | Nur MariaDB-Option: Port |
| `DB_NAME` | `pocketlog` | Nur MariaDB-Option: Datenbankname |
| `DB_USER` | `pocketlog` | Nur MariaDB-Option: Datenbankbenutzer |
| `DB_PASSWORD` | – | Nur MariaDB-Option: Passwort (Pflicht, sobald MariaDB aktiv ist) |
| `DATABASE_URL` | – | Erweitert: vollständige SQLAlchemy-URL; übersteuert `DB_*`/SQLite (z.B. für SSL, Socket, eigenen Treiber) |
| `TZ` | `UTC` | Zeitzone des Containers |
| `LOG_LEVEL` | `INFO` | Log-Level (`DEBUG`, `INFO`, `WARNING`, `ERROR`). Audit-Events (Logins, Lockouts, Admin-Aktionen) liegen auf `INFO`/`WARNING`. |
| `LOG_FORMAT` | `text` | Log-Format. Aktuell nur `text` (menschenlesbar, für `docker logs`); `json` ist reserviert und fällt bis zur Implementierung auf `text` zurück. |
| `LOG_FILE` | – | Schreibt Logs **zusätzlich** zu `docker logs` in diese Datei (rotierend). Empfehlung: `/config/logs/audit.log` mit gemountetem `/config`-Verzeichnis, um Logs über Container-Updates hinweg zu behalten (siehe [Logging & Audit-Trail](#logging--audit-trail)). |
| `LOG_FILE_MAX_BYTES` | `10485760` | Rotationsgröße der Logdatei in Bytes (Default 10 MB). |
| `LOG_FILE_BACKUPS` | `5` | Anzahl rotierter Logdateien, die behalten werden. |
| `DEFAULT_LOCALE` | `de-DE` | Start-Locale neuer Konten (BCP-47: `de-DE`, `de-AT`, `de-CH`, `en-GB`, `en-US`). Jeder Nutzer kann es selbst überschreiben. |
| `DEFAULT_CURRENCY` | `EUR` | Start-Währung neuer Konten (ISO 4217: `EUR`, `USD`, `GBP`, `CHF`, `JPY`). Reine Anzeige, pro Nutzer überschreibbar. |
| `SESSION_COOKIE_SECURE` | `1` | Auf `0` setzen, wenn PocketLog ohne HTTPS betrieben wird |
| `SESSION_LIFETIME_HOURS` | `24` | Session-Dauer ohne „Eingeloggt bleiben" |
| `SESSION_REMEMBER_DAYS` | `30` | Session-Dauer mit „Eingeloggt bleiben" |
| `SESSION_ABSOLUTE_DAYS` | `7` | Maximale Session-Dauer (normal) |
| `SESSION_REMEMBER_ABSOLUTE_DAYS` | `90` | Maximale Session-Dauer (Remember-Me) |

## Reverse Proxy

PocketLog läuft auf Port 8000 und bringt seinen eigenen Login mit – kein
vorgelagerter Identity-Provider nötig. Dahinter kann ein beliebiger Reverse
Proxy sitzen (nginx, Caddy, Traefik …). Nginx-Beispiel:

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

## Login & Sicherheit

- **Passwort-Policy**: mindestens 12 Zeichen mit Groß-/Kleinbuchstaben, Zahl
  und Sonderzeichen
- **Brute-Force-Schutz**: nach mehreren Fehlversuchen greift eine automatische
  Sperrzeit; Admins können diese über _Passwort zurücksetzen_ aufheben
- **Session**: bleibt standardmäßig 24 Stunden aktiv, mit „Eingeloggt bleiben"
  30 Tage; nach absolut 7 bzw. 90 Tagen wird eine neue Anmeldung erzwungen

## Logging & Audit-Trail

PocketLog protokolliert sicherheitsrelevante Ereignisse (Logins inkl.
Fehlversuche, Lockouts, Passwortänderungen, Admin-Benutzeraktionen, das Löschen
aller eigenen Daten). Es werden **nie** Passwörter, Hashes, Session- oder
CSRF-Tokens geloggt.

Standardmäßig geht die Ausgabe nach `stdout`/`stderr`, also in `docker logs`.
Das überlebt Container-Neustarts, aber **nicht** ein Update mit `docker rm`.
Für einen dauerhaften Audit-Trail gibt es zwei Wege:

**Variante A – Logdatei im App-Verzeichnis (in-App, einfach):**

PocketLog folgt der gängigen Self-Hosting-Konvention: ein einziges
App-Verzeichnis unter `/config` im Container, das du auf den Host mountest.
Dort liegen die SQLite-Datenbank (`/config/db/`, sofern keine externe MariaDB
genutzt wird) und der Audit-Trail (`/config/logs/`) — ein Mount deckt den
gesamten persistenten App-Zustand ab.

```bash
docker run -d \
  --name pocketlog \
  -p 8000:8000 \
  -e DB_HOST=mariadb -e DB_NAME=pocketlog \
  -e DB_USER=pocketlog -e DB_PASSWORD=dein-passwort \
  -e LOG_FILE=/config/logs/audit.log \
  -v /mnt/user/appdata/pocketlog:/config \
  ghcr.io/anym001/pocketlog:latest
```

Schreibt **zusätzlich** zu `docker logs` in die Datei (rotierend, Größe/Anzahl
über `LOG_FILE_MAX_BYTES` / `LOG_FILE_BACKUPS`). Das fehlende Verzeichnis wird
automatisch angelegt. Ist die Datei nicht beschreibbar, läuft die App weiter
und loggt nur nach `stderr` (mit Warnung). Der gemountete `/config`-Ordner
bleibt über Container-Updates erhalten.

> **Unraid:** Im Template `/config` auf `/mnt/user/appdata/pocketlog` mappen
> und `LOG_FILE=/config/logs/audit.log` setzen — der gesamte App-Zustand liegt
> dann unter einem Pfad in deinem appdata-Share.

**Variante B – Docker-Log-Driver (plattformseitig, „12-Factor"):**

App unverändert nach `stderr` loggen lassen und die Persistenz dem Host
überlassen, z.B. via journald:

```bash
docker run -d --name pocketlog \
  --log-driver=journald \
  … (übrige Optionen) …
```

Logs landen dann im systemd-Journal (`journalctl CONTAINER_NAME=pocketlog`) und
überleben Container-Updates, ohne dass die App Dateien verwalten muss.

> Variante A ist am bequemsten für Einzelinstanzen; Variante B ist sauberer,
> wenn ohnehin eine zentrale Log-Infrastruktur (journald, syslog, Loki …)
> vorhanden ist. Beides lässt sich kombinieren.

## Notfall-Recovery

Admin-Passwort vergessen:

```bash
docker exec -it pocketlog python -m app.cli reset-admin-password
```

Setzt Passwort und Sperrzeit zurück; beim nächsten Login muss ein neues
Passwort vergeben werden. `--username U` adressiert einen bestimmten Account.

## Image

Image: `ghcr.io/anym001/pocketlog`

- `:latest` – letzter Stand von `main`
- `:X.Y.Z` – versionierter Release (z.B. `v0.3.2`)

## Lizenz

PocketLog steht unter der **GNU Affero General Public License v3.0**
(AGPL-3.0). Du darfst die Software nutzen, weitergeben und verändern – wenn du
eine (geänderte) Version über ein Netzwerk als Dienst anbietest, musst du den
vollständigen Quellcode anbieten (AGPL §13). Den vollständigen Lizenztext
findest du in [`LICENSE`](LICENSE).

Copyright (C) 2026 anym001

---

Entwickelt mit [Claude Code](https://claude.ai/code)
