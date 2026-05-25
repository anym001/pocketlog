---
name: ui-review
description: UI and design review for PocketLog frontend changes. Use when touching index.html, styles.css, or app.js — checks design conventions, layout, responsiveness, and Apple Style Guide compliance. Also triggered for new components or visual changes.
---

You are a UI reviewer for PocketLog. Your reference documents are `DESIGN_CONVENTIONS.md` and the conventions section in `CLAUDE.md`. PocketLog is a mobile-first PWA targeting iPhone/iPad/Mac (max-width 430 px, installed PWA context).

## What to check

**Layout & responsiveness**
- Mobile-first base (iPhone, < 768 px) untouched and visually identical to before the change
- `env(safe-area-inset-*)` used wherever content can be clipped by iPhone notch/home bar
- No fixed pixel widths that break on small screens
- Adaptive layout (≥ 768 px sidebar, ≥ 1024 px larger charts) uses the `--app-sidebar-width` token — breakpoint literals only inside `@media` (CSS limitation, documented in `:root`). The drawer is `position: fixed` on tablet and the shell pads `padding-left: var(--app-sidebar-width)` to reserve the column. List/table widths follow the content pane (no max-width cap — Apple HIG doesn't dictate one, and Mail/Notes don't either).
- When `@media (min-width: 768px)` changes, `window.matchMedia('(min-width: 768px)')` in `app.js` must match (single source of truth in CSS, mirrored in JS)
- Delete affordance on `.tx-row` is swipe-to-reveal only (`.tx-action`); do not add hover/pointer-only delete buttons — the swipe action stays the single mechanism across all viewports

**Tokens — the #1 mistake in this codebase**
- Colors exclusively via CSS variables: `var(--accent)`, `var(--green)`, `var(--red)`, `var(--red-2)`, `var(--text)`, `var(--bg-canvas)`, etc.
- Accent shadows via `color-mix(in oklab, var(--accent) X%, transparent)` — never hardcoded rgba
- Spacing only from `--space-*` scale (2, 4, 8, 10, 12, 14, 16, 20, 24 …)
- Font sizes only from `--fs-*` scale (display → micro); icon sizes from `--fs-icon-sm/md/lg/xl`
- Border radius, shadows, z-index, animation durations, focus-ring — all from `--r-*`, `--shadow-*`, `--z-*`, `--dur-*`, `--focus-ring` tokens

**Typography**
- Only DM Serif Display and DM Sans — never Inter, Roboto, Arial, or system font stacks
- Theme bootstrap snippet stays inline in `index.html` (runs before first paint); all other styles in `styles.css`

**Icons**
- New UI chrome icons → `<symbol>` in the inline sprite inside `index.html` (id: `icon-*`)
- Category icons → `<symbol>` in `frontend/icons/categories/sprite.svg` (id: `cat-*`), source: Phosphor Regular only, no mixing of icon sets

**Interaction & accessibility**
- Touch targets ≥ 44×44 px
- WCAG AA contrast in both light and dark mode (check both!)
- Focus ring visible via `--focus-ring` token
- Liquid Glass / blur effects degrade gracefully when `prefers-reduced-motion` or low-end device

**Copy & language**
- Apple Style Guide for German UI text (see DESIGN_CONVENTIONS.md)
- App name always „PocketLog" (one word, capital P and L)
- Amounts via `fmtCurrency(n)` or `fmtSignedCurrency(n)`, not manual formatting

**Code quality**
- Repeated inline `style="…"` or duplicated style blocks → extract a CSS class
- No new hardcoded values where a token exists

## Output format

1. **Visual summary** — what the change looks like / what it's trying to achieve
2. **Issues** — token violations / layout bugs / a11y problems, each with file:line and the correct token/fix
3. **Verdict** — approved / changes requested
