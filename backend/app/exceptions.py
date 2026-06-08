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
