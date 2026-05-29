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
- [Login & Sicherheit](#login--sicherheit)
- [Notfall-Recovery](#notfall-recovery)
- [Image](#image)
- [Lizenz](#lizenz)

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
- **Offline-Fähigkeit** – App funktioniert ohne Verbindung; Änderungen werden
  beim nächsten Online-Sein automatisch synchronisiert
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

### 3. Ersteinrichtung

Beim ersten Aufruf (`http://<host>:8000`) erscheint die Setup-View. Lege den
ersten Admin an (Username + Passwort, mindestens 12 Zeichen mit Groß-/Klein-
buchstaben, Zahl und Sonderzeichen). Weitere Benutzer legt der Admin danach
unter _Einstellungen → Benutzerverwaltung_ an.

## Konfiguration

| Variable | Default | Bedeutung |
|---|---|---|
| `DB_HOST` | `mariadb` | Hostname oder IP der MariaDB |
| `DB_PORT` | `3306` | MariaDB-Port |
| `DB_NAME` | – | Datenbankname |
| `DB_USER` | – | Datenbankbenutzer |
| `DB_PASSWORD` | – | Datenbankpasswort |
| `TZ` | `UTC` | Zeitzone des Containers |
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
