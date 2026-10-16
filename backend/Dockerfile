FROM python:3.14-slim

ARG APP_VERSION=dev
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_VERSION=${APP_VERSION}

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gosu \
 && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend code and migrations
COPY backend/alembic.ini ./alembic.ini
COPY backend/migrations ./migrations
COPY backend/app ./app

# PWA static files (served via FastAPI StaticFiles)
COPY frontend/index.html frontend/styles.css frontend/theme-boot.js frontend/app.js frontend/core.js frontend/ledger.js frontend/reports.js frontend/booking.js frontend/categories.js frontend/goals.js frontend/budgets.js frontend/recurring.js frontend/settings.js frontend/utils.js frontend/reportsData.js frontend/state.js frontend/i18n.js frontend/sw.js frontend/db.js frontend/manifest.webmanifest frontend/example-import-de.csv frontend/example-import-en.csv ./static/
COPY frontend/i18n ./static/i18n
COPY frontend/icons ./static/icons
COPY frontend/fonts ./static/fonts
COPY frontend/vendor ./static/vendor

# Bake the release version into the service worker (cache keys
# pocketlog-shell-<v> / pocketlog-api-<v>, pruned by the activate hook) and
# into index.html (<meta name="app-version"> and the ?v= on every
# script/style tag). Each build must get a version of its own: sw.js has to
# change for browsers to install the new worker, and the ?v= URLs are served
# cache-first — a reused version would pair fresh HTML with the previous
# build's cached files. CI passes dev-<sha> / X.Y.Z; a plain local
# `docker build` (APP_VERSION=dev) gets dev-<build time> instead.
# The version lands verbatim in JS strings and URLs: anything beyond
# [0-9A-Za-z._/-] (quotes, &, |, #, +, spaces) would break the sed, the code
# or the ?v= URLs (URLSearchParams reads + as a space), so the build fails.
# Pipe delimiter for sed because the version may contain slashes.
RUN v="${APP_VERSION}"; \
    if [ "$v" = dev ]; then v="dev-$(date -u +%Y%m%d%H%M%S)"; fi; \
    case "$v" in \
      ''|*[!0-9A-Za-z._/-]*) echo "APP_VERSION '$v' must match [0-9A-Za-z._/-]+" >&2; exit 1 ;; \
    esac; \
    sed -i "s|'__APP_VERSION__'|'$v'|" /app/static/sw.js && \
    sed -i "s|__APP_VERSION__|$v|g" /app/static/index.html

# /app is owned by a build-time user and left world-readable. The container
# starts as root so the entrypoint can chown the /config mount, then drops
# to PUID:PGID (default 1000, override e.g. 99:100 on Unraid) via gosu. The
# DB lives on /config (SQLite default) or is external (MariaDB option);
# static files are served read-only; uvicorn logs to stdout. Port 8000 is
# above the privileged range so no extra capability is required.
RUN useradd --create-home --uid 1000 pocketlog \
 && chown -R pocketlog:pocketlog /app

COPY backend/docker-entrypoint.sh /docker-entrypoint.sh
# Operator-CLI launcher: `docker exec pocketlog pocketlog <command>` instead
# of `python -m app.cli <command>`. Drops to PUID:PGID itself (docker exec
# enters as root, bypassing the entrypoint's gosu).
COPY backend/pocketlog-cli.sh /usr/local/bin/pocketlog
RUN chmod +x /docker-entrypoint.sh /usr/local/bin/pocketlog

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
