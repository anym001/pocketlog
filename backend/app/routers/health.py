"""Public liveness and version probes — no auth."""

import logging
import os

from fastapi import APIRouter, Response
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from ..deps import DB

logger = logging.getLogger("pocketlog.api")

router = APIRouter()


@router.get("/api/health")
def health(response: Response, db: DB) -> dict:
    # A cheap round-trip against the real backend (SQLite file or MariaDB).
    # Without this, a container with a dead/unreachable DB still answers
    # 200 here forever — the orchestrator's HEALTHCHECK never notices, so a
    # stuck container just keeps failing every real request instead of
    # being restarted.
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        logger.warning("health check: database unreachable")
        response.status_code = 503
        return {"status": "error", "database": "unreachable"}
    return {"status": "ok"}


@router.get("/api/version")
def version() -> dict:
    return {"version": os.environ.get("APP_VERSION", "dev")}
