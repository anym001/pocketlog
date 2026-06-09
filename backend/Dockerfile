FROM python:3.12-slim

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
COPY frontend/index.html frontend/styles.css frontend/app.js frontend/utils.js frontend/reportsData.js frontend/state.js frontend/i18n.js frontend/sw.js frontend/db.js frontend/manifest.webmanifest frontend/example-import-de.csv frontend/example-import-en.csv ./static/
COPY frontend/i18n ./static/i18n
COPY frontend/icons ./static/icons
COPY frontend/fonts ./static/fonts
COPY frontend/vendor ./static/vendor

# Bake APP_VERSION into the service worker so each release gets a fresh
# cache key (pocketlog-shell-${VERSION}, pocketlog-api-${VERSION}) and the
# activate-hook can prune stale caches automatically. Without this, sw.js
# bytes never change across releases and the browser keeps serving the
# previous cached shell.
# Pipe delimiter for sed because APP_VERSION may legitimately contain
# slashes (branch-based tags, e.g. `feature/foo`); a `/` delimiter would
# unparseably collide with them.
RUN sed -i "s|'__APP_VERSION__'|'${APP_VERSION}'|" /app/static/sw.js

# /app is owned by a build-time user and left world-readable. The container
# starts as root so the entrypoint can chown the /config mount, then drops
# to PUID:PGID (default 1000, override e.g. 99:100 on Unraid) via gosu. The
# DB lives on /config (SQLite default) or is external (MariaDB option);
# static files are served read-only; uvicorn logs to stdout. Port 8000 is
# above the privileged range so no extra capability is required.
RUN useradd --create-home --uid 1000 pocketlog \
 && chown -R pocketlog:pocketlog /app

COPY backend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
