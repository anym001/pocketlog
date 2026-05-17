# Design-Review – PocketLog Frontend

**Datum:** 2026-05-17
**Bezug:** `frontend/index.html` (4521 Zeilen), `frontend/sw.js` (166 Zeilen)
**Grundlage:** [`DESIGN_CONVENTIONS.md`](../DESIGN_CONVENTIONS.md), Apple HIG, WCAG 2.2, [`CLAUDE.md`](../CLAUDE.md)

Checkboxen zum Abhaken beim Bearbeiten. Reihenfolge folgt Priorität (Kritisch → Polish).

---

## Kritisch – kaputt im laufenden Code

### [x] 1. `font-variant-numeric: tabular-nums` fehlt auf allen Betragsspalten

**Ort:** `frontend/index.html:621-628`, `850-862`, `945-950`, `1525-1531`

Beträge springen aktuell zwischen Zeilen, weil die proportionale Variante
der DM-Schriften für Ziffern verwendet wird. Konvention fordert
tabular-nums auf jeder Betrags-Spalte.

Betroffen:
- `.summary-card .amount` (Hero-Saldo, Z. 621)
- `.t-amount` (Transaktions-Liste, Z. 850)
- `.cat-amount` (Kategorie-Balken, Z. 945)
- `.form-group input.amount-input` (Form-Eingabe, Z. 1525)

Bereits korrekt: `.sync-badge` (Z. 553), `.cat-view-amount` (Z. 703).

**Fix:** In jeder der vier Regeln ergänzen:

```css
font-variant-numeric: tabular-nums;
```

---

### [x] 2. Modal: kein Fokus-Restore, kein Escape-Handler, kein Focus-Trap

**Ort:** `frontend/index.html:3673-3686`, `4406-4408`

`openModal()` setzt `inputAmount.focus()` (Z. 3680), speichert aber nicht
das vorher fokussierte Element. `closeModal()` (Z. 3683–3686) macht kein
`previouslyFocused?.focus()`. Der globale Escape-Handler (Z. 4406–4408)
deckt nur den Drawer ab — Buchungs-Edit-Modal, Tag-Picker, Kategorie-
Modal und Confirm-Modal lassen sich nicht per Tastatur schließen.

Kein einziges Modal hat einen Focus-Trap, Tab läuft also in den
Hintergrund-Inhalt zurück.

**Fix (Skizze):**

```js
let _previouslyFocused = null;
function openModal(tx) {
  _previouslyFocused = document.activeElement;
  // ... bestehender Code ...
}
function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
  _previouslyFocused?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('modalOverlay').classList.contains('open')) return closeModal();
  // …gleiches Pattern für Tag-Picker, Cat-Modal, Confirm-Modal…
  closeDrawer();
});
```

Focus-Trap separat (Tab-Cycle innerhalb `.modal` halten).

---

### [x] 3. `<div onclick>` auf Kategorie-Zeile + Tag-Pill – nicht per Tastatur erreichbar

**Ort:** `frontend/index.html:3340`, `3963`

```html
<!-- 3340 -->
<div class="cat-view-row" onclick="openModalForCategory(${r.id})">
  …
</div>

<!-- 3963 -->
<div class="tag-pill cat-pill-edit" style="border-color:${c.color}66"
     onclick="openCatModal(${c.id})">${c.icon} ${c.name}</div>
```

Beide Elemente sind interaktiv (öffnen ein Modal), aber kein `<button>`
und ohne `role="button" tabindex="0"`. Screenreader meldet kein Control,
Tab-Navigation überspringt sie.

**Fix:** Äußeren Container als `<button type="button">` rendern. Beim
`cat-view-row` muss der innere `cat-view-more`-Button weiterhin via
`event.stopPropagation()` getrennt funktionieren — das ist bereits
vorhanden. Styling auf `<button class="cat-view-row">` übertragen
(`background: transparent; border: none; width: 100%; text-align: left;`).

---

### [x] 4. Canvas-Charts ohne Screenreader-Alternative

**Ort:** `frontend/index.html:2582`, `2595`

```html
<h3>Monatsvergleich</h3>
<canvas id="monthChart"></canvas>
<!-- … -->
<h3>Jahresverlauf</h3>
<canvas id="yearChart"></canvas>
```

Canvas ist für Screenreader leer. Konvention fordert Text-Zusammenfassung
(Summe Einnahmen, Summe Ausgaben) als Fallback.

**Fix:**

```html
<canvas id="monthChart" role="img"
        aria-label="Monatsvergleich – wird mit den aktuellen Beträgen aktualisiert"></canvas>
<div id="monthChartSummary" class="visually-hidden" aria-live="polite"></div>
```

JS aktualisiert `#monthChartSummary` synchron mit jedem Chart.js-Update
(`Einnahmen: 1.234,56 €. Ausgaben: 987,65 €.`).

---

### [x] 5. Color-Swatch-Button ohne `aria-label`

**Ort:** `frontend/index.html:4018`

```js
`<button type="button"
   class="color-swatch${c.toLowerCase() === editingCatColor.toLowerCase() ? ' active' : ''}"
   style="background:${c}" onclick="pickCatColor('${c}')"></button>`
```

Screenreader hört nur „Button". Bei 6+ Farbfeldern in Folge unbenutzbar.

**Fix:**

```js
`<button type="button"
   class="color-swatch…"
   style="background:${c}"
   aria-label="Farbe ${c} wählen"
   onclick="pickCatColor('${c}')"></button>`
```

Optional besser: Palette in `CAT_COLOR_PRESETS` mit semantischen Namen
hinterlegen (`{hex: '#D97757', name: 'Clay'}`) und `aria-label="Farbe Clay wählen"`.

---

## Hoch – Konventionsverstöße mit sichtbarer Folge

### [ ] 6. `backdrop-filter` auf Cards verboten – `.summary-card` und `.chart-container`

**Ort:** `frontend/index.html:582-583`, `868-869`

`DESIGN_CONVENTIONS.md` §Materialien: „Card-Hintergründe in der Liste
(lieber `--bg-canvas` + Border)". Aktuell haben beide Card-Typen
`backdrop-filter: var(--blur-regular);`.

Performance-Risiko zusätzlich, weil die Summary-Cards bei `body.searching`
animiert ausgeblendet werden (Z. 663–669) und das Chart-Panel scrollbar
ist.

**Fix:**

```css
.summary-card {
  background: color-mix(in oklab, var(--bg-canvas) 92%, transparent);
  /* backdrop-filter Zeilen entfernen */
}
.chart-container { /* gleiches Muster */ }
```

---

### [ ] 7. Falsche `line-height` für DM Serif Display

**Ort:** `frontend/index.html:625`, `1179`

Soll laut Konvention `1.25` sein, ist aktuell `1`:

- `.summary-card .amount` (Z. 625) – Hero-Beträge
- `.drawer-head-title` (Z. 1179) – „PocketLog"-Logo im Drawer

`line-height: 1` schneidet bei Buchstaben mit Unterlängen (kursives `g`,
`y`) den Rand. Fällt im Drawer-Header auf.

**Fix:** Beide auf `line-height: 1.25;`.

---

### [ ] 8. Sync-Status-Texte: Ellipse + Punkt-Konsistenz

**Ort:** `frontend/index.html:4255`, `4264`, `4396`, `4451`

| Z. | Aktuell | Soll |
|---|---|---|
| 4255 | `'Offline – Änderungen werden gespeichert'` | `'Offline – Änderungen werden gespeichert…'` |
| 4396 | `setSyncAria('Änderungen werden gespeichert')` | `'Änderungen werden gespeichert…'` |
| 4264 | `'Synchronisation fehlgeschlagen – Verbindung prüfen'` | ohne Punkt belassen |
| 4451 | `'Import fehlgeschlagen – Verbindung prüfen.'` | Punkt entfernen für Konsistenz |

Konvention: fortlaufende Aktion → Ellipse `…`. Fragmentarische Status-
Strings ohne Punkt (Apple Style Guide: kurze Labels ohne abschließenden
Punkt).

Bereits korrekt: Z. 4224 `'Wird synchronisiert…'`, Z. 4428 `'Wird importiert…'`.

---

### [ ] 9. Sync-Status-Live-Region fehlt

**Ort:** `frontend/index.html:4212-4215`

```js
function setSyncAria(status) {
  const btn = document.getElementById('syncBtn');
  if (btn) btn.setAttribute('aria-label', `Synchronisieren – ${status}`);
}
```

`aria-label`-Änderungen ohne `aria-live` werden von SR **nicht aktiv**
vorgelesen. Konvention fordert `aria-live="polite"` für Sync-Status.

**Fix:** Dedizierten Live-Region-Knoten anlegen:

```html
<span id="syncAriaLive" class="visually-hidden" aria-live="polite" aria-atomic="true"></span>
```

```js
function setSyncAria(status) {
  document.getElementById('syncAriaLive').textContent = status;
  const btn = document.getElementById('syncBtn');
  if (btn) btn.setAttribute('aria-label', `Synchronisieren – ${status}`);
}
```

---

### [ ] 10. Heading-Hierarchie springt von H1 zu H3

**Ort:** `frontend/index.html:2256`, `2581`, `2585`, `2598`

Drawer hat `<h1 class="drawer-head-title">PocketLog</h1>` (Z. 2256),
Charts-Sections sind aber `<h3>` (Z. 2581 „Monatsvergleich", Z. 2585
„Jahresverlauf", Z. 2598 „Kategorien"). H2-Level fehlt komplett.

Zwei Optionen:

1. Charts-Sections als `<h2>` markieren (Hierarchie reparieren).
2. Drawer-Titel ist eher Branding/Logo – auf `<p>` reduzieren und
   `<h1>` an die App vergeben (z. B. `visually-hidden` H1 „PocketLog").

**Empfehlung:** Variante 2, dann passen die `<h2>` für die drei
Charts-Sections sauber drunter.

---

## Mittel – Tokens & Design-System-Hygiene

### [ ] 11. Freie px-Werte für `width`/`height`/`border-radius`

**Ort:** `frontend/index.html:691`, `769`, `806-807`, `914-915`, `934`, `941`, `1018`, `1040`

| Z. | Selektor | Wert | Vorschlag |
|---|---|---|---|
| 691 | `.cat-view-icon` | `width: 32px` | neues Token oder Spacing-Vielfaches |
| 769 | `.tx-action` | `width: 92px` | via `padding` oder eigenes Token |
| 806-807 | `.t-icon` | `42px × 42px` | `var(--btn-chrome-size)` (44 px) prüfen |
| 914-915 | `.cat-icon` | `38px × 38px` | s. o. |
| 934, 941 | `.cat-bar-wrap`/`.cat-bar` | `height: 5px` | neues `--cat-bar-height` |
| 1018 | `.fab` | `border-radius: 18px` | `var(--r-md)` (16) oder `var(--r-lg)` (22) |
| 1040 | `.fab::before` | `border-radius: 17px` | s. o. |

---

### [ ] 12. Magic Numbers für Bottom-Bar-Höhe und Innenabstand

**Ort:** `frontend/index.html:646`, `955`, `958`

```css
/* 646 */
.panel { padding: var(--space-8) var(--space-20)
         calc(66px + max(var(--space-16), env(safe-area-inset-bottom))); }
/* 955 */
.bottom-bar { bottom: max(16px, env(safe-area-inset-bottom)); }
/* 958 */
.bottom-bar { width: min(calc(430px - 32px), calc(100vw - 32px)); }
```

- `66px` (Bottom-Bar-Höhe für Inhalts-Padding) – Magic Number, als Token
  `--bottom-bar-clearance` extrahieren.
- `16px` in `.bottom-bar` → `var(--space-16)`.
- `32px` ist `2 × var(--space-16)` – als Variable oder Kommentar erklären.

---

### [ ] 13. Freie Animations-Dauern statt `var(--dur-*)`-Tokens

**Ort:** `frontend/index.html:291`, `530`, `943`, `1117`, `1348`, `2015`, `2021`

Die Konvention erlaubt im Kommentar (`:root`) „Odd values (0.22, 0.28,
0.35, 0.45 …)" als Literal für spezifische Animationen — die folgenden
sind weder im Token-Set noch dokumentiert:

| Z. | Code |
|---|---|
| 291 | `animation: ambient-drift 22s …` |
| 530 | `animation: pulse 1.2s …` (`.sync-dot.syncing`) |
| 943 | `transition: width 0.7s …` (`.cat-bar`) |
| 1117 | `transition: transform 0.35s …` (`.drawer`) |
| 1117, 1348 | `animation: slideUp 0.45s …` |
| 2015 | `animation: toast-in 0.28s …` |
| 2021 | `animation: toast-out 0.22s …` |

**Fix:** Entweder dokumentierte Spezial-Tokens (`--dur-pulse`,
`--dur-ambient`, `--dur-progress`, `--dur-slide`, `--dur-toast-in/out`)
oder soweit möglich auf `var(--dur-slow)` (0.3s) bzw. `var(--dur-medium)`
(0.25s) ausrichten.

---

### [ ] 14. `box-shadow` mit rgba statt `var(--shadow-*)`-Tokens

**Ort:** `frontend/index.html:298-302`, `442-443`, `978-979`

- `.header` (Z. 442–443 hell und 298–302 dunkel) verwendet eigene
  rgba-Schatten statt `var(--shadow-elevated)` oder einer themenfähigen
  Variable.
- `.search-wrap` (Z. 978–979) hat einen eigenen `rgba(20,20,19,…)`-
  Schatten zusätzlich zum inset-Hairline.

**Fix:** Entweder bestehenden `--shadow-soft/elevated/floating` mappen,
oder zwei neue Subtokens `--shadow-header`, `--shadow-bottom-bar`
einführen, in `:root` definieren (light + dark separat).

---

### [ ] 15. Wiederkehrende Inline-Styles als Klasse extrahieren

**Ort:** `frontend/index.html:2337`, `2358`, `3640`, `3957`, `4106`

Doppelte Inline-Styles (Projektregel: ab 2× → Klasse):

```html
<!-- 2337 + 2358 (Drawer-Listen catList, tagList) -->
style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px"
```

```js
// 3957 + 4106 (Empty-State-Texte)
'<p style="font-size:var(--fs-caption);color:var(--text3)">Noch keine …'
```

```js
// 3640 (Empty-State im Cat-Breakdown)
'<p style="color:var(--text3);font-size:var(--fs-caption);
           text-align:center;padding:16px">Keine Ausgaben in diesem Monat</p>'
```

Zusätzlich `padding: 16px` → `var(--space-16)`, `gap: 8px` → `var(--space-8)`,
`margin-bottom: 12px` → `var(--space-12)`.

**Fix:** Klassen `.drawer-chip-list` und `.empty-state-hint` einführen.

---

### [ ] 16. Liquid-Glass-Blur-Werte abweichend vom Standard-Rezept

**Ort:** `frontend/index.html:1093`, `1319`, `1548`, `1976`

Standard-Rezept laut Konvention: `blur(20px) saturate(140%)`.

| Z. | Selektor | Aktuell |
|---|---|---|
| 1093 | `.drawer-overlay` | `blur(4px)` |
| 1319 | `.drawer-overlay.open` | `blur(8px) saturate(140%)` |
| 1548 | `.tag-pill button` | `blur(10px)` |
| 1976 | `.tag-pill button` (anderer Selektor) | `blur(14px) saturate(180%)` |

Bestehende Tokens `--blur-thin/regular/thick` decken die Skala bereits ab.

**Fix:** Auf vorhandene Tokens mappen oder einen `--blur-dim` für
Drawer-Overlay-Use-Cases einführen.

---

## Niedrig – Polish / Nice-to-have

### [ ] 17. Theme-Definition dreifach gepflegt – Sync-Risiko

**Ort:** `frontend/index.html:174-210`, `306-351`, `353-398`

Die Dark-Werte stehen in `@media (prefers-color-scheme: dark)` UND in
`html[data-theme='dark']`. Light-Werte stehen in `:root` UND in
`html[data-theme='light']`. Bei Änderungen muss man jeweils zwei Stellen
synchron halten.

**Fix-Option A:** `:root` weglassen, `html[data-theme]` mit fallback via
`@media (prefers-color-scheme)` cascadieren — komplex.

**Fix-Option B:** Pragmatischer Kommentar: „SYNC mit Z. 306 + 353 halten".

Niedrige Priorität – funktional korrekt, nur Wartungskosten.

---

### [ ] 18. Hex-Alpha-Hacks (`${color}22`, `${color}66`) für Kategorie-Tints

**Ort:** `frontend/index.html:3299`, `3647`, `3963`

```js
style="background:${cat.color}22"   // 13 % opacity
style="border-color:${c.color}66"   // 40 % opacity
```

Kategorie-Farbe kommt aus der DB (User-Daten), nicht aus Tokens — daher
kein klassischer Token-Verstoß. Aber die `22`/`66` Hex-Suffixe sind
undurchsichtig.

**Fix (optional, kosmetisch):**

```js
`background: color-mix(in oklab, ${cat.color} 13%, transparent)`
`border-color: color-mix(in oklab, ${c.color} 40%, transparent)`
```

---

### [ ] 19. `line-height` für Body-Text leicht zu hoch

**Ort:** `frontend/index.html:1914`, `2048`

- `.empty-state p` (Z. 1914): `line-height: 1.6` (Soll: `1.4`)
- `.confirm-msg` (Z. 2048): `line-height: 1.5` (Soll: `1.4`)

Mehr Lesbarkeit aktuell — Konvention zugunsten Konsistenz auf `1.4`
ziehen, oder Konvention für Hilfstexte/Confirms explizit lockern.

---

### [ ] 20. Empty-State-Emoji statt SVG-Sprite

**Ort:** `frontend/index.html:3260`, `3320`

`📭` als Empty-State-Hero. Konvention: „Inline-SVG bevorzugen". Da
Emoji nur in Empty-States und konsistent eingesetzt wird, akzeptabel —
kein harter Verstoß.

**Fix-Option:** SVG-Sprite-Eintrag `#icon-mailbox-empty` (Outline,
24×24) und `<svg>` per `<use>` einbinden. Vorteil: Theme-fähige Farbe
via `currentColor`.

---

### [ ] 21. Google Fonts nicht im Service-Worker-Precache

**Ort:** `frontend/sw.js:23-33`

`SHELL`-Array enthält keine `fonts.googleapis.com`-URLs. Bei
Erstinstallation ohne Netz oder nach Cache-Eviction fallen Beträge auf
Default-Serif zurück — DM Serif Display fehlt offline.

**Fix-Vorschlag (stärker):** DM-Fonts selbst hosten:

1. `frontend/fonts/dm-serif-display-{regular,italic}.woff2` ablegen.
2. `@import` aus `frontend/index.html` (Z. 25) durch lokale
   `@font-face`-Deklaration ersetzen.
3. Font-URLs in `SHELL` aufnehmen.

Beseitigt zusätzlich die Drittanbieter-Privacy-Schiene (Google).

**Fix-Vorschlag (minimal):** Google-Fonts-CSS-URL und gstatic-woff2-URLs
in `SHELL` aufnehmen — fragil, weil Hash-URLs sich ändern.

---

### [ ] 22. Backdrop-Overlay-Divs ohne `aria-hidden`

**Ort:** `frontend/index.html:2251`, `2637`

```html
<div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
<div class="modal-overlay" id="modalOverlay" onclick="closeModalOutside(event)">
```

Funktional ist das OK (Close-Button separat vorhanden), aber für
Screenreader sollte das leere Overlay `aria-hidden="true"` tragen.

**Fix:**

```html
<div class="drawer-overlay" id="drawerOverlay" aria-hidden="true"
     onclick="closeDrawer()"></div>
```

---

## Zusammenfassung

| Priorität | Anzahl | Punkte |
|---|---|---|
| Kritisch | 5 | #1–5 |
| Hoch | 5 | #6–10 |
| Mittel | 6 | #11–16 |
| Niedrig | 6 | #17–22 |

**Empfohlene Reihenfolge:** #1 → #2/3 → #5 → #4 → #6 → #7–10 → Tokens-Block (#11–16) → Polish.

**Akzeptanzkriterium pro Punkt:** Code geändert + Verhalten im Browser
geprüft (Light + Dark, Tab-Navigation, Screenreader-Test wo relevant).
Nach Abschluss aller Punkte am Anfang der Datei „Archiviert"-Block
einfügen (s. `DESIGN_REVIEW_2026-05-15.md`).
