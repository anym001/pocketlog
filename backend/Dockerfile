FROM python:3.12-slim

ARG APP_VERSION=dev
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_VERSION=${APP_VERSION}

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend code and migrations
COPY backend/alembic.ini ./alembic.ini
COPY backend/migrations ./migrations
COPY backend/app ./app

# PWA static files (served via FastAPI StaticFiles)
COPY frontend/index.html frontend/sw.js frontend/db.js frontend/manifest.webmanifest frontend/example-import.csv ./static/
COPY frontend/icons ./static/icons
COPY frontend/fonts ./static/fonts

# Bake APP_VERSION into the service worker so each release gets a fresh
# cache key (pocketlog-shell-${VERSION}, pocketlog-api-${VERSION}) and the
# activate-hook can prune stale caches automatically. Without this, sw.js
# bytes never change across releases and the browser keeps serving the
# previous cached shell.
RUN sed -i "s/'__APP_VERSION__'/'${APP_VERSION}'/" /app/static/sw.js

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
