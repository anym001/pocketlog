# Contributing & Branching

PocketLog is developed through short-lived feature branches and pull requests.
`main` is always release-ready; `dev` is the integration/staging channel for
testing changes before they reach production.

## Branch Model

| Branch | Purpose | Protected |
|---|---|---|
| `main` | production-stable; a release is cut by pushing a `vX.Y.Z` tag (`:latest` + `:X.Y.Z`) | yes |
| `dev` | integration/staging; every push builds the `:dev` image | yes |
| `feature/*` | short-lived work on a single topic; deleted after merge | – |

"Automatically delete head branches" in the repo stays **enabled** — it cleans up
merged `feature/*` branches. Protected branches (`dev`, `main`) are never deleted
by this setting.

## Workflow

```
feature/xyz ──PR──▶ dev ──(:dev-image)──▶ test on staging ──PR──▶ main ──tag vX.Y.Z──▶ Release
```

1. **Branch** from `dev`: `git switch dev && git pull && git switch -c feature/xyz`
2. **Open a PR against `dev`**. CI (`tests`) must be green; enable "Auto-merge" so
   GitHub merges the **final, green** state automatically (no manual merge of an
   unfinished/red head).
3. The push to `dev` builds and publishes **`:dev`** on GHCR. Verify with the staging
   instance (pinned to `:dev`).
4. When `dev` is good: **PR `dev → main`** and merge it. Merging to `main` does
   **not** publish anything on its own — `main` only holds the release-ready state.
5. **Cut the release** by pushing a version tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`. The tag is the sole trigger for
   `build.yml` → green `tests` gate → `:latest` + `:X.Y.Z` images (GHCR + Docker
   Hub) + a GitHub release with generated notes. The version comes entirely from
   the tag — there is no VERSION file and no auto-bump — so pick it by semver:
   patch for fixes, minor for new features (e.g. `v0.7.3` → `v0.8.0`).
6. **Production** pulls the new `:X.Y.Z` tag deliberately, not `:latest`.

## CI

`.github/workflows/test.yml` runs on every PR (and as a gate before every
image build):

- **test-sqlite** — full pytest suite including migrations (SQLite).
- **migrations-mariadb** — `alembic upgrade head` against a real MariaDB
  (dialect-specific code paths).
- **smoke** — build the image, boot it as an Unraid user (PUID/PGID 99:100),
  health check + DB ownership, then **Playwright UI smoke**: setup/login,
  core views render, **no visible raw i18n keys** (`namespace.key`).

A red run blocks both merge **and** image publication.

## Setting Up Branch Protection (one-time)

GitHub → **Settings → Branches → Add branch ruleset** (the newer Rulesets
system, not "classic"). A single ruleset covers both `main` **and** `dev`.

1. **Ruleset Name:** `protected-branches`
2. **Enforcement status:** `Active`
3. **Bypass list:** leave empty (otherwise you undermine the protection for yourself;
   in an emergency, temporarily set the ruleset to `Disabled`).
4. **Target branches → Add target:** `Include default branch` (= `main`) **and**
   `Include by pattern` → `dev`. It should say "Applies to 2 targets".
5. **Branch rules** (check boxes):
   - ✅ **Restrict deletions**
   - ✅ **Block force pushes**
   - ✅ **Require a pull request before merging**
     - **Required approvals: `0`** ⚠️ — as a solo maintainer you cannot review
       your own PR; setting ≥1 would block you. PR requirement + checks still apply
       at 0, and auto-merge works.
   - ✅ **Require status checks to pass**
     - ✅ **Require branches to be up to date before merging**
     - Add exactly **these three** checks: `test-sqlite`,
       `migrations-mariadb`, `smoke`.
       ⚠️ Do **not** select the `tests / …` variants: those only appear on push
       (`workflow_call` from `dev.yml`/`build.yml`), never on a **PR**, and would
       permanently block it as "Expected". On a PR, `test.yml` runs directly and
       reports the **bare** names.
6. **Save changes.**

Then enable **Settings → General → Pull Requests → "Allow auto-merge"**.
Click "Enable auto-merge" per PR; GitHub merges automatically once checks are green
and the branch is up to date.

> Why this matters: this combination prevents exactly the two failure modes that have
> already occurred — a merge over red/unfinished checks, and an accidental direct
> push to `main`.
