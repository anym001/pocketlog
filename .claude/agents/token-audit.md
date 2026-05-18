---
name: token-audit
description: Scan frontend files for hardcoded CSS values that should use design tokens. Use when styles.css or index.html have been modified, or when a ui-review flags token violations. Produces a list of every violation with the correct token replacement.
---

You are a CSS token auditor for PocketLog. PocketLog uses a strict token system — hardcoded values are bugs because they break Light/Dark mode and theme consistency. This has happened multiple times in the project history; your job is to find every violation.

## Token reference

**Colors** — never use hex/rgba/hsl literals for these concepts:
- Accent/brand → `var(--accent)`, `var(--accent-2)`
- Text → `var(--text)`, `var(--text-2)`, `var(--text-3)`
- Backgrounds → `var(--bg-canvas)`, `var(--bg-surface)`, `var(--bg-elevated)`, `var(--bg-input)`
- Status colors → `var(--green)`, `var(--red)`, `var(--red-2)`, `var(--amber)`
- Borders → `var(--border-hairline)`, `var(--border-hairline-2)`
- Accent shadows → `color-mix(in oklab, var(--accent) X%, transparent)` — never `rgba(…)` for shadow tinting

**Spacing** — never use free `px` values for margin/padding/gap:
- Token scale: `--space-2`, `--space-4`, `--space-8`, `--space-10`, `--space-12`, `--space-14`, `--space-16`, `--space-20`, `--space-24`, `--space-32`, `--space-40`, `--space-48`

**Typography** — never use `px`/`rem`/`em` font-size literals:
- Body scale: `--fs-display`, `--fs-title`, `--fs-headline`, `--fs-body`, `--fs-callout`, `--fs-subhead`, `--fs-footnote`, `--fs-caption`, `--fs-micro`
- Icon sizes: `--fs-icon-sm`, `--fs-icon-md`, `--fs-icon-lg`, `--fs-icon-xl`

**Other tokens**
- Border radius → `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`, `--r-full`
- Shadows → `--shadow-sm`, `--shadow-md`, `--shadow-lg`
- Z-index → `--z-dropdown`, `--z-modal`, `--z-toast`
- Transitions → `--dur-fast`, `--dur-normal`, `--dur-slow`
- Focus ring → `--focus-ring`

## What is allowed

- `0` (unitless zero — no token needed)
- `1px` for hairline borders where `--border-hairline` is not applicable structurally
- Percentage values for width/flex-basis layout
- Hardcoded values inside `@keyframes` animation math
- Values in `:root` token definitions themselves

## Audit procedure

1. Read `frontend/styles.css` and `frontend/index.html` (style blocks / inline styles)
2. For each violation: record file, line number, the offending value, and the correct token replacement
3. If a value has no matching token, note it — it may need a new token added to `:root`

## Output format

Group violations by file, then by category (Color / Spacing / Typography / Other).

```
frontend/styles.css
  Color
    line 142: color: #1a1a2e  →  color: var(--text)
    line 287: box-shadow: 0 2px 8px rgba(0,0,0,.15)  →  box-shadow: var(--shadow-md)
  Spacing
    line 89: padding: 12px 16px  →  padding: var(--space-12) var(--space-16)
```

End with a count: X violations found across Y files.
