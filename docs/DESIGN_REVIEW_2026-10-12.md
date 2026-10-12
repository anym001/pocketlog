# Design Review — holistic UI & usability pass

**Date:** 2026-10-12
**Scope:** the whole frontend, checked as one product, not file by file. Screens were captured from a running local build with demo data: iPhone 390 × 844 in light and dark, and desktop 1280 × 800. The run covered the ledger, category view, goals, budgets, recurring rules, all six reports, the booking modal, the drawer and every settings sub-panel.

| File | Lines |
|---|---|
| `frontend/index.html` | 2044 |
| `frontend/styles.css` | 4474 |
| `frontend/ledger.js` · `categories.js` · `recurring.js` · `goals.js` · `budgets.js` · `reports.js` · `settings.js` · `core.js` | 6713 |

**Basis:** [`DESIGN_CONVENTIONS.md`](../DESIGN_CONVENTIONS.md), Apple HIG, WCAG 2.2, [`CLAUDE.md`](../CLAUDE.md)

> Checkboxes to tick off while working through this. Order follows priority (critical → polish).

**Acceptance for every item:** the code is changed, and a browser check passes in light mode, dark mode and keyboard-only (Tab / Enter / Esc) at 390 px and ≥ 768 px. Each item also lists its own specific criterion.

Written in English per `CLAUDE.md` → Conventions → Language.

---

## Overall impression

The foundation is strong. Tokens, materials, the dark palette, the CSP-safe event wiring, live regions, focus trapping and chart summaries are already better than in most PWAs. Most findings are **inconsistencies between the views**, not broken components. Each feature (ledger, goals, budgets, recurring, reports, settings) was built cleanly on its own, but each made slightly different choices: titles, the "create" action, amount typography, signs, date formats and icon styles. Unifying these few patterns brings the biggest gain in how cohesive the app feels.

The three cross-cutting patterns worth fixing as *systems* rather than as single spots:

1. **View scaffold:** each view should have the same title, primary action and bottom bar (#4, #5).
2. **Money display:** one rule for typeface, sign and colour (#3, #9, #10).
3. **Entity look:** a category should look the same everywhere, and navigation should look different from data (#11, #12).

---

## Critical

### [ ] 1. Bookings without a description render as an empty row
**Where:** `ledger.js` `renderList()` (`const note = (t.desc || '').trim()` → `.t-note`); the category name is only in `.visually-hidden`.
**Problem:** Materialised recurring bookings and quick entries have no description. Their row shows only an icon, the recurring badge and an amount, with no text at all (verified: "Miete" rule → blank row on 1 Sep / 1 Jan). Sighted users cannot tell what the booking is.
**Fix:** Fall back in this order: description → source rule name → category name. Show the category name as a quiet second line (this also helps #2):
```js
const rule = t.source_rule_id && appState.recurring?.rules?.find((r) => r.id === t.source_rule_id);
const title = note || rule?.name || cat.name;
// …
<span class="t-note">${_escText(title)}</span>
<span class="t-meta">${_escText(cat.name)}</span>   // caption, --text3; omit when title === cat.name
```
Also use `title` in `tx.editAria` / `tx.selectAria`, and drop the now-redundant `.visually-hidden` category span.
**Criterion:** no ledger row, report "largest bookings" row or search hit renders without visible text.

---

## High

### [ ] 2. The ledger's primary text uses the smallest type step
**Where:** `styles.css` `.t-note { font-size: var(--fs-micro) }` (12 px).
**Problem:** The booking description is the primary content of the main screen, but it uses the same size as tag pills. The category view (`.cat-view-name`), goals, budgets and recurring all use `--fs-callout`/`--fs-body` for their row titles. The hierarchy is inverted, and the text is hard to read on an iPhone held at arm's length.
**Fix:** `.t-note { font-size: var(--fs-callout); }`, plus the new `.t-meta { font-size: var(--fs-caption); color: var(--text3); }` from #1. Tags stay `--fs-micro`.
**Criterion:** at 390 px, ledger row titles match category-view row titles in size. Rows with tags stay ≤ 3 lines.

### [ ] 3. Direction is signalled by colour only, and signs are inconsistent across views
**Where:** `ledger.js:286` (`fmtCurrency(Math.abs(…))`), `ledger.js:351`, `recurring.js:161`, `reports.js` (trend shows `-977,81 €` with an ASCII hyphen), `i18n` `tx.editAria`.
**Problem:**
- `DESIGN_CONVENTIONS.md` → *Colour is never the only signal*: income and expenses should carry `+`/`−`. The code comments deliberately drop the sign everywhere, which contradicts the convention. For colour-blind users, the clay (`--accent`) and olive (`--green`) amounts differ mainly in hue.
- The trend report is the only view that shows expenses as negative numbers, using U+002D instead of U+2212.
- Screen readers hear "Buchung bearbeiten: Spotify, 28,92 €" with no direction at all.

**Fix:** One helper in `utils.js` used by every list row:
```js
// Pure: sign + absolute amount, typographic minus (U+2212).
function fmtSignedCurrency(amount, type) {
  return (type === 'out' ? '−' : '+') + ' ' + fmtCurrency(Math.abs(amount));
}
```
Use it on list rows (ledger, category view, recurring, report lists). Keep unsigned values only where a label already says the direction (summary cards "Ausgaben"/"Einnahmen"). Add `{type}` to `tx.editAria` / `tx.selectAria` ("Ausgabe, 28,92 €"). The trend's negative axis should use `−`. If the team deliberately prefers no signs, update `DESIGN_CONVENTIONS.md` instead and add a non-colour cue (for example a small ↗/↘ glyph). Either way, convention and code must agree.
**Criterion:** a greyscale screenshot of the ledger still distinguishes income from expenses. VoiceOver announces the direction.

### [ ] 4. Main views have no title; only reports do
**Where:** `index.html:1020–1113` (`#panel-transactions`, `-categories`, `-goals`, `-budgets`, `-recurring`); reports use `.report-title` + `.report-subtitle`.
**Problem:** On iPhone, the ledger and the category view look identical at the top (month nav + summary cards). Goals, budgets and recurring show an empty header with only ☰ and the sync dot. Users can only tell where they are from the content. There is also no heading for screen-reader heading navigation (only a hidden `<h1>`). The reports' large serif title shows the right pattern, but it is used only there.
**Fix:** Give every panel the same large-title scaffold, reusing the report classes:
```html
<header class="view-head">
  <h2 class="report-title" data-i18n="nav.goals">Ziele</h2>
  <p class="report-subtitle" id="goalsSubtitle"></p>   <!-- e.g. "2 aktiv · 79 % gespart" -->
</header>
```
On the ledger and category view, place it below the summary cards, or keep it compact (`--fs-title-sm`). Give the subtitle real information, never the title repeated.
**Criterion:** every view has a visible `<h2>` with the same position, font and spacing.

### [ ] 5. "Create" works differently in every view
**Where:** `.goals-toolbar > .save-btn` in goals/budgets/recurring; settings → categories/tags use the same full-width white button; the FAB exists only on the ledger and category view (`body.on-goals .bottom-bar { display: none }`, `styles.css:1321`).
**Problem:** There are three patterns for one intent: FAB (+), a full-width white button at the top, and none at all in reports. The white button reuses `.save-btn`, looks like an inert card and spends the most valuable vertical space on a rare action. When the bottom bar disappears, the floating chrome also jumps between views.
**Fix:** Keep the bottom bar on all list views and make the FAB context-aware. Search appears only where it applies:

| View | FAB action | Search field |
|---|---|---|
| Ledger, Categories | New booking | visible |
| Goals | New goal | hidden (FAB alone, right-aligned) |
| Budgets | New budget | hidden |
| Recurring | New rule | hidden |
| Reports | New booking | hidden |

```js
// core.js — single source, called from showPanel()
const FAB_ACTIONS = { goals: 'openGoalModal', budgets: 'openBudgetModal', recurring: 'openRecurringModal' };
```
Update the FAB's `aria-label` per view ("Ziel erstellen"). The settings panels (categories, tags) keep an inline "add" row as the first row of the grouped list, styled like iOS "＋ Kategorie hinzufügen" in `--accent` text, not as a separate card button.
**Criterion:** on every list view, the primary create action sits in the same screen position with the same look.

### [x] 6. Category view: tap and ⋮ do the opposite of what users expect
> **Decision 2026-10-12 (product owner):** the row keeps booking into its category, because the view is a quick-entry launcher. Only the ⋮ glyph is replaced by the receipt glyph ("show bookings"), shipped in #247. The swap proposed below is **not** done.
**Where:** `categories.js` `renderCategoryView()` — the row's `data-action="openModalForCategory"` and `.cat-view-more` (⋮) → `showTransactionsForCategory`.
**Problem:** Tapping a category opens a *new booking*, and the ⋮ "more" glyph opens a *transaction list*. A vertical ellipsis universally means "more actions" (a menu). Drilling into a list row means "show me what's inside". Users will create accidental bookings.
**Fix:** Swap the two. Row tap → filtered transactions (drill-down, show a `chevron-right`). The trailing button becomes a `+` icon with `aria-label="Buchung in „{name}" anlegen"`. Swap the two i18n aria keys accordingly.
**Criterion:** no ⋮ glyph remains that doesn't open a menu. Tapping a row never creates data.

### [ ] 7. Settings are squeezed into the 260 px sidebar on tablet/desktop
**Where:** `.drawer` at ≥ 768 px (`--app-sidebar-width: 260px`); all settings sub-panels render inside it.
**Problem:** Desktop screenshots show session cards wrapping into four lines next to a squeezed red "Abmelden" button. The API-key list, user admin and the backup text face the same squeeze, while ~1000 px of content pane sit next to them showing the ledger. This feels like a phone UI on a big screen.
**Fix:** Use the iPad Settings split pattern. At ≥ 768 px, the sidebar keeps the *settings list*, and the selected sub-panel renders in the content pane (move the panel DOM node, or mirror it into a `#panel-settings` container). Mobile stays unchanged. `DESIGN_CONVENTIONS.md` → Adaptive Layout needs one paragraph for this.
**Criterion:** at 1280 px, no settings sub-panel wraps a label onto more than two lines.

---

## Medium

### [ ] 8. Amounts use two typefaces depending on the view
**Where:** `.t-amount` (DM Serif Display), report lists (serif) vs `.cat-view-amount`, `.recurring-card-amount`, goal/budget amounts and the forecast table (DM Sans 600).
**Problem:** "Content first: DM Serif Display dominant for amounts" holds on the ledger but not on the category view, the recurring cards or the goal/budget cards. The same 977,50 € looks different on two adjacent screens.
**Fix:** Add one rule: a **standalone amount at the end of a row** = `font-family: var(--font-display); font-size: var(--fs-headline); font-variant-numeric: tabular-nums`. An **amount inside a sentence** ("2.376,64 € von 3.000,00 €", table cells) stays DM Sans. Extract it as a `.amount` utility class and apply it to `.cat-view-amount` and `.recurring-card-amount`.
**Criterion:** row-end amounts look identical across the ledger, category view, recurring and reports.

### [ ] 9. Recurring expenses use the destructive red
**Where:** `styles.css` `.recurring-card-amount.out { color: var(--red); }`.
**Problem:** Every other view uses `--accent` (clay) for expenses. `--red` is reserved for destructive actions. The recurring list therefore reads as an alarm.
**Fix:** `color: var(--accent);`
**Criterion:** expense colour is identical across all views.

### [ ] 10. A category looks different in lists and in settings
**Where:** `.t-icon`, `.cat-view-icon` (tinted tile, coloured glyph) vs settings → Kategorien rows (solid tile, white glyph — the drawer-nav style).
**Problem:** The same entity has two visual identities. The solid style is also what the drawer uses for *navigation*, so the category list in settings reads like a menu.
**Fix:** Use the tinted `--cat-color` tile everywhere a category is shown. Reserve solid tiles for navigation chrome (drawer).
**Criterion:** a category's tile is pixel-identical in the ledger, the category view, the chooser and settings.

### [ ] 11. Drawer icons: colours carry no meaning, and one glyph is used twice
**Where:** `index.html:383–411` (`--nav-icon-bg` blue/green/blue/green/accent/accent/text3); Budgets and Auswertungen both use `#icon-chart-bar`.
**Problem:** The colours alternate arbitrarily, and two entries share an icon. Both weaken recognition, which matters most in a menu that is the only navigation.
**Fix:** Give each entry its own glyph (Budgets → `gauge` or `wallet`, Phosphor Regular). Colour either by group (data views one hue, planning one hue, reports/settings neutral) or make all tiles one neutral hue. Then update the token comment.
**Criterion:** no duplicate glyph in the drawer, and the colour rule is documented in one sentence in `DESIGN_CONVENTIONS.md`.

### [ ] 12. Navigation labels are long, unparallel and collide with settings
**Where:** `i18n` `nav.categories` = „Kategorienübersicht", `nav.transactions` = „Buchungsübersicht"; settings has „Kategorien" too.
**Problem:** Two compound "…übersicht" labels sit next to short ones („Ziele", „Budgets"). „Kategorien" also means two different things (statistics view vs management).
**Fix:** Drawer: „Buchungen", „Kategorien". Settings entry: „Kategorien verwalten". Mirror the change in `en.json` and run `copy-review`.
**Criterion:** all drawer labels are a single noun.

### [ ] 13. Four different date formats
**Where:** ledger day header „Samstag, 10. Oktober 2026"; report lists „03.10.2026"; recurring „1. Nov. 2026"; sessions „12.10.2026".
**Problem:** Each module formats dates itself (`_recurringFormatDate`, inline `split('-')` in `reports.js:143/389/1386`).
**Fix:** Add three pure helpers in `utils.js` (unit-tested): `fmtDateLong` (day headers: „Samstag, 10. Okt.", year only when ≠ current year), `fmtDateMedium` („10. Okt. 2026", for lists and cards) and `fmtDateShort` (numeric, tables only). Replace all ad-hoc formatting.
**Criterion:** `grep "split('-')" frontend/*.js` finds no display-formatting call sites.

### [ ] 14. Trend uses a different period control than the other reports
**Where:** `reports.js` trend: „Von 2026 / Bis 2026" year selects; all other reports use Monat/Quartal/Jahr/Eigen + stepper.
**Problem:** The reports are one family, so they need one way to pick time.
**Fix:** Reuse the shared range control. Restrict it to `Jahr` + `Eigen` (multi-month) for the trend, but keep the same component and position.
**Criterion:** all six reports show the range control at the same y-position with the same look.

### [ ] 15. Breakdown: two segmented controls squeezed into one row
**Where:** `reports.js` breakdown header (Kategorien/Tags + Ausgaben/Einnahmen).
**Problem:** At 390 px the second control touches the card edge („Einnahmen" clipped against the padding), and four similar pills side by side are hard to parse.
**Fix:** Stack them, each at full width with `gap: var(--space-8)`, or turn the type toggle into the donut centre label as a tappable switch.
**Criterion:** no segment label touches the card padding at 360 px.

### [ ] 16. The bottom search bar is too transparent over list content
**Where:** `.search-wrap` (`--glass-thin`), visible in the ledger screenshots: „Geschenk Mama 127,50 €" shows through behind the placeholder.
**Problem:** Overlapping text reduces legibility of both layers. The blur radius alone doesn't suppress high-contrast serif amounts.
**Fix:** Raise the `--glass-thin` alpha (≈ 0.82 light / 0.78 dark) or switch the strip to `--glass-chrome`. Check WCAG 4.5 : 1 for the placeholder (`--text3`) over the worst case (a red amount underneath).
**Criterion:** the placeholder stays readable with any row scrolled underneath, in both themes.

### [ ] 17. Search shows two clear buttons, one in system blue
**Where:** `#searchInput` (`type="search"` native ×, rendered blue) + the custom X cancel button.
**Problem:** There are two × glyphs side by side with different meanings (clear vs leave search), and the native one is off-palette. `DESIGN_CONVENTIONS.md` asks for a text „Abbrechen" button on the right.
**Fix:** Tint the native cancel to `--text3` (`::-webkit-search-cancel-button` with a mask from the sprite), and change the custom button to the text „Abbrechen" (`--accent`), as in iOS.
**Criterion:** while searching, exactly one × is visible, and no system-blue colour remains.

### [ ] 18. Settings pickers have no affordance
**Where:** `.settings-select` (`appearance: none`, no indicator), settings → Allgemein.
**Problem:** „System", „Buchungsübersicht" and „EUR – €" look like static white cards. Nothing says "tap to change".
**Fix:** Add a trailing `chevron-up-down` glyph (iOS pop-up button), either as a background mask or a sibling `<svg>`, coloured `--text3`.
**Criterion:** every select shows a trailing indicator.

### [ ] 19. The sync status is a coloured dot only
**Where:** `.sync-dot` (`.syncing` pulse, `.error` colour), `index.html:983`.
**Problem:** Screen readers are covered (`syncAriaLive`), but sighted users get only green vs red/grey. The meaning of a lone green dot is also not discoverable.
**Fix:** Change the shape with the state: `check` (synced) / `arrows-clockwise` spinning (syncing) / `cloud-slash` (offline) / `warning` (error), 14 px, inheriting the existing colours.
**Criterion:** the four states are distinguishable in a greyscale screenshot.

### [ ] 20. Import/Export and Account are stacks of equal buttons
**Where:** settings → Import/Export, Konto.
**Problem:** Five or six full-width white buttons of equal weight, without icons or grouping, unlike the grouped list rows used in the other settings panels. „Abmelden" (logout) looks the same as „Passwort ändern".
**Fix:** Use grouped list rows with a leading icon and an optional caption: Export (CSV, Backup) / Import (CSV…, Backup wiederherstellen…, Beispieldatei). Show „Abmelden" as its own group in `--red` text, as in iOS Settings.
**Criterion:** all settings sub-panels use the same row component.

### [ ] 26. Report KPI cards clip five-digit amounts on narrow phones
**Where:** `styles.css` `.report-kpis` (3 equal columns) + `.report-kpis .summary-card .amount` (`--fs-headline`).
**Problem:** Found while doing phase 1. At 360 px, year totals such as „14.019,68 €" are cut off at the card edge, signed or not. A container-query shrink (`min(--fs-headline, 17cqi)`) fixed the clipping, but it also shrank ordinary amounts at 390 px from 18 to 14.5 px, so it was reverted.
**Fix:** Change the layout, not the type size. Below ~380 px, put Einnahmen + Ausgaben on the first row and the Bilanz card at full width on the second (`grid-template-columns: 1fr 1fr` with `.summary-card:last-child { grid-column: 1 / -1 }`). Alternatively, drop the `€` symbol in the KPI cards and keep the currency in the label.
**Criterion:** at 320 / 360 / 390 px, `−12.345,67 €` fits without clipping, and amounts stay at `--fs-headline`.

---

## Low / polish

### [ ] 21. The Info panel shows developer diagnostics to every user
**Where:** settings → Info (viewport, screen, pixel density, zoom, physical px, input capabilities).
**Fix:** Keep versions and connection status visible. Move device and display details into a collapsed „Diagnose" `<details>` group.
**Criterion:** by default the panel fits on one iPhone screen.

### [ ] 22. Budgets show a period but cannot browse past periods
**Where:** budget cards show „Oktober 2026"; the budgets view has no period stepper.
**Fix (assumption, confirm with the user):** reuse the header month nav on the budgets view so last month's consumption can be checked.
**Criterion:** past periods are viewable without a report.

### [ ] 23. Wide screens: goal and budget cards stretch to ~1700 px
**Where:** ≥ 1024 px, goals/budgets/recurring.
**Problem:** Progress bars 1500 px wide are hard to compare. Content-width doctrine (no caps) is fine for lists, but these are *cards*.
**Fix (convention change):** `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))` for card views ≥ 1024 px. Document this as the one exception in "Content Width".
**Criterion:** at 1920 px, at least two cards sit side by side.

### [ ] 24. The course chart is hard to read for a single month
**Where:** reports → Verlauf, month range.
**Problem:** 31 thin bars with rotated labels; one salary spike dominates the scale.
**Fix:** For month ranges, use cumulative lines (income vs expense, running total) or weekly buckets, and turn off label rotation (`maxRotation: 0`, `autoSkip`).
**Criterion:** no rotated axis labels at 390 px.

### [ ] 25. The tag list in settings has no metadata and no edit affordance
**Where:** settings → Tags.
**Fix:** Show the 90-day `count` (already delivered by `GET /api/tags`) as trailing `--text3` text, plus a chevron, consistent with other drill-in rows.
**Criterion:** every tag row shows its count and a chevron.

---

## Strategic decision (not a defect): primary navigation on iPhone

All main destinations sit behind ☰. Switching between Buchungen → Ziele → Budgets costs two taps plus a drawer animation each time, and the drawer mixes destinations, a sub-menu (Auswertungen) and settings.

| Option | Pros | Cons |
|---|---|---|
| **A. Keep the drawer, polish it** (#11, #12, title from #4) | No convention change, smallest diff | Destinations stay hidden; frequent switching stays slow |
| **B. Tab bar: Buchungen · Kategorien · Planen (Ziele/Budgets/Wiederkehrend as segments) · Auswertungen, plus FAB** | HIG standard for ≤ 5 destinations, one tap, always visible location | Bottom bar redesign; search moves to the top of the ledger (HIG default); conventions must be rewritten; extra vertical chrome |
| **C. Drawer + "recent" switcher** (long-press on the title) | Small change | Not discoverable; non-standard |

**Recommendation:** do **A now** as part of phases 1–2. Revisit **B** only once #4/#5 are done and you notice yourself switching views often. B is the "right" iOS answer, but it costs a bottom-bar redesign and invalidates the documented search-at-bottom rationale. That is only worth it if the switching pain is real in daily use, and you are the best judge of that.

---

## Summary

| Priority | Count | Items |
|---|---|---|
| Critical | 1 | 1 |
| High | 6 | 2–7 |
| Medium | 14 | 8–20, 26 |
| Low | 5 | 21–25 |
| Strategic | 1 | navigation |

**Recommended order (each phase = one PR against `dev`):**

1. **Ledger readability:** #1, #2, #3 (`fmtSignedCurrency`, row title + meta line). Highest daily impact, small diff, mostly `ledger.js` + `utils.js` + Vitest.
2. **View scaffold:** #4, #5, #6. Shared title + context FAB. Touches `index.html`, `core.js`, `styles.css`; run `ui-review` + `copy-review`.
3. **Visual system:** #8, #9, #10, #11, #12, #13. Amount rule, colours, category tile, nav icons and labels, date helpers. Update `DESIGN_CONVENTIONS.md` in the same PR.
4. **Controls & chrome:** #14–#19, #26.
5. **Settings:** #7, #20, #21, #25 (desktop split view + unified rows).
6. **Polish / optional:** #22–#24, then decide the navigation question.

What is already good and must be kept: the token system, light/dark parity, the CSP event engine, live regions, focus trap, chart text summaries, offline outbox UX, the empty states and the booking modal flow.
