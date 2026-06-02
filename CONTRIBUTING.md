# Mitarbeit & Branching

PocketLog wird über kurzlebige Feature-Branches und Pull Requests entwickelt.
`main` ist immer release-fähig; `dev` ist der Integrations-/Staging-Kanal zum
Vortesten, bevor etwas die Produktion erreicht.

## Branch-Modell

| Branch | Zweck | Geschützt |
|---|---|---|
| `main` | produktionsstabil; jeder Merge erzeugt einen Release (`:latest` + `:X.Y.Z`) | ja |
| `dev` | Integration/Staging; jeder Push baut das `:dev`-Image | ja |
| `feature/*` | kurzlebige Arbeit an einem Thema; wird nach Merge gelöscht | – |

„Automatically delete head branches" im Repo bleibt **aktiviert** – es räumt
gemergte `feature/*`-Branches auf. Geschützte Branches (`dev`, `main`) werden
davon nie gelöscht.

## Ablauf

```
feature/xyz ──PR──▶ dev ──(:dev-Image)──▶ auf Staging testen ──PR──▶ main ──▶ Release
```

1. **Branch** von `dev`: `git switch dev && git pull && git switch -c feature/xyz`
2. **PR auf `dev`** öffnen. CI (`tests`) muss grün sein; „Auto-merge" einschalten,
   dann merged GitHub den **finalen, grünen** Stand selbst (kein manuelles Mergen
   eines unfertigen/roten Heads).
3. Der Push auf `dev` baut und veröffentlicht **`:dev`** in GHCR. Die Staging-
   Instanz (auf `:dev` gepinnt) damit prüfen.
4. Wenn `dev` passt: **PR `dev → main`**. Der Merge löst `build.yml` aus →
   Patch-Version automatisch hochgezählt, Git-Tag, `:latest` + `:X.Y.Z` gebaut,
   GitHub-Release erstellt.
5. **Produktion** zieht den neuen `:X.Y.Z`-Tag (bewusst), nicht `:latest`.

**Minor/Major-Release:** statt Auto-Patch einen Tag pushen –
`git tag v0.4.0 && git push origin v0.4.0` (baut genau diese Version).

## CI

`.github/workflows/test.yml` läuft auf jedem PR (und als Gate vor jedem
Image-Build):

- **test-sqlite** – komplette pytest-Suite inkl. Migrationen (SQLite).
- **migrations-mariadb** – `alembic upgrade head` gegen echtes MariaDB
  (dialektspezifische Pfade).
- **smoke** – Image bauen, als Unraid-User (PUID/PGID 99:100) booten,
  Health-Check + DB-Ownership, dann **Playwright-UI-Smoke**: Setup/Login,
  Kernansichten rendern, **keine sichtbaren Roh-i18n-Keys** (`namespace.key`).

Ein roter Lauf blockiert Merge **und** Image-Veröffentlichung.

## Branch Protection einrichten (einmalig)

GitHub → **Settings → Branches → Add branch ruleset** (oder „Add rule"), je für
`main` und `dev`:

- ✅ **Require a pull request before merging**
  - für `main`: optional „Require approvals: 1" (als Solo-Maintainer kannst du
    Reviews weglassen, aber den PR-Zwang behalten – er erzwingt CI + Auto-Merge).
- ✅ **Require status checks to pass before merging**
  - **Require branches to be up to date before merging**
  - erforderliche Checks auswählen: `test-sqlite`, `migrations-mariadb`, `smoke`
- ✅ **Do not allow bypassing the above settings** (gilt dann auch für Admins)
- ✅ **Block force pushes**
- (Restriktion „who can push" optional – PR-Zwang reicht.)

Danach im Repo **Settings → General → Pull Requests → „Allow auto-merge"**
aktivieren. Pro PR „Enable auto-merge" klicken; GitHub merged automatisch,
sobald die Checks grün und der Branch aktuell sind.

> Warum das wichtig ist: Diese Kombination verhindert genau die zwei Fehler­
> klassen, die schon aufgetreten sind – ein Merge über rote/unfertige Checks
> hinweg, und ein versehentlicher direkter Push auf `main`.
