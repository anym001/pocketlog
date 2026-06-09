"""Central home for the app's magic values.

Each constant lived next to its single use; gathering them here documents the
limits and tuning knobs in one place without changing any value. Behaviour is
identical — only the definition site moved.
"""

# --- CSV import limits (app.main.import_csv) ---
# Upload hard cap. Large enough for a multi-year personal ledger export,
# small enough to bound memory on the read-into-RAM decode path.
MAX_IMPORT_BYTES = 5 * 1024 * 1024  # 5 MB
# Row cap enforced by crud.import_csv; protects against a pathological file
# turning into a huge transaction batch.
MAX_IMPORT_ROWS = 10_000

# --- CSV export sanitisation (app.main._csv_safe) ---
# Excel, Numbers and LibreOffice evaluate a cell whose content starts with =,
# +, -, @ or a leading tab/CR as a formula. A user-controlled field beginning
# with one of these would execute when the file is re-opened, so it is prefixed
# with a single quote to force plain text without losing information.
CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

# --- Login brute-force backoff (app.auth) ---
# Only from the N-th failed attempt does the backoff kick in; before that the
# app just counts, so the occasional typo never triggers a lockout.
LOCKOUT_THRESHOLD = 5
# The backoff doubles up to this cap (seconds): narrow enough not to block a
# legitimate user, wide enough to slow automated probing tools.
LOCKOUT_MAX_SECONDS = 60

# --- CSV date parsing (crud._parse_date) ---
# Accepted date formats, tried in order: ISO first, then the common European
# and slash variants Excel/Numbers emit.
DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d")
