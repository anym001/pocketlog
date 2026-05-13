# PocketLog

Haushaltsbuch als Progressive Web App. Läuft auf iPhone / iPad / Mac, speichert
Daten in deiner eigenen MariaDB und nutzt Authentik per Forward Auth (z.B. über
SWAG) für die Anmeldung — die App selbst hat keinen Login.

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

1. **Apps → Add Container → Template URL:**
   `https://raw.githubusercontent.com/anym001/PocketLog/main/unraid/pocketlog.xml`
   (oder das `unraid/pocketlog.xml` aus diesem Repo manuell laden)
2. Felder ausfüllen:
   - **WebUI Port**: z.B. `8080`
   - **DB_HOST**: Container-Name oder IP deiner MariaDB
   - **DB_NAME** / **DB_USER** / **DB_PASSWORD**: wie oben angelegt
   - **Network**: dasselbe Docker-Network wie deine MariaDB *und* SWAG
     (sonst kommt PocketLog nicht an die DB bzw. SWAG nicht an PocketLog)
3. **Apply** → der Container baut sich, läuft Alembic, startet uvicorn.
4. **SWAG** vorbereiten:
   `swag/pocketlog.subdomain.conf` nach `/swag/config/nginx/proxy-confs/`
   kopieren, SWAG neu laden.
5. In **Authentik** einen Forward-Auth-Provider + Application für
   `pocketlog.<deinedomain>` anlegen und dem Outpost zuweisen.

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

## API testen

- Health: `https://pocketlog.<deinedomain>/api/health`
- Swagger UI: `https://pocketlog.<deinedomain>/api/docs`

## Image-Builds (GitHub Actions → ghcr.io)

Der Workflow `.github/workflows/build.yml` baut bei jedem Push auf `main` ein
neues Image und pusht es nach `ghcr.io/<owner>/pocketlog`. Tags:

- `:latest` — letzter Stand von `main`
- `:sha-<short>` — jeder einzelne Commit, zum Pinnen
- `:X.Y.Z` / `:X.Y` — bei Git-Tags `vX.Y.Z` (z.B. `git tag v1.0.0 && git push --tags`)

**Einmalig nach dem ersten erfolgreichen Workflow-Run:** GitHub legt das
Package zunächst mit der Sichtbarkeit des Repos an (also privat, falls dein
Repo privat ist). Unter
*GitHub → Profil → Packages → pocketlog → Package settings →
Change package visibility* auf **Public** stellen. Danach pullt Unraid ohne
Authentifizierung. Das Repo selbst kann dabei privat bleiben — Package- und
Repo-Sichtbarkeit sind unabhängig.

Updaten auf Unraid: bestehendes Image im Container-Reiter mit *Force Update*
neu ziehen, oder dauerhaft per [Watchtower](https://containrrr.dev/watchtower/)
automatisieren.

## Endpunkt-URL in der App ändern

Standardmäßig spricht die installierte PWA mit demselben Host, von dem sie
geladen wurde (same-origin). Wer die App auf einer anderen URL hostet oder den
Server umzieht, trägt unter **Einstellungen → Server → API-Basis-URL** die
volle Backend-URL ein (z.B. `https://pocketlog.deinedomain.de`). Der Pfad
`/api` wird automatisch ergänzt; ein Klick auf *Speichern* prüft die
Erreichbarkeit.
