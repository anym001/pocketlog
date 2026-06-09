"""Per-domain API routers.

main.py wires these together via ``include_router`` and keeps only app-level
concerns (middleware, the domain-error handler, the static-files mount). Each
module owns one slice of the ``/api`` surface and pulls the shared auth
dependencies from ``app.deps``.
"""

from . import (  # noqa: F401  (re-exported for main.include_router)
    admin,
    api_keys,
    auth,
    categories,
    goals,
    health,
    imexport,
    recurring,
    settings,
    tags,
    transactions,
)
