"""Small constructors for the recurring HTTP error responses.

These cover the two most-duplicated cases in ``main.py``: the generic
``404 {"detail": "not found"}`` returned whenever a user-scoped lookup misses,
and the ``409`` conflict raised on a unique-constraint clash. They return an
``HTTPException`` (rather than raising) so the call site keeps an explicit
``raise`` — the control flow stays visible at the endpoint.

Domain business-rule violations (category in use, foreign category, …) are
*not* built here: those are typed ``DomainError`` exceptions (see
``app.exceptions``) mapped centrally.
"""

from fastapi import HTTPException


def not_found(detail: str = "not found") -> HTTPException:
    """404 for a user-scoped lookup that returned nothing."""
    return HTTPException(status_code=404, detail=detail)


def conflict(detail: str) -> HTTPException:
    """409 for a unique-constraint / state conflict (e.g. duplicate name)."""
    return HTTPException(status_code=409, detail=detail)
