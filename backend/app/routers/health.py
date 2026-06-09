"""Public liveness and version probes — no auth, no DB."""

import os

from fastapi import APIRouter

router = APIRouter()


@router.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/api/version")
def version() -> dict:
    return {"version": os.environ.get("APP_VERSION", "dev")}
