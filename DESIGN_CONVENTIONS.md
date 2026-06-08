# PocketLog – Design Conventions

Applies to all UI work in the frontend (`frontend/index.html`, `frontend/styles.css`,
`frontend/app.js`, `frontend/icons/`). All visible text strings are managed through
i18n; code and comments are English (see "Language" convention in [`CLAUDE.md`](CLAUDE.md)).


## Core Principles

- **Clarity:** function before decoration, no visual noise.
- **Restraint:** the UI frames the data — transactions and amounts in the foreground.
- **Depth:** hierarchy through layers and shadows, not skeuomorphism.
- **Mobile-first:** max-width `430px`, single-column, touch targets ≥ 44×44 px.
- **Content first:** DM Serif Display dominant for amounts, DM Sans recedes.
- **Platform look on iOS:** `standalone` mode, `theme-color` = `--bg-grouped`, `apple-touch-icon` set.

## Layout & Safe Areas

Reference: [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout).

- **Container:** centred, `max-width: 430px`, horizontal padding `16px`.
- **Vertical spacing grid:** multiples of 4 (`4 / 8 / 12 / 16 / 20 / 24`)
  plus the two common iOS in-between steps `10` and `14`. Avoid spacing values
  outside this scale. The source of truth is the CSS variables `--space-N`
  in `frontend/styles.css` `:root`, where `N` equals the px value
  (`--space-8` = 8 px). Special values `--space-2` and `--space-56` are
  reserved for isolated edge cases (tag pill inner padding, empty-state padding).
- **Safe area:** `env(safe-area-inset-*)` for the top status bar, notch /
  Dynamic Island, and home indicator. Fixed-bottom elements get
  `padding-bottom: max(16px, env(safe-area-inset-bottom))`.
- **Touch targets:** minimum `44 × 44 px` for all interactive surfaces, even
  when the visual icon is smaller — enlarge via `padding`, not by setting
  `width/height` on transparent hit boxes.
- **Grouping:** bundle related elements in a card with `border-radius` and
  consistent padding. At least `16px` gap between card groups.
- **Hierarchy through size & weight, not colour.** Primary action visually
  prominent, secondary in `--text2`, tertiary in `--text3`.
- **Reading width:** body text (descriptions, hints) no wider than `60ch`.
- **Scroll behaviour:** vertical scrolling only; avoid horizontal scrolling
  (except intentionally for charts / tag rows). `overscroll-behavior-y: contain`
  on modal content.

## Visibility & the `[hidden]` Attribute

The HTML `hidden` attribute relies on the user-agent default `[hidden] { display: none }` — without `!important`. Any more specific CSS rule overrides it. Two hard rules follow:

- **When the class sets `display`** (e.g. `.auth-view { display: flex }`),
  ALWAYS add `.foo[hidden] { display: none }` as an override — otherwise
  the element remains visible despite `hidden`. Other classes such as
  `.sync-badge`, `.range-custom`, `.range-stepper`, `.trend-active-row`
  already follow this pattern.
- **When the class does NOT set `display`** and the element is shown/hidden
  via `data-state` / `class.open`, the **element must not carry a `hidden`
  attribute** — otherwise the browser default `display: none` fires, and
  transform/opacity transitions are never visible. Visibility then belongs
  entirely in the state class.
- **Rule of thumb:** per element, use either `[hidden]` AND a matching CSS
  override, OR a state class — never mix both.

Background: both variants triggered a visible bug in v0.3.x each — the
auth force-change view permanently visible (`.auth-view` had `display:flex`
without a `[hidden]` override) and the user-management drawer panel
permanently hidden (`.drawer-panel` had no `display`; JS toggled only
`data-state`, and the `hidden` attribute caused the browser to apply
`display:none`).

## Adaptive Layout (Tablet & Desktop)

Mobile-first remains doctrine. iPad and Mac are progressive enhancements
via two breakpoints — the breakpoint value lives literally in `@media`
(CSS limitation) and is documented in the `:root` comment.

- **Breakpoints:** `768px` (iPad portrait — sidebar appears), `1024px`
  (iPad landscape / Mac — only larger chart heights, **no** content-width
  changes). The iPhone path < 768 px remains unchanged.
- **Layout token:** `--app-sidebar-width` (260 px, sidebar width). There is
  intentionally **no** `--app-max-content` token — lists / tables / panels
  fill the content pane fully (see "Content Width" below).
- **App shell:** `<main class="app-shell">` wraps header, summary,
  panels, bottom bar **and** the drawer. On mobile `display: contents`
  (no visual effect). From 768 px it becomes `display: block` with
  `padding-left: var(--app-sidebar-width)`, which reserves space for the
  fixed sidebar.
- **Sidebar:** the drawer is `position: fixed; top: 0; left: 0;
  width: var(--app-sidebar-width); height: 100dvh` from 768 px, with a
  `min-height: 100vh` fallback for iPad Safari. Hamburger, drawer overlay,
  and the drawer-head close button are hidden — the "PocketLog" title in
  the drawer head stays visible as the sidebar brand. Sub-panel navigation
  (`drawerNav` / `drawerBack`) remains functional. Sub-panel state
  **persists** between open/close of the mobile drawer (the user lands in
  the last-opened sub-panel on the next hamburger tap, not at the top level).
- **Sidebar toggle (Apple Mail pattern):** A dedicated `.sidebar-toggle-btn`
  in the top-left of the header (tablet+ only). State lives as
  `html.sidebar-collapsed` and is restored from `localStorage` via an inline
  boot script in `<head>` before first paint (no flash). Two state-dependent
  icons: `arrows-out` when the sidebar is visible (click expands content),
  `arrows-in` when collapsed (click restores sidebar).
  `aria-pressed` mirrors the state.
- **Modals:** From 768 px modals switch from bottom sheet to centred card
  (`max-width: 560px`, `border-radius: var(--r-xl)` all around,
  `fadeScaleIn` keyframe). Mobile stays bottom sheet.
- **Bottom bar:** Stays floating, with a 16-px inset from both visual edges —
  left to the sidebar right edge, right to the viewport. In collapsed state
  to the viewport left. Mirrors iPhone behaviour.
- **Bottom bar clearance:** `var(--bottom-bar-clearance)` (66 px) is a layout
  constant reserved for all panels and scrollable content so nothing is obscured
  by the floating bottom bar. Apply as `padding-bottom` on scrollable containers.
- **JS guards:** `openDrawer()` / `closeDrawer()` are no-ops from 768 px.
  `body.style.overflow = 'hidden'` may still be set in modals
  (background lock is useful on desktop too). The source of truth for the
  breakpoint in JS is `window.matchMedia('(min-width: 768px)')` —
  must be updated alongside any CSS breakpoint change.
- **Hover actions:** mouse/trackpad-specific affordances appear **only**
  under `@media (hover: hover) and (pointer: fine)`. Touch devices never
  see them — swipe-to-delete remains the sole delete gesture on iPhone/iPad.
- **`:active` on list rows:** avoid for touch-relevant rows
  (`.transaction`, `.cat-view-row`). The browser triggers `:active`
  immediately on `touchstart`, causing rows to flash while scrolling.
  Visual feedback for keyboard activation goes through `.is-key-active`,
  set by `handleRowActivate()`.
- **Orientation:** the manifest no longer forces orientation. Landscape is
  permitted on iPad. Manifest changes take effect only after reinstalling the PWA.
- **Keyboard shortcuts:** `Cmd/Ctrl+N` (new transaction), `Cmd/Ctrl+F`
  (focus search), `←` / `→` (navigate months, only when no input is focused
  and no modal/drawer is open), `Esc` (close). On iPad Safari `Cmd+N` /
  `Cmd+F` only work in standalone PWA mode — the browser intercepts them
  otherwise.

### Content Width (Apple HIG Research)

> Verified via [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
> and [HIG: Split Views](https://developer.apple.com/design/human-interface-guidelines/split-views),
> as well as Apple's own apps (Mail, Notes, Files) as reference implementation.

- **Apple HIG dictates no pixel cap for lists or tables.** The general
  layout guidance is "restrict the width of text for optimal readability"
  — deliberately without a concrete pixel figure. It instead recommends
  **adaptive layout** (Auto Layout, Size Classes) that grows with available space.
- **Split Views (sidebar + content):** HIG says "secondary pane takes
  ⅔ of the screen", **no** reading-width cap. Mail, Notes, and Files let
  list rows use the full width of the secondary pane.
- **The 66-characters-per-line rule is web typography** (Bringhurst etc.)
  and applies to flowing body text — list rows with icon + short description +
  amount are not body text.
- **In PocketLog:** lists, summary cards, header top, and bottom bar use
  the full content-pane width (viewport minus sidebar, or viewport in
  collapsed state, each minus the 16-px inset for the bottom bar). The
  header top is a 3-column grid (`chrome 1fr chrome`) so the month
  navigator stays visually centred regardless of pane width.
- **Body-text caps** (modal body, empty states) remain useful — the HIG
  rationale "restrict text for readability" applies there. Currently
  PocketLog has only the centred modal (`max-width: 560px`).

## Colour & Theming

Reference: [HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color).

- **CSS variables are mandatory.** No inline hex codes — every colour goes
  through `var(--…)` from `:root` / `html[data-dark='true']`.
- **Semantic rather than raw colours.** Code references meaning
  (`--accent` for expenses, `--green` for income), not the concrete shade.
- **Light/dark via the `data-dark` attribute.** The inline boot script in
  `<head>` reads the system preference and manual override from `localStorage`
  and sets `html[data-dark='true|false']` before first paint. All dark token
  overrides live in `html[data-dark='true'] { … }` — no
  `@media (prefers-color-scheme: dark)` in component rules. JS toggle via
  `saveTheme()` in `app.js`.
- **Colour palette** (based on [html-effectiveness](https://thariqs.github.io/html-effectiveness/)
  by Thariq Shihipar):

  | Variable | Light | Dark | Meaning |
  |---|---|---|---|
  | `--bg-grouped` | `#F2F2F7` | `#0f0e0c` | Page canvas (flat, Apple grouped style) |
  | `--bg-canvas` | `#FFFFFF` | `#221e19` | Card/surface colour (sits lighter on `--bg-grouped`) |
  | `--accent` | `#D97757` (clay) | `#E8926E` | Expenses, primary action |
  | `--green` | `#788C5D` (olive) | `#9AB07A` | Income, success |
  | `--red` / `--red-2` | `#C0392B` / `#EC6B5B` | unchanged | Destructive actions (swipe-to-delete gradient) |
  | `--text` | `#141413` (slate) | `#F0EEE6` | Primary text |
  | `--text2` | `#3D3D3A` | `#B0ADA6` | Secondary text |
  | `--text3` | `#87867F` | `#87867F` | Tertiary text, hints |

- **Contrast:** minimum WCAG AA — `4.5 : 1` for body text, `3 : 1` for
  large text (≥ 18 pt regular or ≥ 14 pt bold) and for graphical elements.
  Check every new colour combination in both light *and* dark mode.
- **Per-category colour (`--cat-color`):** Category-linked cards (goals,
  recurring rules) receive `style="--cat-color: <hex>"` as an inline custom
  property set from the category's stored colour. Child elements (icon
  background, progress fill, amount badge) inherit this value. Never hardcode
  a category colour in CSS — always reference `var(--cat-color)`.
- **Colour is never the only signal.** Income/expenses additionally carry
  a `+` or `−` (U+2212). Error states carry text, not just a red border.
- **No hard black/white backgrounds.** Page canvas always `--bg-grouped`,
  cards/surfaces `--bg-canvas`, text `--text` — so light/dark look consistent.
- **Use accent colour sparingly:** at most one primary action per screen
  in `--accent` fill; all further actions as outline or plain.

## Typography

- **Typefaces:** **DM Serif Display** (amounts, large headings)
  and **DM Sans** (everything else). **Never** Inter, Roboto, Helvetica,
  Arial, or system font stacks.
- **Scale (rem-based, 1 rem = 16 px). Source of truth: the CSS custom
  properties in `frontend/styles.css` `:root`:**

  | Token      | CSS variable      | Usage                                | Size |
  |---|---|---|---|
  | `display`  | `--fs-display`    | Balance display                      | `2.25rem` (36 px), DM Serif Display |
  | `title`    | `--fs-title`      | Screen / modal title                 | `1.5rem` (24 px), DM Serif Display |
  | `title-sm` | `--fs-title-sm`   | Compact title, stat number           | `1.25rem` (20 px), DM Sans 600 |
  | `headline` | `--fs-headline`   | Card heading                         | `1.125rem` (18 px), DM Sans 600 |
  | `body`     | `--fs-body`       | Body text, form inputs               | `1rem` (16 px), DM Sans 400 |
  | `callout`  | `--fs-callout`    | Secondary buttons, labels            | `0.9375rem` (15 px), DM Sans 500 |
  | `footnote` | `--fs-footnote`   | Secondary body, small headings       | `0.875rem` (14 px), DM Sans 400 |
  | `caption`  | `--fs-caption`    | Metadata, hints                      | `0.8125rem` (13 px), DM Sans 400 |
  | `micro`    | `--fs-micro`      | Tag pills, smallest markers          | `0.75rem` (12 px), DM Sans 500 |
  | `icon-sm`  | `--fs-icon-sm`    | List glyph (cat-icon)                | `1.0625rem` (17 px) |
  | `icon-md`  | `--fs-icon-md`    | Section glyph (cat-view-icon, fab.search-exit) | `1.375rem` (22 px) |
  | `icon-lg`  | `--fs-icon-lg`    | FAB plus                             | `1.625rem` (26 px) |
  | `icon-xl`  | `--fs-icon-xl`    | Empty-state hero                     | `3.25rem` (52 px) |

- **Button tokens** (`frontend/styles.css` `:root`):

  | Variable            | Usage                                                  | Value     |
  |---|---|---|
  | `--btn-chrome-size` | Hamburger, modal back, drawer close, sync, colour swatch| `44px`    |
  | `--btn-fab-size`    | FAB, search bar height                                 | `50px`    |
  | `--btn-icon-size`   | Glyph in chrome buttons (`‹ ✕ ⌕ …`)                    | `1.25rem` |
  | `--nav-icon-size`   | Icon container in drawer navigation rows               | `30px`    |

- **Adjusting a single instance:** override the token call in the CSS block
  of the relevant class, e.g. `font-size: 1rem` locally instead of
  `var(--fs-callout)`. Global change: update only the value of the CSS
  variable in `:root`, and it applies everywhere.

- **Further central tokens** (`frontend/styles.css` `:root`):

  | Area           | Variable                       | Value / Usage |
  |---|---|---|
  | Z-layer        | `--z-toolbar`                  | `100` (sticky header) |
  |                | `--z-floating`                 | `200` (bottom bar) |
  |                | `--z-drawer-backdrop`          | `400` (drawer dimmer) |
  |                | `--z-drawer`                   | `401` (drawer panel) |
  |                | `--z-modal`                    | `500` (sheet/modal) |
  |                | `--z-picker`                   | `600` (tag picker, sits above open modals) |
  |                | `--z-toast`                    | `800` (toast / system) |
  | Animation      | `--dur-fast`                   | `0.15s` (tap feedback) |
  |                | `--dur-base`                   | `0.2s` (default) |
  |                | `--dur-medium`                 | `0.25s` (chrome buttons) |
  |                | `--dur-slow`                   | `0.3s` (panel / overlay) |
  |                | `--dur-progress`               | `0.7s` (goal/category bar width fill) |
  |                | `--dur-pulse`                  | `1.2s` (sync-dot syncing animation) |
  | Easing         | `--ease-spring`                | `cubic-bezier(0.32, 0.72, 0, 1)` — default transitions |
  |                | `--ease-bounce`                | `cubic-bezier(0.34, 1.56, 0.64, 1)` — FAB + buttons |
  |                | `--ease-soft`                  | `cubic-bezier(0.4, 0, 0.2, 1)` — fades + overlays |
  | Focus          | `--focus-ring`                 | `0 0 0 3px var(--accent-tint)` |
  | Border         | `--border-hairline`            | `0.5px solid var(--hairline-soft)` |
  |                | `--border-hairline-strong`     | `0.5px solid var(--hairline)` |

- **Line height:** `1.25` for DM Serif Display, `1.4` for DM Sans body.
- **Letter spacing:** leave at default; do not artificially widen.
- **Numeric tables:** `font-variant-numeric: tabular-nums` for columns with
  amounts, so digits align vertically.
- **Dynamic type (web equivalent):** no fixed `px` values for text — use `rem`
  or `em` so system zoom and browser font-size settings work correctly.
- **No ALL-CAPS labels.** When emphasis is needed: weight or colour.

## Materials (Blur, Vibrancy, Glass)

Reference: [HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

PocketLog combines **Apple Inset-Grouped** (flat grey canvas `--bg-grouped`,
white cards `--bg-canvas`) with **Liquid Glass** (iOS 26) for the chrome layer
and all overlay panels. Three tiers organise their use:

| Tier | Elements | Token | Blur |
|------|----------|-------|------|
| 0 – Scrims | `.drawer-overlay`, `.modal-overlay` | `--overlay-bg`, `--blur-overlay` / `--blur-dim` | light |
| 1 – Panels | `.modal`, `.drawer`, `.drawer-head`, `.drawer-sub-head` | `--glass-modal` (88 %), `--glass-drawer` (85 %) | `blur(40px) saturate(180%)` |
| 2 – Cards | `.drawer-nav`, `.search-wrap`, `.fab`, `.header`, `.toast` | `--glass-card` (90 %), `--glass-thin`, `--glass-header`, `--glass-chrome` | `blur(20px)` – `blur(40px)` |

- **Current glass elements (complete list):**
  - `.header` — frosted sticky header (`--glass-header` + `--blur-regular`)
  - `.search-wrap` + `.fab` — floating-strip bottom bar (`--glass-thin` + `--blur-regular`) + specular highlight (`--shadow-floating-strip`)
  - `.drawer-overlay` — light backdrop scrim behind the drawer (`--blur-overlay`)
  - `.modal-overlay` — backdrop scrim behind the modal (`--blur-dim`)
  - `.modal` — sheet / card modal (`--glass-modal` + `blur(40px) saturate(180%)`)
  - `.drawer` — sidebar panel (`--glass-drawer` + `blur(40px) saturate(180%)`)
  - `.drawer-head`, `.drawer-sub-head` — sticky header inside the drawer (`--glass-modal` + `blur(20px) saturate(150%)`)
  - `.drawer-nav` — card lists inside the drawer (`--glass-card` + `blur(20px)`)
  - `.toast` — ephemeral floating notification (`--glass-chrome` + `--blur-thick`)
- **When NOT to use:**
  - Simple list rows (transactions, reports), form inputs, settings rows — always `--bg-canvas` or `--bg-grouped`, no `backdrop-filter`.
  - New elements get **no** glass by default — only true floating overlays or chrome panels of the three tiers above.
- **Layering:** max. 3 levels — canvas → drawer/modal panel (tier 1) → nav card (tier 2). Do not nest tier-2 elements inside tier-1 elements that themselves use tier 2.
- **Tokens:** `--glass-modal`, `--glass-drawer`, `--glass-card` are `color-mix()` expressions over `--bg-grouped` / `--bg-canvas` and adapt to dark mode automatically. `--glass-thin`, `--glass-header`, `--glass-chrome` remain their own rgba values.
- **Fallback:** maintain both blocks in `styles.css` — `@supports not (backdrop-filter: blur(1px))` and `@media (prefers-reduced-transparency: reduce)`. There, `--glass-modal`, `--glass-drawer`, `--glass-card` are overridden with opaque equivalents (`--bg-grouped` / `--bg-canvas`).
- **Performance:** `backdrop-filter` only on static surfaces — never on scrolling lists or animated elements with many DOM neighbours.
- **Reduced transparency:** `@media (prefers-reduced-transparency: reduce)` → reset all glass tokens to opaque surfaces (already in the fallback block).

## App Icons

Reference: [HIG: App Icons](https://developer.apple.com/design/human-interface-guidelines/app-icons).

- **Location:** `frontend/icons/` — referenced in the manifest and via
  `apple-touch-icon`.
- **Required variants:**
  - `icon-192.png` (PWA, Android)
  - `icon-512.png` (PWA, splash screen)
  - `icon-maskable-512.png` (Android adaptive icon, safe zone ~ 80 %)
  - `apple-touch-icon.png` (180 × 180, iOS home screen, no transparency)
- **Design rules:**
  - **Simple:** one central shape, no fine details. Recognisable from a distance.
  - **Full-bleed:** background covers the entire square. iOS crops to squircle itself.
  - **No transparency** in `apple-touch-icon` (iOS fills transparent areas with black).
  - **No text** in the icon — unless it is an essential logo element.
  - **No photos**, no screenshots, no UI elements in the icon.
  - **Colour palette** matches the app: `--bg-canvas` surface, `--accent` as accent. Max. 3 colours.
  - **Safe zone for maskable:** central 80 % — the logo must not extend beyond this area.
- **Dark / Tinted (iOS 18+):** optionally provide a separate dark variant;
  otherwise the standard icon must also work on a dark home screen (sufficiently
  dark or neutral background).
- **Build hygiene:** PNG, sRGB, no alpha in the Apple touch icon.
  Keep the source as SVG in the repo; export PNGs from SVG.

## Icons in the UI

Reference: [HIG: Icons](https://developer.apple.com/design/human-interface-guidelines/icons).

Two icon systems, strictly separated:

- **Category icons (Phosphor Regular SVG sprite):**
  - Sprites in `frontend/icons/categories/sprite.svg` as `<symbol id="cat-…">`.
  - New icons from `github.com/phosphor-icons/core/assets/regular/` — **never**
    mix other icon sets (breaks the consistent stroke character, stroke width 1.75 px).
  - ID is stored in `categories.icon` (`VARCHAR(64)`); injected into the DOM
    on boot via `loadCategoryIconSprite()`.
  - New glyph → `<symbol>` in the sprite + entry in `CAT_ICON_GROUPS` in `app.js`.
- **UI chrome glyphs (inline SVG sprite in `index.html`):**
  - `<use href="#icon-menu|chevron-left|chevron-right|close|search|plus">`.
  - 24×24 viewport, `stroke="currentColor"` — icons inherit text colour.
  - New chrome glyph → as `<symbol id="icon-…">` in the sprite block in `index.html`.
- **Semantics:** icon without label only when universally understood (plus = new, bin = delete).
- **Accessibility:** `aria-label` with purpose, not appearance.
- **Stroke style:** outline only — no mixing.

## Toolbars / Tab Bar / Navigation Bar

Reference: [HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars).

PocketLog has **one top bar** (app title + secondary action) and **one
bottom bar** (primary actions). A single-page PWA needs nothing more.

- **Top bar:**
  - Title centred or left — apply consistently.
  - Maximum 1 secondary action on the right (e.g. settings). More go into
    an overflow menu ("…").
  - Height: `56px` + safe-area top.
  - Background: opaque `--bg-canvas` or Liquid Glass (see above) — not
    transparent without a material.
- **Bottom bar (tab bar):**
  - Maximum 5 tabs / actions, each with icon **and** label. Icon alone
    only for the central primary action ("+").
  - Active tab visually distinct (colour + indicator), not colour alone.
  - Fixed with `position: fixed; bottom: 0`; content below needs
    `padding-bottom` so nothing is obscured.
- **Order:**
  - Top bar: left navigation/back, centre title, right action.
  - Bottom bar: most frequent action in the centre, navigation tabs outside.
- **Action density:** primary action (e.g. "Add transaction") never hidden
  in a menu. Infrequent actions (export, settings) may go in a "…" menu.
- **Consistency:** same toolbar style on all screens — position, height,
  material identical.
- **Content scrolls under the bar.** Do not hide/show the bar on scroll
  — it disorients more than it saves space.

## Search Fields

Reference: [HIG: Search Fields](https://developer.apple.com/design/human-interface-guidelines/search-fields).

PocketLog has a search field in the bottom bar (`#searchInput`, left of the
FAB). Rules:

- **Placement:** deliberately at the bottom in the bottom bar, deviating
  from Apple's standard recommendation "top under the navigation bar".
  Rationale: thumb reach on large smartphones, spatial proximity to the
  primary action (FAB in the same floating strip), and consistent with the
  trend of Safari 15+ (URL bar at the bottom). In active search focus
  (`body.searching`), month nav and summary cards are hidden so the results
  list gets maximum space.
- **Markup:** `<input type="search">` so iOS Safari automatically renders
  the magnifier, clear button, and the correct keyboard.
- **Placeholder:** sentence case, descriptive and specific —
  use the i18n key for "Search transactions", not a vague "Search…".
- **Behaviour:** live filter from the first character, `debounce` 150 ms.
  No submit required, no explicit search button.
- **Cancel / Clear:**
  - The browser's native `×` button for `type="search"` is sufficient;
    do not render an additional custom button.
  - With an active filter, a separate "Cancel" button on the right clears
    the field and releases focus.
- **Scope / Filter:** when a category filter is needed, render it as a chip
  row **below** the field; no dropdowns inside the field itself.
- **Recent searches / suggestions:** optional as a list below the field,
  with a trash icon to delete individual entries. Store locally in
  `localStorage`, not in the backend (privacy).
- **Empty state:** when the search finds nothing, a clear message with a
  suggestion — use the i18n key for "No transactions match 'xyz'. Try a
  different spelling."
- **Accessibility:** `<label>` (visually hidden) with `for=` plus
  `aria-label` if there is no visible label. `role="search"` on the
  surrounding `<form>`.
- **Keyboard:** `enterkeyhint="search"`, `inputmode="search"`,
  `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`.

## Accessibility

Reference: [HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).

Required — no exceptions "because PWA":

- **Semantic HTML first.** `<button>` instead of `<div onclick>`,
  `<nav>`, `<main>`, `<section>`, `<h1…h3>` in correct hierarchy.
- **Icon-only buttons:** `aria-label` with purpose, not appearance.
- **Live regions:** `aria-live="polite"` for sync status,
  loading indicator, toast messages. Nothing important conveyed visually only.
- **Focus:** visible focus ring on all interactive elements
  (`:focus-visible`). Never `outline: none` without a replacement.
- **Keyboard operability:** tab order follows reading order, all
  actions reachable by keyboard, modals trap focus and restore it on close.
- **Dynamic type / zoom:** layout must not break up to `200 %` browser zoom.
  No fixed `px` heights that clip text.
- **Contrast:** `4.5 : 1` text, `3 : 1` graphics — in both light *and*
  dark mode.
- **Touch targets:** at least `44 × 44 px` — full stop.
- **Motion:** `@media (prefers-reduced-motion: reduce)` →
  transitions to `0.01ms`, no animations, no parallax.
- **Transparency:** `@media (prefers-reduced-transparency: reduce)` →
  replace material with opaque surface.
- **Colour never the only signal:** sign, icon, text supplement it.
- **Screen-reader text:** no directional references (no "button top right"),
  no "image of…", no "click here".
- **Images / charts:** charts have a text summary below them
  (total income, total expenses) that screen readers can read aloud.
- **Language:** `<html lang="de">` set correctly.

## Writing Style & Copy (Apple Style Guide)

Quick rules:
- **Sentence case:** buttons, titles, labels lowercased except proper nouns.
- **Verb-first** for action buttons: use i18n keys for "Save", "Delete" — not "OK".
- **Direct and active:** use the i18n key for "Amount invalid." — not "Invalid input."
- **No "Please" / no "Sorry"** — phrase directly.
- **Amounts** via `fmtCurrency(n)` — locale and currency come from user settings (`I18N.getLocale()` / `I18N.getCurrency()`), never hardcoded. Dates internally ISO 8601, displayed with `toLocaleDateString(I18N.getLocale())`.
- Destructive actions always paired with a "Cancel" option; dialog openers end with `…`.
- **No hardcoded inline text strings:** static text gets `data-i18n` / `data-i18n-attr`, dynamic text goes through `tr('key')`. New strings go into **both** catalogs (`i18n/de.json`, `i18n/en.json`) with matching keys.
