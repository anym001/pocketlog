"""user_id-scoped persistence layer for PocketLog.

Historically a single ``crud.py`` module; split into per-domain submodules
for navigability. This package re-exports the full former surface so every
call site keeps using ``crud.<function>`` unchanged — the split is internal.

Submodules:
- ``defaults``      seed categories + deployment locale/currency defaults
- ``users``         user CRUD + admin-action target resolver
- ``categories``    category CRUD + shared ownership/seed helpers
- ``goals``         goal CRUD (1:1 with a category)
- ``tags``          tag CRUD + tag-name → ORM resolvers
- ``recurring``     recurring-rule CRUD
- ``transactions``  transaction CRUD
- ``settings``      user-settings CRUD + bulk data reset
- ``imexport``      CSV import
"""

from .categories import (
    _owned_category_exists,
    _seed_default_categories,
    create_category,
    delete_category,
    get_or_create_category,
    list_categories,
    update_category,
)
from .defaults import (
    DEFAULT_CATEGORIES,
    DEFAULT_CATEGORY_NAMES,
    DEFAULT_CURRENCY,
    DEFAULT_LOCALE,
    _resolve_default_currency,
    _resolve_default_locale,
)
from .goals import (
    create_goal,
    delete_goal,
    list_goals,
    update_goal,
)
from .imexport import (
    CsvRowError,
    _build_transaction,
    _norm_key,
    _parse_amount,
    _parse_date,
    import_csv,
)
from .recurring import (
    _apply_rule_fields,
    _load_rule,
    _subtract_months,
    create_recurring_rule,
    delete_recurring_rule,
    get_recurring_rule,
    list_recurring_rules,
    remove_skip,
    skip_next_occurrence,
    update_recurring_rule,
)
from .settings import (
    delete_all_transactions,
    delete_all_user_data,
    get_or_create_settings,
    update_settings,
)
from .tags import (
    _build_tag_cache,
    _find_tag_by_name,
    _resolve_tags,
    _resolve_tags_cached,
    create_tag,
    delete_tag,
    list_tags,
    rename_tag,
)
from .transactions import (
    _TX_TAGS_LOAD,
    create_transaction,
    delete_transaction,
    list_all_transactions,
    list_transactions,
    list_transactions_by_range,
    update_transaction,
)
from .users import (
    activate_user,
    count_admins,
    count_users,
    create_user,
    deactivate_user,
    delete_user,
    get_oldest_user,
    get_pending_admin,
    get_user_by_id,
    get_user_by_username,
    list_all_users,
    resolve_admin_target,
    set_user_password,
)

__all__ = [
    # defaults
    "DEFAULT_CATEGORIES",
    "DEFAULT_CATEGORY_NAMES",
    "DEFAULT_CURRENCY",
    "DEFAULT_LOCALE",
    "_resolve_default_currency",
    "_resolve_default_locale",
    # users
    "activate_user",
    "count_admins",
    "count_users",
    "create_user",
    "deactivate_user",
    "delete_user",
    "get_oldest_user",
    "get_pending_admin",
    "get_user_by_id",
    "get_user_by_username",
    "list_all_users",
    "resolve_admin_target",
    "set_user_password",
    # categories
    "_owned_category_exists",
    "_seed_default_categories",
    "create_category",
    "delete_category",
    "get_or_create_category",
    "list_categories",
    "update_category",
    # goals
    "create_goal",
    "delete_goal",
    "list_goals",
    "update_goal",
    # tags
    "_build_tag_cache",
    "_find_tag_by_name",
    "_resolve_tags",
    "_resolve_tags_cached",
    "create_tag",
    "delete_tag",
    "list_tags",
    "rename_tag",
    # recurring
    "_apply_rule_fields",
    "_load_rule",
    "_subtract_months",
    "create_recurring_rule",
    "delete_recurring_rule",
    "get_recurring_rule",
    "list_recurring_rules",
    "remove_skip",
    "skip_next_occurrence",
    "update_recurring_rule",
    # transactions
    "_TX_TAGS_LOAD",
    "create_transaction",
    "delete_transaction",
    "list_all_transactions",
    "list_transactions",
    "list_transactions_by_range",
    "update_transaction",
    # settings
    "delete_all_transactions",
    "delete_all_user_data",
    "get_or_create_settings",
    "update_settings",
    # imexport
    "CsvRowError",
    "_build_transaction",
    "_norm_key",
    "_parse_amount",
    "_parse_date",
    "import_csv",
]
