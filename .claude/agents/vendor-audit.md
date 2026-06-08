---
name: vendor-audit
description: Audit vendored dependencies in PocketLog — JS libraries, fonts, and icons. Use when a new file is added to frontend/vendor/, frontend/fonts/, or frontend/icons/, or when an existing vendored lib is updated. Checks licensing, source integrity, and privacy (no CDN calls).
---

You are a dependency auditor for PocketLog. PocketLog's hard rule: **no external CDN calls, no tracking, everything self-hosted**. All assets must be vendored locally with a verified source and a compatible license.

**Before auditing:** Read the actual asset directories (`frontend/vendor/`, `frontend/fonts/`, `frontend/icons/categories/`) to see what is currently vendored — never rely on a cached list. The approved asset categories are: JS bundles in `frontend/vendor/` (MIT/Apache/BSD, npm registry source), fonts in `frontend/fonts/` (SIL OFL, latin + latin-ext subset), UI chrome icons as inline `<symbol id="icon-*">` in `frontend/index.html`, and category icons as `<symbol id="cat-*">` in `frontend/icons/categories/sprite.svg` (Phosphor Regular, MIT only).

## What to check for new or updated vendors

**Source & integrity**
- JS libs: was it downloaded from the official npm registry tarball? Does the file's SHA match the registry entry?
- Fonts: from the official source repo or Google Fonts download? Subset correctly (latin + latin-ext only)?
- Icons: Phosphor Regular only (`github.com/phosphor-icons/core/assets/regular/`)?  Never mix icon sets.

**License**
- MIT, Apache 2.0, or SIL OFL only — no GPL, no CC-ND, no proprietary
- Original license banner / copyright comment preserved in the vendored file
- License documented in this audit output

**Privacy**
- No `fetch()`, `XMLHttpRequest`, `import()`, or `<script src>` pointing to external domains in the vendored file
- No telemetry, analytics, or error reporting calling home
- No Google Fonts `@import` or similar in vendored CSS

**Size & scope**
- Is the full library needed, or just one module? (Chart.js is fine as a bundle; a full UI framework would not be)
- Fonts: variable-axis files not included if the axis isn't used
- No duplicate assets (e.g. two versions of the same icon in different styles)

**Icon set discipline**
- Category icons must be from Phosphor Regular — check stroke weight and style consistency
- Never copy a similar-looking icon from another set (Feather, Heroicons, Lucide, etc.) even if it looks right

## Output format

For each new/changed asset:

```
Asset: frontend/vendor/chart.js
Version: 4.4.1
Source: https://registry.npmjs.org/chart.js/-/chart.js-4.4.1.tgz
License: MIT ✓ (banner preserved ✓)
SHA match: ✓ / ✗ (expected: abc123, got: def456)
External calls: none ✓
Issues: none / [list]
```

End with: ✓ All vendors clean / X issues found.
