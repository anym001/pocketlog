"""Domain-level exceptions for PocketLog.

The CRUD layer raises these typed exceptions for business-rule violations;
a single FastAPI handler (``main._domain_error_handler``) maps any
``DomainError`` to an HTTP response by reading ``status_code`` and ``detail``
off the exception. This replaces the former ``raise ValueError("code")`` in
crud.py paired with ``if str(e) == "code": raise HTTPException(...)`` chains
in main.py — a fragile string contract spread across two files.

Each subclass pins the exact ``status_code`` and ``detail`` the API has
always returned for that condition, so the HTTP responses (and the
machine-readable contract the frontend relies on) stay byte-for-byte
identical. Note the deliberate asymmetry preserved from the old handlers:
transaction/tag errors return ``400`` with the raw code as ``detail``
(``unknown_category``/``empty_name``), while goal/recurring/category errors
return ``409``/``422`` with human-readable detail strings.
"""


class DomainError(Exception):
    """Base for business-rule violations mapped to HTTP responses.

    Subclasses set ``status_code`` (the HTTP status the endpoint returns)
    and ``detail`` (the response body ``detail`` string). Intentionally not
    a subclass of ``ValueError`` so it bypasses any incidental
    ``except ValueError`` and reaches the dedicated handler.
    """

    status_code: int = 400
    detail: str = "domain_error"


class CategoryNotFoundError(DomainError):
    """A goal or recurring-rule payload references a category the user does
    not own."""

    status_code = 422
    detail = "category not found"


class CategoryInUseError(DomainError):
    """Category deletion blocked: transactions still reference it."""

    status_code = 409
    detail = "category in use"


class CategoryHasGoalError(DomainError):
    """Category deletion blocked: a goal still references it."""

    status_code = 409
    detail = "category has goal"


class CategoryHasRecurringRuleError(DomainError):
    """Category deletion blocked: a recurring rule still references it."""

    status_code = 409
    detail = "category has recurring rule"


class BackdateTooFarError(DomainError):
    """A recurring rule's start date lies further in the past than the
    catch-up engine will materialize."""

    status_code = 422
    detail = "backdate too far"


class UnknownCategoryError(DomainError):
    """A transaction payload references a category the user does not own.

    Distinct from ``CategoryNotFoundError``: the transaction endpoints have
    always returned ``400`` with the raw code as the detail.
    """

    status_code = 400
    detail = "unknown_category"


class EmptyNameError(DomainError):
    """A tag create/rename was given a blank name."""

    status_code = 400
    detail = "empty_name"


# --- Admin user-management policy ---
# Authorization guards shared by the admin user endpoints. They follow the
# same status/detail contract as the business-rule errors above and map
# through the same handler.


class UserNotFoundError(DomainError):
    """An admin action targets a user id that does not exist."""

    status_code = 404
    detail = "user_not_found"


class CannotModifySelfError(DomainError):
    """An admin targets their own account with a destructive user action
    (reset-password / deactivate / activate / delete)."""

    status_code = 403
    detail = "cannot_modify_self"


class CannotModifyAdminError(DomainError):
    """An admin targets another admin account with deactivate/delete — blocked
    so the instance can never end up with zero admins."""

    status_code = 403
    detail = "cannot_modify_admin"
