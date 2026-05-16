# Design-Review – PocketLog Frontend

**Datum:** 2026-05-15
**Bezug:** `frontend/index.html` (aktueller Working-Tree, inkl. unstaged Änderungen)
**Grundlage:** [`DESIGN_CONVENTIONS.md`](DESIGN_CONVENTIONS.md), Apple HIG, WCAG 2.2

Checkboxen zum Abhaken beim Bearbeiten. Reihenfolge folgt Priorität (Kritisch → Polish).

---

## Kritisch – kaputt im laufenden Code

### [x] 1. Zirkuläre Motion-Tokens

**Ort:** `frontend/index.html:123-126`

```css
--dur-fast: var(--dur-fast);
--dur-base: var(--dur-base);
--dur-medium: var(--dur-medium);
--dur-slow: var(--dur-slow);
```

Self-referencing → CSS verwirft jede `transition`/`animation`-Property, die diese
Tokens verwendet. Betrifft Header-Buttons, Transactions, Drawer-Panels, Modals,
Type-Toggle, Swipe — die komplette Motion-Sprache.

**Fix:** Werte aus `DESIGN_CONVENTIONS.md` §Typografie eintragen:

```css
--dur-fast: 0.15s;
--dur-base: 0.2s;
--dur-medium: 0.25s;
--dur-slow: 0.3s;
```

---

### [x] 2. Ungültige `-var()`-Syntax

**Ort:** `frontend/index.html:1419, 1430`

```css
.modal-body {
  margin: 0 -var(--space-20);
}
.modal-footer {
  margin: var(--space-8) -var(--space-20) 0;
}
```

CSS unterstützt kein unäres Minus vor `var()` → die Deklaration wird verworfen.
Modal-Body und -Footer bekommen ihre negativen Außenränder nie, das
edge-to-edge-Scrollen funktioniert nicht.

**Fix:** `calc(-1 * var(--space-20))` verwenden, oder einen
`--space-neg-20: -20px` Token einführen.

---

## Konventionsverletzungen (gegen `DESIGN_CONVENTIONS.md`)

### [x] 3. Suchfeld in der Bottom-Bar

**Ort:** `frontend/index.html:2414-2433`

DESIGN*CONVENTIONS §Suchfelder: *„Platzierung: Oben auf dem Screen, unter der
Top-Bar – nicht in der Bottom-Bar."\_ Aktuell sitzt die Suche neben dem FAB unten.

**Entscheidung treffen:** entweder Doku korrigieren (falls bottom-bar bewusste
Designentscheidung ist) oder Markup nach oben verschieben.

---

### [x] 4. Material auf scrollender Liste

**Ort:** `frontend/index.html:737-752` (`.transaction`)

DESIGN*CONVENTIONS §Materialien: *„`backdrop-filter` nur auf kleinen, statischen
Flächen. Nicht auf scrollende Listen anwenden – iOS-Safari ruckelt sonst."\_

Jede `.transaction` in der Liste hat `backdrop-filter: var(--blur-regular)`.
Bei vielen Buchungen → Janks auf iOS.

**Fix:** Karten in der Liste opak (`background: var(--bg-canvas)` + Border +
Shadow), Glas nur für Toolbars und Modals.

---

### [x] 5. UI-Glossar widerspricht sich selbst

**Orte:** Drawer-Label „Transaktionen" (`index.html:2074`) vs. Modal-Titel
„Buchung wirklich löschen?" und §Terminologie in DESIGN_CONVENTIONS.

§Terminologie verlangt **Buchung** statt „Transaktion in der UI". Aktuell
wechselt die App zwischen den Begriffen.

**Fix:** Konsistent „Buchung" / „Buchungen" in allen sichtbaren Texten;
Variablen-/Code-Namen (`transactions`) bleiben englisch wie in CLAUDE.md geregelt.

---

### [x] 6. Akzent-bezogene Schatten sind hardcoded

**Orte:** `index.html:1466, 1473, 1673, 1683, 1766` u.a.

```css
0 6px 18px -4px rgba(217, 100, 52, 0.5);   /* submit-btn */
0 2px 8px       rgba(217, 100, 52, 0.35);  /* type-btn.out */
0 6px 18px -4px rgba(47, 141, 94, 0.5);    /* submit-btn.green */
```

Im Dark-Mode wechselt `--accent` auf `#e8926e`, der Schatten bleibt aber der
Light-Ton. `47,141,94` stimmt zudem gar nicht mit `--green: #788C5D` überein.

**Fix:** `box-shadow: … color-mix(in oklab, var(--accent) 35%, transparent);`
oder ein dediziertes Token `--shadow-accent`.

---

## UX / Information Architecture

### [x] 7. Kein Active-Panel-Indikator außerhalb des Drawers

**Ort:** `index.html:2767-2778` (`showPanel()`)

`showPanel()` setzt `.active` nur auf das Drawer-Item und schließt den Drawer
sofort. Im Hauptscreen gibt es keinen Hinweis, ob der Nutzer auf
Transaktionen, Auswertungen oder Kategorien ist. Header zeigt nur den Monat.

**Vorschlag:**

- Subtitle unter `.month-label` mit dem aktiven Panel-Namen, oder
- Bottom-Tab-Bar reaktivieren (`.bottom-nav { display: none }` in `index.html:1026`),
  Markup neu aufbauen.

---

### [x] 8. „Kategorien" doppelt im Drawer

**Orte:** `index.html:2067` (Top-Level) + `index.html:2094` (Settings → Kategorien)

Gleiches Wort, zwei Bedeutungen, zwei Routen:

- Top-Level „Kategorien" → wechselt Hauptpanel auf Kategorien-Übersicht.
- Settings → „Kategorien" → CRUD-Verwaltungsansicht.

**Fix:** umbenennen, z.B. „Kategorien-Übersicht" / „Kategorien verwalten".
Oder eine der beiden Routen entfernen.

---

### [x] 9. Header überladen

**Ort:** `index.html:2348-2363`

`hamburger-btn | ‹ Monat › | sync-btn` — drei Touch-Targets in einer Zeile,
davon drei in der Mitte (Pfeile + Label). Apple HIG: max. 1 trailing Action.

**Vorschlag:** Sync-Status als kleiner Indikator im Hamburger-Icon oder als
`aria-live`-Toast unten, nicht als eigener Button.

---

### [x] 10. Summary-Karten verlassen sich auf Farbe

**Ort:** `index.html:2879-2880`

```js
document.getElementById('totalOut').textContent = fmtCurrency(out);
document.getElementById('totalIn').textContent = fmtCurrency(inc);
```

Keine Vorzeichen. Labels „Ausgaben"/„Einnahmen" disambiguieren zwar — aber
`fmtSignedCurrency()` (existiert bereits) wäre konsistent mit der Liste, in der
Beträge `+12,50 €` / `−12,50 €` zeigen.

**Fix:** beide auf `fmtSignedCurrency` umstellen.

---

## Polish & Code-Hygiene

### [x] 11. Wiederholte Inline-Styles

**Orte:**

- 3× Destructive-Button („Löschen") in 3 Modals: `index.html:2501-2510, 2537-2542, 2585-2590`
- 5× Radio-Row-Block (3 Theme + 2 Default-View): `index.html:2245-2340`
- mehrere `<input style="…">`-Wiederholungen in Drawer-Sections

**Fix:** Klassen `.btn-destructive` und `.radio-row` einführen.

---

### [x] 12. Inkonsistente Tokens

- Icon-Größen außerhalb `--fs-*`-Skala: `cat-icon 1.0625rem`,
  `cat-view-icon 1.375rem`, `fab 1.625rem`, `empty-state .icon 3.25rem`.
- Color-Swatch-Border: `2.5px solid` vs. Custom-Swatch `1.5px dashed`.
- `.tx-action` Gradient nutzt `#ec6b5b` als zweite Farbe neben `--red`
  (`index.html:718`) → Token `--red-2` einführen.

**Fix:** entweder Tokens erweitern (`--fs-icon-sm/md/lg`) oder Werte begründen
und vereinheitlichen.

---

### [x] 13. Globales `canvas { max-height: 220px }`

**Ort:** `index.html:874-876`

Nicht auf `.chart-container canvas` gescoped. Jedes künftige `<canvas>`
(Sparkline, Avatar etc.) erbt das.

**Fix:** auf `.chart-container canvas` einschränken.

---

### [x] 14. Generischer 3-Bar-Hamburger

**Ort:** `index.html:2350-2352`

Drei flache `<span>`s wirken im sonst sehr polished Liquid-Glass-UI billig.

**Fix:** Inline-SVG mit `currentColor`, Strichstärke 1.5–2px bei 24px viewport
(siehe DESIGN_CONVENTIONS §Icons im UI).

---

### [x] 15. Kein Tablet-/Desktop-Layout

→ verschoben nach [`TODO.md`](TODO.md) §Features.

**Ort:** `index.html:212-223` (`body`)

```css
body {
  max-width: 430px;
  margin: 0 auto;
}
```

Auf iPad und Mac sieht der Nutzer nur eine 430-px-Spalte mit viel Leerraum.
Laut Architektur-Diagramm in CLAUDE.md sind Ziel-Plattformen
**iPhone + iPad + Mac**.

**Vorschlag:** mindestens ein `@media (min-width: 768px)`-Branch — z.B.
zweispaltig (Liste + Detail), breitere Karten oder Dashboard-Anordnung.
Eigener Plan/Spike, nicht im selben PR mit Bugfixes.

---

### [x] 16. Drawer-Mainmenü ohne starken Aktiv-Marker

→ verschoben nach [`TODO.md`](TODO.md) §Nice-to-haves.

**Ort:** `index.html:1226-1228`

```css
.drawer-nav-item.active {
  color: var(--accent);
  font-weight: 600;
}
```

Subtil — nur Farb- und Gewichtsänderung. Apple HIG empfiehlt eine zusätzliche
Form (Punkt links, Akzent-Bar rechts). „Nice to have", nicht kritisch.

---

### [ ] 17. Kleinkram-Sammlung

- [ ] `.sync-dot` (`index.html:2359`) ist rein dekorativ → `aria-hidden="true"` setzen.
- [ ] `.modal-handle` hat `cursor: grab` und `touch-action: none` — sicherstellen,
      dass tatsächlich ein Drag-to-dismiss-Handler existiert; sonst Affordance entfernen.
- [ ] `.modal-cancel-btn` zeigt `‹` (`index.html:2442`) → bei Sheets ist `✕`
      semantisch klarer (Sheet schließen vs. Push-Navigation zurück).
- [ ] `body { overflow-x: hidden }` (`index.html:219`) kann in alten iOS-Safaris
      `position: sticky` brechen — beobachten.
- [ ] `.sync-dot` `box-shadow: 0 0 var(--space-8) var(--green)` (`index.html:497`)
      — heller Glow auf Light-Glas, evtl. < WCAG 3:1 für grafische Elemente.

---

## Empfohlene Bearbeitungs-Reihenfolge

1. **Heute:** #1, #2 — schnelle Bugfixes mit echtem Impact (~5 Min).
2. **Diese Woche:** #3 (Suche-Position klären), #4 (Glas auf Liste raus),
   #5 (Glossar konsolidieren).
3. **Nächster Sprint:** #6, #7, #8, #11.
4. **Backlog/Spike:** #15 (Tablet-Layout) — größerer Brocken, eigener Plan.
