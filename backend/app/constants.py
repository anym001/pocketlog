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

# --- JSON backup (app.routers.imexport, crud.backup) ---
# Upload hard cap for a backup file. Larger than the CSV cap because a full
# JSON backup carries every domain object, but still bounded so a rogue
# upload can't exhaust the worker's RAM (enforced chunk-wise before the body
# is buffered — see routers.imexport._read_upload_limited).
MAX_BACKUP_BYTES = 20 * 1024 * 1024  # 20 MB
# Per-list caps inside a backup file. Transactions dominate any real ledger
# (50k ≈ decades of household bookings); the other domains are structurally
# small. Enforced by the BackupFile schema so a crafted file fails validation
# instead of turning into a minute-long insert loop.
MAX_BACKUP_TRANSACTIONS = 50_000
MAX_BACKUP_ITEMS = 1_000
MAX_BACKUP_TAGS = 5_000

# --- Per-IP login throttle (app.rate_limit) ---
# Complements the per-user lockout above: counts failed logins per source IP
# so distributing guesses across usernames doesn't dodge the backoff. The
# threshold is deliberately higher than LOCKOUT_THRESHOLD — a household
# behind one NAT/proxy IP shares this budget, so honest typos across several
# family devices must never trip it before the per-user lockout does.
IP_LOCKOUT_THRESHOLD = 20
# Backoff doubles per failure beyond the threshold, capped here (seconds).
IP_LOCKOUT_MAX_SECONDS = 600
# A failure this old (seconds) no longer counts — the window resets.
IP_FAILURE_WINDOW_SECONDS = 900

# --- CSV date parsing (crud._parse_date) ---
# Accepted date formats, tried in order: ISO first, then the common European
# and slash variants Excel/Numbers emit.
DATE_FORMATS = ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%Y/%m/%d")
