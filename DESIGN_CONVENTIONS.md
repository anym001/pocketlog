# PocketLog – Design Conventions

Gilt für alle UI-Arbeiten im Frontend (`frontend/index.html`, `frontend/styles.css`,
`frontend/app.js`, `frontend/icons/`). Alle sichtbaren Texte sind deutsch, Code
und Kommentare englisch (siehe „Sprach-Konventionen" in [`CLAUDE.md`](CLAUDE.md)).


## Grundprinzipien

- **Klarheit:** Funktion vor Dekoration, kein visuelles Rauschen.
- **Zurückhaltung:** UI rahmt die Daten – Buchungen und Beträge im Vordergrund.
- **Tiefe:** Hierarchie über Schichten und Schatten, nicht Skeuomorphismus.
- **Mobile-first:** max-width `430px`, einspaltig, Touch-Targets ≥ 44×44px.
- **Inhalt zuerst:** DM Serif Display für Beträge dominant, DM Sans tritt zurück.
- **Plattform-Look auf iOS:** `standalone`-Mode, `theme-color` = `--bg-canvas`, `apple-touch-icon` gesetzt.

## Layout & Safe Areas

Referenz: [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout).

- **Container:** zentriert, `max-width: 430px`, horizontale Innenränder `16px`.
- **Vertikales Spacing-Raster:** Vielfache von 4 (`4 / 8 / 12 / 16 / 20 / 24`)
  plus die zwei gängigen iOS-Zwischenstufen `10` und `14`. Spacing-Werte
  außerhalb dieser Skala vermeiden. Quelle der Wahrheit sind die
  CSS-Variablen `--space-N` in `frontend/styles.css` `:root`, wobei `N`
  dem Px-Wert entspricht (`--space-8` = 8 px). Sonderwerte `--space-2`
  und `--space-56` sind für vereinzelte Spezial-Spacings reserviert
  (Tag-Pill Innenrand, Empty-State Padding).
- **Safe Area:** `env(safe-area-inset-*)` für oberen Status-Bar-Bereich, Notch /
  Dynamic Island und Home-Indikator. Fixed-Bottom-Elemente bekommen
  `padding-bottom: max(16px, env(safe-area-inset-bottom))`.
- **Touch-Targets:** Mindestmaß `44 × 44px` für alle interaktiven Flächen, auch
  wenn das visuelle Icon kleiner ist – per `padding` vergrößern, nicht per
  `width/height` auf transparente Hitboxen.
- **Gruppierung:** Verwandte Elemente in einer Card mit `border-radius` und
  einheitlichem Padding bündeln. Zwischen Card-Gruppen mindestens `16px`
  Abstand.
- **Hierarchie über Größe & Gewicht, nicht über Farbe.** Primäre Aktion
  visuell prominent, sekundäre in `--text2`, tertiäre in `--text3`.
- **Lesbreite:** Fließtext (Beschreibungen, Hinweise) nicht über `60ch`.
- **Scroll-Verhalten:** vertikal scrollbar, horizontales Scrollen vermeiden
  (außer bewusst für Chart / Tag-Reihe). `overscroll-behavior-y: contain` auf
  Modal-Inhalten.

## Sichtbarkeit & `[hidden]`-Attribut

Das HTML-`hidden`-Attribut nutzt das User-Agent-Default `[hidden] { display: none }` — ohne `!important`. Jede spezifischere CSS-Regel schaltet es aus. Daraus zwei harte Regeln:

- **Wenn die Klasse `display` setzt** (z. B. `.auth-view { display: flex }`),
  IMMER `.foo[hidden] { display: none }` als Override ergänzen — sonst
  bleibt das Element trotz `hidden` sichtbar. Andere Klassen wie
  `.sync-badge`, `.range-custom`, `.range-stepper`, `.trend-active-row`
  machen das vor.
- **Wenn die Klasse `display` NICHT setzt** und das Element via
  `data-state` / `class.open` ein- und ausgeblendet wird, **darf das
  Element kein `hidden`-Attribut tragen** — sonst greift der
  Browser-Default `display: none`, und Transform-/Opacity-Wechsel werden
  nie sichtbar. Sichtbarkeit gehört dann komplett in die State-Klasse.
- **Faustregel:** Pro Element entweder `[hidden]` UND passender CSS-Override,
  ODER eine State-Klasse — niemals beides mischen.

Hintergrund: Beide Varianten haben in v0.3.x je einen sichtbaren Bug
ausgelöst — Auth-Force-Change-View permanent sichtbar (`.auth-view`
hatte `display:flex` ohne `[hidden]`-Override) und das
Benutzerverwaltungs-Drawer-Panel permanent unsichtbar (`.drawer-panel`
hatte kein `display`, das JS togglte nur `data-state`, das `hidden`-Attribut
ließ den Browser `display:none` ziehen).

## Adaptives Layout (Tablet & Desktop)

Mobile-first bleibt Doktrin. iPad und Mac sind progressive Erweiterungen über
zwei Breakpoints — der Breakpoint-Wert lebt literal in `@media` (CSS-Limitation)
und ist im `:root`-Kommentar dokumentiert.

- **Breakpoints:** `768px` (iPad Hochformat — Sidebar erscheint), `1024px`
  (iPad Querformat / Mac — nur größere Chart-Höhen, **keine** Content-Breiten-
  Änderung). Der iPhone-Pfad < 768 px bleibt unverändert.
- **Layout-Token:** `--app-sidebar-width` (260 px, Sidebar-Breite). Es gibt
  bewusst **keine** `--app-max-content`-Tokens — Listen / Tabellen / Panels
  füllen die Content-Pane voll (siehe „Content-Breite" unten).
- **App-Shell:** `<main class="app-shell">` umschließt Header, Summary,
  Panels, Bottom-Bar **und** den Drawer. Auf Mobile `display: contents`
  (kein visueller Effekt). Ab 768 px wird sie zu `display: block` mit
  `padding-left: var(--app-sidebar-width)`, das den Platz für die fixed
  Sidebar reserviert.
- **Sidebar:** Drawer ist ab 768 px `position: fixed; top: 0; left: 0;
  width: var(--app-sidebar-width); height: 100dvh` mit
  `min-height: 100vh`-Fallback für iPad-Safari. Hamburger, Drawer-Overlay
  und der Drawer-Head-**Close-Button** werden ausgeblendet — der „PocketLog"-
  Titel im Drawer-Head bleibt sichtbar als Sidebar-Brand. Sub-Panel-
  Navigation (`drawerNav` / `drawerBack`) bleibt funktional. Sub-Panel-
  State **persistiert** zwischen Open/Close des mobilen Drawers (User
  landet beim nächsten Hamburger-Klick wieder im zuletzt geöffneten
  Sub-Panel, nicht auf der obersten Ebene).
- **Sidebar-Toggle (Apple-Mail-Pattern):** Eigener `.sidebar-toggle-btn`
  oben links im Header (nur Tablet+). State lebt als `html.sidebar-collapsed`
  und wird vor dem ersten Paint über ein Inline-Boot-Script in `<head>` aus
  `localStorage` wiederhergestellt (kein Flash). Zwei state-abhängige
  Icons: `arrows-out` bei sichtbarer Sidebar (Klick erweitert den Content),
  `arrows-in` bei collapsed Sidebar (Klick holt die Sidebar zurück).
  `aria-pressed` mirror't den Zustand.
- **Modals:** Ab 768 px wechseln Modals vom Bottom-Sheet zur zentrierten
  Card (`max-width: 560px`, `border-radius: var(--r-xl)` rundum,
  `fadeScaleIn`-Keyframe). Mobile bleibt Bottom-Sheet.
- **Bottom-Bar:** Bleibt floating, mit 16-px-Inset zu beiden visuellen
  Rändern — links zur Sidebar-Right-Edge, rechts zum Viewport. Im
  collapsed-State zum Viewport-Left. Spiegelt das iPhone-Verhalten.
- **JS-Guards:** `openDrawer()` / `closeDrawer()` sind ab 768 px No-Ops.
  `body.style.overflow = 'hidden'` darf in Modals weiter gesetzt werden
  (Background-Lock ist auch auf Desktop sinnvoll). Quelle der Wahrheit
  für den Breakpoint im JS: `window.matchMedia('(min-width: 768px)')` —
  muss bei jeder CSS-Breakpoint-Änderung mitgepflegt werden.
- **Hover-Aktionen:** Maus-/Trackpad-spezifische Affordanzen stehen
  **nur** unter `@media (hover: hover) and (pointer: fine)`. Touch-Geräte
  sehen sie nie — Swipe-to-Delete bleibt auf iPhone/iPad alleinige
  Lösch-Geste.
- **`:active` auf Listen-Reihen:** Vermeiden für touch-relevante Reihen
  (`.transaction`, `.cat-view-row`). Browser triggert `:active`
  sofort bei `touchstart`, was Reihen beim Scrollen aufflackern lässt.
  Visuelles Feedback für Keyboard-Aktivierung läuft über
  `.is-key-active`, gesetzt von `handleRowActivate()`.
- **Orientierung:** Manifest erzwingt keine Orientierung mehr. Querformat
  ist auf iPad erlaubt. Manifest-Änderungen greifen erst nach Re-Install
  der PWA.
- **Tastatur-Shortcuts:** `Cmd/Ctrl+N` (neue Buchung), `Cmd/Ctrl+F`
  (Suche fokussieren), `←` / `→` (Monat wechseln, nur wenn kein Input
  fokussiert und kein Modal/Drawer offen), `Esc` (schließen). Auf
  iPad-Safari greifen `Cmd+N` / `Cmd+F` nur im Standalone-PWA-Mode —
  außerhalb fängt der Browser die Shortcuts ab.

### Content-Breite (Apple-HIG-Recherche)

> Verifiziert via [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
> und [HIG: Split Views](https://developer.apple.com/design/human-interface-guidelines/split-views),
> sowie Apple-eigene Apps (Mail, Notes, Files) als Referenz-Implementierung.

- **Apple HIG dictiert keine Pixel-Cap für Listen oder Tabellen.** Die
  allgemeine Layout-Empfehlung lautet „restrict the width of text for
  optimal readability" — bewusst ohne konkrete Pixel-Zahl. Empfohlen
  wird stattdessen **adaptives Layout** (Auto Layout, Size Classes),
  das mit dem verfügbaren Platz wächst.
- **Split Views (Sidebar + Content):** HIG sagt „secondary pane nimmt
  ⅔ des Screens", **kein** Reading-Width-Cap. Mail, Notes und Files
  lassen Listen-Reihen die volle Breite des Sekundär-Panes nutzen.
- **Die 66-Zeichen-pro-Zeile-Regel ist Web-Typografie** (Bringhurst,
  etc.) und gilt für Fließtext-Absätze — Listen-Reihen mit Icon +
  kurzer Beschreibung + Betrag sind kein Fließtext.
- **In PocketLog:** Listen, Summary-Cards, Header-Top und Bottom-Bar
  nutzen die volle Content-Pane-Breite (Viewport minus Sidebar bzw.
  Viewport im collapsed-State, jeweils minus 16-px-Inset bei der
  Bottom-Bar). Das Header-Top ist ein 3-Spalten-Grid (`chrome 1fr
  chrome`), damit der Monatswechsler optisch zentriert bleibt
  unabhängig von der Pane-Breite.
- **Fließtext-Caps** (Modal-Body, Empty-States) bleiben weiterhin
  sinnvoll — die HIG-Begründung „restrict text for readability" gilt
  dort. Aktuell hat PocketLog davon nur das zentrierte Modal
  (`max-width: 560px`).

## Farbe & Theming

Referenz: [HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color).

- **CSS-Variablen sind Pflicht.** Keine Hex-Codes inline – jede Farbe geht
  über `var(--…)` aus `:root` / `@media (prefers-color-scheme: dark)`.
- **Semantische statt rohe Farben.** Code referenziert Bedeutung
  (`--accent` für Ausgaben, `--green` für Einnahmen), nicht den konkreten Ton.
- **Light/Dark automatisch.** `@media (prefers-color-scheme: dark)` ist die
  einzige Schaltstelle; keine Theme-Toggle-Logik im JS.
- **Farbpalette** (basiert auf [html-effectiveness](https://thariqs.github.io/html-effectiveness/)
  von Thariq Shihipar):

  | Variable | Light | Dark | Bedeutung |
  |---|---|---|---|
  | `--bg-canvas` | `#FAF9F5` (ivory) | `#0f0e0c` | App-Hintergrund |
  | `--accent` | `#D97757` (clay) | `#E8926E` | Ausgaben, primäre Aktion |
  | `--green` | `#788C5D` (olive) | `#9AB07A` | Einnahmen, Erfolg |
  | `--red` / `--red-2` | `#C0392B` / `#EC6B5B` | unverändert | Destruktive Aktionen (Swipe-to-Delete-Gradient) |
  | `--text` | `#141413` (slate) | `#F0EEE6` | Primärtext |
  | `--text2` | `#3D3D3A` | `#B0ADA6` | Sekundärtext |
  | `--text3` | `#87867F` | `#87867F` | Tertiärtext, Hints |

- **Kontrast:** Mindestens WCAG AA – `4.5 : 1` für Fließtext, `3 : 1` für
  großen Text (≥ 18 pt regular bzw. ≥ 14 pt bold) und für grafische Elemente.
  Bei jeder neuen Farbkombination im Light- *und* Dark-Mode prüfen.
- **Farbe ist nie das einzige Signal.** Einnahmen/Ausgaben tragen zusätzlich
  ein `+` bzw. `−` (U+2212). Fehlerzustände tragen einen Text, nicht nur einen
  roten Rand.
- **Keine harten Schwarz/Weiß-Hintergründe.** Immer `--bg-canvas` / `--text`,
  damit Light/Dark einheitlich wirkt.
- **Akzentfarbe sparsam:** maximal eine primäre Aktion pro Bildschirm
  in `--accent`-Fill, alle weiteren Aktionen als Outline oder Plain.

## Typografie

- **Schriftarten:** **DM Serif Display** (Beträge, große Überschriften)
  und **DM Sans** (alles andere). **Niemals** Inter, Roboto, Helvetica,
  Arial oder System-Font-Stacks.
- **Skala (rem-basiert, 1 rem = 16 px). Quelle der Wahrheit sind die
  CSS-Custom-Properties in `frontend/styles.css` `:root`:**

  | Token      | CSS-Variable      | Verwendung                           | Größe |
  |---|---|---|---|
  | `display`  | `--fs-display`    | Saldo-Anzeige                        | `2.25rem` (36 px), DM Serif Display |
  | `title`    | `--fs-title`      | Bildschirm-/Modal-Titel              | `1.5rem` (24 px), DM Serif Display |
  | `title-sm` | `--fs-title-sm`   | kompakter Titel, Stat-Zahl           | `1.25rem` (20 px) |
  | `headline` | `--fs-headline`   | Card-Überschrift                     | `1.125rem` (18 px), DM Sans 600 |
  | `body`     | `--fs-body`       | Fließtext, Form-Inputs               | `1rem` (16 px), DM Sans 400 |
  | `callout`  | `--fs-callout`    | sekundäre Buttons, Labels            | `0.9375rem` (15 px), DM Sans 500 |
  | `footnote` | `--fs-footnote`   | sekundärer Body, kleine Überschriften| `0.875rem` (14 px), DM Sans 400 |
  | `caption`  | `--fs-caption`    | Metadaten, Hinweise                  | `0.8125rem` (13 px), DM Sans 400 |
  | `micro`    | `--fs-micro`      | Tag-Pills, kleinste Marker           | `0.75rem` (12 px), DM Sans 500 |
  | `icon-sm`  | `--fs-icon-sm`    | Listen-Glyph (cat-icon)              | `1.0625rem` (17 px) |
  | `icon-md`  | `--fs-icon-md`    | Section-Glyph (cat-view-icon, fab.search-exit) | `1.375rem` (22 px) |
  | `icon-lg`  | `--fs-icon-lg`    | FAB-Plus                             | `1.625rem` (26 px) |
  | `icon-xl`  | `--fs-icon-xl`    | Empty-State-Hero                     | `3.25rem` (52 px) |

- **Button-Tokens** (`frontend/styles.css` `:root`):

  | Variable            | Verwendung                                             | Wert      |
  |---|---|---|
  | `--btn-chrome-size` | Hamburger, Modal-Back, Drawer-Close, Sync, Color-Swatch| `44px`    |
  | `--btn-fab-size`    | FAB, Search-Bar Höhe                                   | `50px`    |
  | `--btn-icon-size`   | Glyph in Chrome-Buttons (`‹ ✕ ⌕ …`)                    | `1.25rem` |

- **Einzelne Stelle anpassen:** Im CSS-Block der jeweiligen Klasse den
  Token-Aufruf überschreiben, z. B. `font-size: 1rem` lokal statt
  `var(--fs-callout)`. Globale Änderung: nur den Wert der CSS-Variable
  in `:root` anpassen, dann gilt sie überall.

- **Weitere zentrale Tokens** (`frontend/styles.css` `:root`):

  | Bereich        | Variable                       | Wert / Verwendung |
  |---|---|---|
  | Z-Layer        | `--z-toolbar`                  | `100` (Sticky-Header) |
  |                | `--z-floating`                 | `200` (Bottom-Bar) |
  |                | `--z-drawer-backdrop`          | `400` (Drawer-Dimmer) |
  |                | `--z-drawer`                   | `401` (Drawer-Panel) |
  |                | `--z-modal`                    | `500` (Sheet/Modal) |
  |                | `--z-toast`                    | `800` (Toast / System) |
  | Animation      | `--dur-fast`                   | `0.15s` (Tap-Feedback) |
  |                | `--dur-base`                   | `0.2s` (Default) |
  |                | `--dur-medium`                 | `0.25s` (Chrome-Buttons) |
  |                | `--dur-slow`                   | `0.3s` (Panel / Overlay) |
  | Focus          | `--focus-ring`                 | `0 0 0 3px var(--accent-tint)` |
  | Border         | `--border-hairline`            | `0.5px solid var(--hairline-soft)` |
  |                | `--border-hairline-strong`     | `0.5px solid var(--hairline)` |

- **Line Height:** `1.25` für DM Serif Display, `1.4` für DM Sans Body.
- **Letter Spacing:** Standard belassen; nicht künstlich aufweiten.
- **Zahlentabellen:** `font-variant-numeric: tabular-nums` für Spalten mit
  Beträgen, damit Stellen untereinander stehen.
- **Dynamic Type (Web-Pendant):** Keine festen `px`-Werte für Text – `rem`
  oder `em` verwenden, damit System-Zoom und Browser-Schriftgröße
  funktionieren.
- **Keine ALL-CAPS-Labels.** Wenn Hervorhebung nötig: Weight oder Farbe.

## Materialien (Blur, Vibrancy, Glass)

Referenz: [HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials).

Im Web stehen native Materialien nicht zur Verfügung, aber `backdrop-filter`
ist eine gute Annäherung. Sparsam einsetzen.

- **Wann Material:**
  - Fixierte Toolbars über scrollbarem Inhalt (oben / unten).
  - Sheets und Modals, die Inhalt teilweise sichtbar lassen.
- **Wann nicht:**
  - Card-Hintergründe in der Liste (lieber `--bg-canvas` + Border).
  - Flächen ohne Inhalt dahinter (Material wirkt dann beliebig).
- **Schichtung:** Max. 3 Ebenen – Canvas → Card → Material-Overlay.
  Keine geblurrten Materialien übereinander stapeln.
- **Fallback (`@supports not (backdrop-filter: blur(1px))`):** opaker
  `--bg-canvas` mit leichter Transparenz (`rgba(...)`), damit Inhalt nicht
  durchschimmert.
- **Performance:** `backdrop-filter` nur auf kleinen, statischen Flächen.
  Nicht auf scrollende Listen anwenden – iOS-Safari ruckelt sonst.
- **Vibrancy-Pendant:** Text auf Material immer `--text` (Light) bzw.
  `--text` (Dark) – keine reduzierte Opazität. Kontrast nach Material-
  Anwendung erneut prüfen.
- **Reduzierte Transparenz respektieren:**
  `@media (prefers-reduced-transparency: reduce)` → Material durch opake
  Fläche ersetzen.

## Liquid Glass

Referenz: [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass).

Liquid Glass ist Apples adaptives Material aus der jüngsten OS-Generation,
das Licht bricht, sich an Inhalt anpasst und je nach Kontext mehr oder
weniger sichtbar wird. Im Web ist es nicht 1 : 1 umsetzbar – wir folgen
den Prinzipien:

- **Wo verwenden:** Floating Toolbars (Bottom-Bar mit „+", Sync-Status),
  Modal-Header über gescrolltem Inhalt, „Floating Action Group". Nicht für
  großflächige Inhaltsbereiche.
- **Optisches Rezept (Web-Annäherung):**
  ```css
  .liquid-glass {
    background: color-mix(in oklab, var(--bg-canvas) 70%, transparent);
    backdrop-filter: blur(20px) saturate(140%);
    -webkit-backdrop-filter: blur(20px) saturate(140%);
    border: 1px solid color-mix(in oklab, var(--text) 8%, transparent);
    border-radius: 22px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.08);
  }
  ```
- **Adaptive Tönung:** Im Dark Mode dunklere Glasbasis, hellere Border.
  Über `prefers-color-scheme` automatisch.
- **Inhaltsadaption:** Symbole und Text auf Liquid Glass nutzen `--text` /
  `--text2`. Keine reine Akzentfarbe als Füllung – das frisst den
  Glas-Effekt auf.
- **Bewegung:** Wenn das Glas-Element sich verschiebt (z. B. beim Scrollen
  einrastet), `transition: transform 200ms ease-out`. Keine Spring-Effekte
  ohne Anlass.
- **Fallback:** `@supports not (backdrop-filter: blur(1px))` →
  opaker `--bg-canvas` mit Border und Schatten. Funktion bleibt erhalten.
- **Barrierefreiheit:** Bei `prefers-reduced-transparency: reduce` und
  `prefers-reduced-motion: reduce` Glas → opake Fläche, Bewegung →
  Sofort-Übergang.
- **Kontrast nicht verlieren:** Nach der Anwendung Text über typischem
  Hintergrundinhalt (z. B. Charts) testen – bei Bedarf
  `background-color`-Anteil erhöhen.

## App-Icons

Referenz: [HIG: App Icons](https://developer.apple.com/design/human-interface-guidelines/app-icons).

- **Speicherort:** `frontend/icons/` – wird im Manifest und über
  `apple-touch-icon` referenziert.
- **Erforderliche Varianten:**
  - `icon-192.png` (PWA, Android)
  - `icon-512.png` (PWA, Splashscreen)
  - `icon-maskable-512.png` (Android adaptive icon, safe zone ~ 80 %)
  - `apple-touch-icon.png` (180 × 180, iOS Homescreen, ohne Transparenz)
- **Design-Regeln:**
  - **Einfach:** Eine zentrale Form, keine Mini-Details. Aus der Ferne
    erkennbar.
  - **Vollflächig:** Hintergrund deckt das gesamte Quadrat. iOS schneidet
    selbst auf Squircle.
  - **Keine Transparenz** bei `apple-touch-icon` (iOS füllt sonst schwarz).
  - **Kein Text** im Icon – außer als wesentliches Logo-Element.
  - **Keine Fotos**, keine Screenshots, keine UI-Elemente im Icon.
  - **Farbpalette** entspricht der App: `--bg-canvas` Fläche, `--accent` als
    Akzent. Max. 3 Farben.
  - **Safe Zone für maskable:** zentrale 80 % – Logo darf nicht über diesen
    Bereich hinausragen.
- **Dark / Tinted (iOS 18+):** Optional eine separate Dark-Variante
  bereitstellen; sonst muss das normale Icon auch auf dunklem Homescreen
  funktionieren (ausreichend dunkler oder neutraler Hintergrund).
- **Build-Hygiene:** PNG, sRGB, ohne Alpha bei Apple-Touch-Icon.
  Quelle als SVG im Repo halten, PNGs aus SVG exportieren.

## Icons im UI

Referenz: [HIG: Icons](https://developer.apple.com/design/human-interface-guidelines/icons).

Zwei Icon-Systeme, strikt getrennt:

- **Kategorie-Icons (Phosphor Regular SVG-Sprite):**
  - Sprites in `frontend/icons/categories/sprite.svg` als `<symbol id="cat-…">`.
  - Neue Icons aus `github.com/phosphor-icons/core/assets/regular/` – **niemals**
    andere Sets mischen (bricht den einheitlichen Strichcharakter, Strichstärke 1.75 px).
  - ID wird in `categories.icon` gespeichert (`VARCHAR(64)`); beim Boot per
    `loadCategoryIconSprite()` ins DOM injiziert.
  - Neue Glyph → `<symbol>` ins Sprite + Eintrag in `CAT_ICON_GROUPS` in `app.js`.
- **UI-Chrome-Glyphen (Inline-SVG-Sprite in `index.html`):**
  - `<use href="#icon-menu|chevron-left|chevron-right|close|search|plus">`.
  - 24×24 Viewport, `stroke="currentColor"` – Icons erben Textfarbe.
  - Neue Chrome-Glyph → als `<symbol id="icon-…">` in den Sprite-Block in `index.html`.
- **Semantik:** Icon ohne Label nur wenn universell (Plus = neu, Mülleimer = löschen).
- **Accessibility:** `aria-label` mit Zweck, nicht Aussehen.
- **Strich-Stil:** Ausschließlich Outline – kein Mixing.

## Toolbars / Tab Bar / Navigation Bar

Referenz: [HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars).

PocketLog hat **eine Top-Bar** (App-Titel + Sekundäraktion) und **eine
Bottom-Bar** (Primäraktionen). Mehr braucht eine Single-Page-PWA nicht.

- **Top-Bar:**
  - Titel zentriert oder links – konsistent durchziehen.
  - Maximal 1 Sekundäraktion rechts (z. B. Einstellungen). Mehr in ein
    Overflow-Menü („…").
  - Höhe: `56px` + Safe-Area-Top.
  - Hintergrund: opak `--bg-canvas` oder Liquid Glass (s. o.) – nicht
    transparent ohne Material.
- **Bottom-Bar (Tab Bar):**
  - Maximal 5 Tabs / Aktionen, jeweils mit Icon **und** Label. Icon allein
    nur bei der zentralen Primäraktion („+").
  - Aktive Tab visuell deutlich (Farbe + Indikator), nicht nur Farbe.
  - Fixiert mit `position: fixed; bottom: 0`; Inhalt darunter braucht
    `padding-bottom`, damit nichts verdeckt wird.
- **Reihenfolge:**
  - Top-Bar: links Navigation/Zurück, mittig Titel, rechts Aktion.
  - Bottom-Bar: häufigste Aktion in der Mitte, Navigations-Tabs außen.
- **Aktionsdichte:** Primäraktion (z. B. „Buchung hinzufügen") nie in ein
  Menü verstecken. Selten benutzte Aktionen (Export, Einstellungen) dürfen
  in ein „…"-Menü.
- **Konsistenz:** Selber Toolbar-Stil auf allen Screens – Position, Höhe,
  Material identisch.
- **Inhalt scrollt unter der Bar.** Beim Scroll-Beginn keine Bar
  ein-/ausblenden – das verwirrt mehr, als es Platz spart.

## Suchfelder

Referenz: [HIG: Search Fields](https://developer.apple.com/design/human-interface-guidelines/search-fields).

PocketLog hat eine Suche in der Bottom-Bar (`#searchInput` links neben dem
FAB). Es gelten:

- **Platzierung:** Bewusst unten in der Bottom-Bar, abweichend von Apples
  Standard-Empfehlung „oben unter der Top-Bar". Begründung: Daumenreichweite
  auf großen Smartphones, räumliche Nähe zur Primäraktion (FAB im selben
  Floating-Strip) und konsistent zum Trend von Safari 15+ (URL-Bar unten).
  Im aktiven Such-Fokus (`body.searching`) werden Month-Nav und
  Summary-Cards ausgeblendet, damit die Trefferliste maximalen Platz bekommt.
- **Markup:** `<input type="search">`, damit iOS-Safari automatisch das
  Lupensymbol, „Clear"-Button und die richtige Tastatur rendert.
- **Platzhalter:** Sentence case, beschreibend und konkret –
  `„Buchungen durchsuchen"`, nicht `„Suchen…"` und nicht `„Suche"`.
- **Verhalten:** Live-Filter ab dem ersten Zeichen, `debounce` 150 ms.
  Keine Submit-Pflicht, kein expliziter Suchen-Button.
- **Cancel / Clear:**
  - Browser-eigener `×`-Button bei `type="search"` reicht; nicht zusätzlich
    eigenen Button rendern.
  - Bei aktivem Filter ein separater „Abbrechen"-Button rechts, der das
    Feld leert und den Fokus löst.
- **Scope / Filter:** Wenn Kategorien-Filter nötig, als Chip-Reihe **unter**
  dem Feld; keine Dropdowns im Feld selbst.
- **Letzte Suchen / Vorschläge:** Optional als Liste unter dem Feld, mit
  Trash-Icon zum Löschen einzelner Einträge. Lokal in `localStorage`, nicht
  im Backend speichern (Privacy).
- **Empty State:** Wenn die Suche nichts findet, klare Meldung mit Vorschlag
  – `„Keine Buchungen passen zu „xyz". Andere Schreibweise versuchen."`
- **Accessibility:** `<label>` (visuell versteckt) mit `for=` plus
  `aria-label` falls kein sichtbares Label. `role="search"` auf den
  umgebenden `<form>`.
- **Tastatur:** `enterkeyhint="search"`, `inputmode="search"`,
  `autocapitalize="off"`, `autocorrect="off"`, `spellcheck="false"`.

## Barrierefreiheit

Referenz: [HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility).

Pflichtprogramm – keine Ausnahme „weil PWA":

- **Semantisches HTML zuerst.** `<button>` statt `<div onclick>`,
  `<nav>`, `<main>`, `<section>`, `<h1…h3>` in korrekter Hierarchie.
- **Icon-only-Buttons:** `aria-label` mit Zweck, nicht Aussehen.
- **Live-Regionen:** `aria-live="polite"` für Sync-Status,
  Lade-Indikator, Toast-Meldungen. Nichts Wichtiges nur visuell.
- **Fokus:** Sichtbarer Fokusring auf allen interaktiven Elementen
  (`:focus-visible`). Niemals `outline: none` ohne Ersatz.
- **Tastaturbedienbarkeit:** Tab-Reihenfolge folgt der Lesefolge, alle
  Aktionen per Tastatur erreichbar, Modal fängt Fokus (`focus trap`)
  und stellt ihn beim Schließen wieder her.
- **Dynamische Schrift / Zoom:** Layout darf bis `200 %` Browser-Zoom
  nicht brechen. Keine festen `px`-Höhen, die Text abschneiden.
- **Kontrast:** `4.5 : 1` Text, `3 : 1` Grafik – im Light- *und*
  Dark-Mode.
- **Touch-Targets:** Mindestens `44 × 44px` – Punkt.
- **Bewegung:** `@media (prefers-reduced-motion: reduce)` →
  Übergänge auf `0.01ms`, keine Animationen, keine Parallaxe.
- **Transparenz:** `@media (prefers-reduced-transparency: reduce)` →
  Material durch opake Fläche ersetzen.
- **Farbe nie als einziges Signal:** Vorzeichen, Icon, Text ergänzen.
- **Screenreader-Texte:** Keine Richtungsangaben (kein „Button rechts
  oben"), kein „Bild von…", kein „Klicke hier".
- **Bilder / Charts:** Charts haben eine Text-Zusammenfassung darunter
  (Summe Einnahmen, Summe Ausgaben), die Screenreader vorlesen können.
- **Sprache:** `<html lang="de">` korrekt gesetzt.

## Schreibstil & Texte (Apple Style Guide)

→ Vollständige Regeln in [`docs/WRITING_GUIDE.md`](docs/WRITING_GUIDE.md).

Kurzregeln:
- **Sentence case:** Buttons, Titel, Labels kleingeschrieben außer Substantive.
- **Verb-first** bei Aktions-Buttons: „Speichern", „Löschen" – nicht „OK".
- **Direkt und aktiv:** „Betrag ungültig." – nicht „Ungültige Eingabe."
- **Kein „Bitte" / kein „Sorry"** – direkt formulieren.
- **Beträge** via `fmtCurrency(n)` (de-DE): `1.234,56 €`, Datum intern ISO 8601.
- Destruktive Aktionen immer mit „Abbrechen" ergänzen; Dialog-Öffner enden mit `…`.

