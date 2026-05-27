# PocketLog

Haushaltsbuch als Progressive Web App. Läuft auf iPhone / iPad / Mac, speichert
Daten in deiner eigenen MariaDB. Zwei Auth-Schichten:

- **Domain-Tor:** Authentik per Forward Auth über SWAG (Passwort + MFA) – wie
  alle anderen Apps an deinem Proxy.
- **App-Login:** PocketLog hat seinen eigenen Username/Passwort-Login mit
  Admin-Rolle und Setup-Flow für den ersten Admin. Authentik liefert keine
  Identität mehr an die App.

Ein einziger Container, statische PWA + FastAPI in einem Image. Die MariaDB
betreibst du selbst (z.B. dein bestehender Unraid-MariaDB-Container).

## Erst die Datenbank anlegen

In deiner MariaDB:

```sql
CREATE DATABASE pocketlog CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'pocketlog'@'%' IDENTIFIED BY 'dein-passwort';
GRANT ALL ON pocketlog.* TO 'pocketlog'@'%';
FLUSH PRIVILEGES;
```

Beim ersten Start spielt der Container die Schema-Migrationen automatisch ein.

## Setup über die Unraid GUI

1. **Template einbinden:** `unraid/pocketlog.xml` aus diesem Repo holen
   und nach `/boot/config/plugins/dockerMan/templates-user/` auf deinem
   Unraid-Server kopieren. Danach in **Apps → Add Container** im
   **Template:**-Dropdown `pocketlog` auswählen — alle Felder sind dann
   vorbelegt. (Bei privatem Repo geht die Template-URL-Variante nicht; wer
   lieber alles per Hand einträgt, nimmt die Tabelle unten.)
2. Felder prüfen / ausfüllen:
   - **WebUI Port**: z.B. `8080`
   - **DB_HOST**: Container-Name oder IP deiner MariaDB
   - **DB_NAME** / **DB_USER** / **DB_PASSWORD**: wie oben angelegt
   - **Network**: dasselbe Docker-Network wie deine MariaDB *und* SWAG
     (sonst kommt PocketLog nicht an die DB bzw. SWAG nicht an PocketLog)
3. **Apply** → der Container wird gezogen, läuft Alembic, startet uvicorn.
4. **SWAG** vorbereiten:
   `swag/pocketlog.subdomain.conf` nach `/swag/config/nginx/proxy-confs/`
   kopieren, SWAG neu laden.
5. In **Authentik** einen Forward-Auth-Provider + Application für
   `pocketlog.<deinedomain>` anlegen und dem Outpost zuweisen.
6. **App-Login einrichten:** Beim ersten Aufruf der App erscheint die
   Setup-View. Lege darüber den ersten Admin an (Username + Passwort
   mit mindestens 12 Zeichen). Danach läuft der reguläre Login direkt
   im PocketLog-UI.

### Manuell ohne Template

Wer kein Template importieren mag, trägt in der „Add Container"-GUI ein:

| Feld | Wert |
|---|---|
| Repository | `ghcr.io/anym001/pocketlog:latest` |
| Network | gleiches Network wie MariaDB / SWAG |
| Port | Host `8080` → Container `8000` |
| ENV `DB_HOST` | `mariadb` (Container-Name) |
| ENV `DB_PORT` | `3306` |
| ENV `DB_NAME` | `pocketlog` |
| ENV `DB_USER` | `pocketlog` |
| ENV `DB_PASSWORD` | dein Passwort |
| ENV `TZ` | `Europe/Berlin` |

## Funktionsumfang

- **Transaktionen** – Einnahmen & Ausgaben mit Datum, Betrag, Kategorie, Tags
- **Kategorien** – frei definierbar (Name, Icon, Farbe); beim ersten Aufruf werden Standardkategorien angelegt
- **Tags** – freie Schlagwörter pro Transaktion; zentral umbenennen oder löschen über die Einstellungen
- **CSV-Import / -Export** – Import aus anderen Tools (UTF-8 oder CP1252, max. 5 MB); Export aller Transaktionen als Semikolon-CSV
- **Offline-Fähigkeit** – Service Worker cached die App-Shell, POST/PUT/DELETE landen in einer Outbox und werden beim nächsten Online-Sein automatisch gesendet

## API testen

- Health: `https://pocketlog.<deinedomain>/api/health`
- Swagger UI: `/api/docs` ist standardmäßig deaktiviert. Zum Debuggen den
  Container mit `ENABLE_DOCS=1` starten; in Produktion bleibt es aus.

## Image-Builds (GitHub Actions → ghcr.io)

Der Workflow `.github/workflows/build.yml` baut bei jedem Push auf `main` ein
neues Image und pusht es nach `ghcr.io/<owner>/pocketlog`. Die Patch-Version
wird dabei automatisch hochgezählt und ein GitHub-Release erstellt — kein
manuelles Tagging nötig. Tags:

- `:latest` — letzter Stand von `main`
- `:X.Y.Z` — automatisch gesetzt vom Workflow (z.B. `v0.1.4`)
