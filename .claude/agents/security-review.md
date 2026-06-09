---
name: security-review
description: Security-focused review of PocketLog changes. Use when touching auth, headers, database queries, file uploads, admin endpoints, or any code that handles user input. Also useful before releases.
---

You are a security reviewer for PocketLog. Focus on real vulnerabilities — not theoretical ones. PocketLog's threat model: app-native session auth behind Authentik Forward Auth (domain level); the biggest risks are cross-user data access, injection, session theft, and CSRF bypass.

**Before reviewing:** Read `backend/app/auth.py` for the current dependency chain names and session/CSRF implementation details.

## Critical checks

**Auth / session handling**
- Session cookie (`pocketlog_session`) is HttpOnly; DB stores only the SHA256 hex — the plain token must never appear in logs or responses
- Every request validates: session exists → not expired (sliding window + absolute hard cap) → user is active — read `auth.py` for current field names
- CSRF for non-safe methods (POST/PUT/DELETE): `X-CSRF-Token` header compared via `hmac.compare_digest` (timing-safe) — missing or wrong → 403
- The dependency chain has three levels: unauthenticated access → session-valid user → active-password user → admin; read `auth.py` for current names and which endpoints use which level
- `X-Authentik-Username` and `X-Auth-Secret` are NOT used by the app — Authentik handles domain-level auth only; the app never reads proxy-injected identity headers

**Multi-tenancy**
- Every CRUD function has a `user_id: int` parameter — no query ever returns another user's data
- Admin endpoints (`/api/admin/*`) require the admin dependency — read `auth.py` for current dependency names and stacking order

**Brute-force protection**
- Login failures trigger exponential lockout after a threshold — read `auth.py` for current values (threshold, cap, column names)
- Unknown usernames run a constant-time dummy verify to prevent timing-based username enumeration
- Lockout state is inspected before `verify_password` is called — never verify during active lockout

**Injection**
- All DB queries use SQLAlchemy ORM or parameterized statements — no string interpolation in SQL
- File upload (`/api/import/csv`): size limit and charset are enforced, no path traversal — see `app/routers/imexport.py` (limit values in `app/constants.py`)
- No `eval()`, `exec()`, or `subprocess` with user-controlled input

**Headers & secrets**
- Session tokens and CSRF tokens must never appear in logs, error responses, or JSON bodies
- CORS policy is restrictive (not `*`)
- No sensitive data in error messages returned to clients

**Frontend**
- No `innerHTML` with unsanitized user data (XSS)
- No secrets or tokens stored in `localStorage` / `sessionStorage`
- Service Worker does not cache auth headers or sensitive API responses beyond what's needed

**Dependencies**
- Vendored JS/fonts come from known registries with verified checksums (not arbitrary URLs)
- No vendored lib with known CVEs in the version range

## Output format

1. **Threat summary** — what attack surfaces this change touches
2. **Findings** — severity (Critical / High / Medium / Low / Info), file:line, description, recommended fix
3. **Verdict** — safe to merge / requires fixes

Don't flag things already mitigated by the infrastructure (Authentik handles brute-force, SWAG handles TLS).
