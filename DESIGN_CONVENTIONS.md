# PocketLog – Design Conventions

Gilt für alle UI-Arbeiten im Frontend (`frontend/index.html`, `frontend/sw.js`,
`frontend/icons/`). Alle sichtbaren Texte sind deutsch, Code und Kommentare
englisch (siehe „Sprach-Konventionen" in [`CLAUDE.md`](CLAUDE.md)).

## Quellen

Diese Konventionen basieren auf den folgenden offiziellen Apple-Referenzen
und werden für eine Web-PWA pragmatisch übersetzt (Web-Pendants in
Klammern, wo iOS-spezifische APIs nicht verfügbar sind):

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Apple Style Guide (PDF)](https://help.apple.com/pdf/applestyleguide/en_US/apple-style-guide.pdf)
- [HIG: Writing](https://developer.apple.com/design/human-interface-guidelines/writing)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
- [HIG: App Icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout)
- [HIG: Icons](https://developer.apple.com/design/human-interface-guidelines/icons)
- [HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [HIG: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [HIG: Search Fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)

## Inhalt

1. [Grundprinzipien](#grundprinzipien)
2. [Layout & Safe Areas](#layout--safe-areas)
3. [Farbe & Theming](#farbe--theming)
4. [Typografie](#typografie)
5. [Materialien (Blur, Vibrancy, Glass)](#materialien-blur-vibrancy-glass)
6. [Liquid Glass](#liquid-glass)
7. [App-Icons](#app-icons)
8. [Icons im UI](#icons-im-ui)
9. [Toolbars / Tab Bar / Navigation Bar](#toolbars--tab-bar--navigation-bar)
10. [Suchfelder](#suchfelder)
11. [Barrierefreiheit](#barrierefreiheit)
12. [Schreibstil & Texte (Apple Style Guide)](#schreibstil--texte-apple-style-guide)

---

## Grundprinzipien

Apples drei klassische Designprinzipien gelten auch für PocketLog:

- **Klarheit (Clarity):** Text lesbar, Icons präzise, Layout luftig.
  Funktion vor Dekoration. Keine doppelte Information, kein visuelles Rauschen.
- **Zurückhaltung (Deference):** Die UI rahmt die Daten – die Buchungen, Beträge
  und Charts stehen im Vordergrund. Kein Schmuck, keine konkurrierenden Farben.
- **Tiefe (Depth):** Hierarchie über Schichten (Hintergrund → Inhalt → Modals),
  feinen Schatten und Bewegung, nicht über Skeuomorphismus.

Daraus folgt für PocketLog:

- **Mobile-first:** max-width `430px`, einspaltig, große Tippflächen.
- **Inhalt zuerst:** Beträge in DM Serif Display dominieren, sekundäre Labels
  in DM Sans treten zurück.
- **Plattform-Look auf iOS:** `display-mode: standalone`, `theme-color` passt zu
  `--bg-canvas`, `apple-touch-icon` ist gesetzt.

## Layout & Safe Areas

Referenz: [HIG: Layout](https://developer.apple.com/design/human-interface-guidelines/layout).

- **Container:** zentriert, `max-width: 430px`, horizontale Innenränder `16px`.
- **Vertikales Spacing-Raster:** `4 / 8 / 12 / 16 / 24 / 32` (Vielfache von 4).
  Spacing-Werte außerhalb dieser Skala vermeiden.
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
  CSS-Custom-Properties in `frontend/index.html` `:root`:**

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

- **Button-Tokens** (`frontend/index.html` `:root`):

  | Variable            | Verwendung                                             | Wert      |
  |---|---|---|
  | `--btn-chrome-size` | Hamburger, Modal-Back, Drawer-Close, Sync, Color-Swatch| `44px`    |
  | `--btn-fab-size`    | FAB, Search-Bar Höhe                                   | `50px`    |
  | `--btn-icon-size`   | Glyph in Chrome-Buttons (`‹ ✕ ⌕ …`)                    | `1.25rem` |

- **Einzelne Stelle anpassen:** Im CSS-Block der jeweiligen Klasse den
  Token-Aufruf überschreiben, z. B. `font-size: 1rem` lokal statt
  `var(--fs-callout)`. Globale Änderung: nur den Wert der CSS-Variable
  in `:root` anpassen, dann gilt sie überall.

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

PocketLog verwendet bewusst **Emoji als Kategorie-Icons** (siehe `categories.icon`)
und Unicode-Symbole / Inline-SVG für UI-Glyphen. SF Symbols ist iOS-exklusiv
und steht im Web nicht zur Verfügung.

- **Kategorie-Icons (Emoji):**
  - Genau **ein** Emoji pro Kategorie, keine Sequenzen, keine ZWJ-Ketten,
    die auf Android anders rendern.
  - Spalte ist `VARCHAR(8)` (mb4) – das reicht für ein Emoji inkl.
    Skin-Tone-Modifier.
  - Im Picker nur Emojis anbieten, die auf Apple, Google Noto und
    Microsoft Segoe gleich klar erkennbar sind.
- **UI-Glyphen (Aktion-Icons):**
  - Inline-SVG bevorzugen (keine externen Icon-Fonts, kein FontAwesome).
  - Strichstärke `1.5 – 2 px` bei `24 × 24px` Viewport.
  - Strichstärke passt zur Schriftstärke daneben.
  - Currentcolor (`stroke="currentColor"` / `fill="currentColor"`) damit
    Icons Text-Farbe erben.
  - Größe: 20 px innerhalb von Buttons, 24 px in Toolbars, 28 px für
    Hero-Aktionen.
- **Semantik:** Icon ohne Label nur, wenn die Bedeutung universell ist
  (Plus = neu, Mülleimer = löschen, Lupe = suchen, Zahnrad = Einstellungen).
  Alles andere bekommt zusätzlich Text.
- **Accessibility:** Jedes Icon-only-Element bekommt `aria-label` mit
  **Zweck**, nicht Aussehen („Buchung löschen", nicht „Mülleimer-Symbol").
- **Kein Mixing der Stile.** Entweder Outline oder Filled in der ganzen
  App – aktuell: Outline.

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

Aktuell hat PocketLog keine globale Suche; sobald eine kommt, gelten:

- **Platzierung:** Oben auf dem Screen, unter der Top-Bar – nicht in der
  Bottom-Bar.
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

Gilt für alle sichtbaren Texte in `frontend/index.html`. Regeln basieren auf
dem [Apple Style Guide](https://help.apple.com/pdf/applestyleguide/en_US/apple-style-guide.pdf)
und den [HIG: Writing](https://developer.apple.com/design/human-interface-guidelines/writing).

### Groß-/Kleinschreibung

Alle sichtbaren deutschen UI-Texte folgen **deutscher Rechtschreibung
(Sentence case):** Am Satzanfang großgeschrieben, Substantive groß, alles
andere klein. Verben, Adjektive, Adverbien und Präpositionen werden
**nicht** zusätzlich großgeschrieben – auch nicht in Buttons oder
Bildschirmtiteln. Das weicht bewusst vom englischen „Title Case" ab und
folgt Apples deutscher UI-Praxis sowie der Duden-Konvention.

| UI-Element | Beispiel |
|---|---|
| Buttons (Aktionen) | „Ausgabe speichern", „Als CSV exportieren", „Aus CSV importieren…" |
| Bildschirmtitel | „Buchung bearbeiten", „Neue Buchung" |
| Tab-Labels / Drawer-Einträge | „Transaktionen", „Auswertungen", „Einstellungen" |
| Abschnittsüberschriften | „Erscheinungsbild", „Startansicht", „Allgemein" |
| Alert-Titel | „Buchung wirklich löschen?" |
| Alert-Text / Fehlermeldungen | „Betrag und Datum sind Pflichtfelder." |
| Formular-Feldlabels | „Betrag (€)", „Beschreibung (optional)" |
| Platzhaltertexte | „Buchungen durchsuchen", „z. B. Supermarkt" |
| Checkbox- / Toggle-Labels | „System", „Hell", „Dunkel" |

Sonderfälle:

- **Abkürzungen** in Großbuchstaben behalten: CSV, API, URL, WLAN, PWA,
  MFA, ID, PDF.
- **Eigennamen / Markennamen** wie geschrieben übernehmen.
- **App-Name:** „PocketLog" – immer genau so, nie „Pocketlog" oder
  „pocket log".
- **Kein ALL-CAPS** in UI-Labels (`text-transform: uppercase` ist
  verboten – wirkt aggressiv, schlechte Lesbarkeit).
- **„OK"** (nicht „Ok" oder „Okay") nur für einfache Bestätigungen ohne
  Handlungsalternative; sonst Verb-Button bevorzugen.

### Aktions-Buttons

- Verb-first: „Speichern", „Löschen", „Importieren" – nicht „OK", „Ja", „Nein".
- Destruktive Aktionen (Löschen) immer mit „Abbrechen"-Button ergänzt,
  destruktiver Button visuell abgesetzt (bereits:
  `border:1px solid var(--accent)`).
- „Abbrechen" beendet Dialog ohne Änderungen; „Schließen" nur wenn nichts
  geändert werden konnte.
- Buttons, die einen weiteren Dialog öffnen, enden mit Ellipse:
  „Importieren…" (Unicode `…`, nicht `...`).

### Ton & Formulierung

- **Direkt und spezifisch:** „Betrag muss größer als null sein." – nicht
  „Ungültige Eingabe."
- **Aktiv statt passiv:** „Buchung löschen" – nicht „Die Buchung wird gelöscht."
- **Kein „Bitte" / kein „Sorry":** Klingt hohl und umständlich. Stattdessen
  direkt formulieren.
- **Keine Vorwürfe:** Nicht „Du hast ein ungültiges Datum eingegeben." →
  „Das eingegebene Datum ist ungültig."
- **Zweite Person (du/Sie):** Nutzer direkt ansprechen – „Deine Buchungen",
  nicht „Die Buchungen".
- **Präsens bevorzugen:** „Tippe auf +, um eine Buchung hinzuzufügen." –
  nicht „Durch Tippen wird eine Buchung hinzugefügt."
- **Keine Füllphrasen:** „Um…" statt „Um…zu" kürzen. Adjektive/Adverbien
  weglassen wenn sie keinen Informationsgehalt haben.
- **Keine Ausrufezeichen:** Klingen bevormundend und unaufrichtig.
- Kontraktionen (Kurzformen) sparsam – erschweren die Lokalisierung.

### Alerts & Fehlermeldungen

Struktur: **[Was ist passiert.] [Wie beheben.]**

- Gut: „Der Betrag ist ungültig. Bitte eine Zahl größer als null eingeben."
- Schlecht: „Fehler.", „Bitte alles ausfüllen."
- Alert-Titel: ein Satz oder Satzfragment, kein abschließender Punkt wenn
  Satzfragment.
- Alert-Text: vollständige Sätze, mit Punkt.
- Keine technischen Fehlercodes / Stack Traces in nutzer-sichtbaren Meldungen.
- Kurze Labels (Button-Text, einzelne Labels) **ohne** abschließenden Punkt.
- Mehrsätzige Hilfetexte und Beschreibungen enden **mit** Punkt.

### Terminologie (Deutsch)

| Verwenden | Nicht verwenden |
|---|---|
| Tippen | Klicken (Touch-Kontext) |
| Auswählen | Klicken (plattformneutral) |
| Wischen, Ziehen | Swipen, Draggen |
| Anmelden / Abmelden | Einloggen / Ausloggen / Login |
| App | Applikation, Anwendung |
| WLAN | WiFi, W-LAN |
| E-Mail | Email, eMail |
| Gerät | Device |
| Einstellungen | Settings, Optionen (als Menüpunkt) |
| Buchung | Transaktion (in der UI; im Code weiter `transaction`) |
| Leere-Zustand-Meldung | „Noch keine Buchungen. Tippe auf + um die erste hinzuzufügen." |

### Zahlen & Währung

- Alle Beträge via `fmtCurrency(n)` (de-DE Locale): `1.234,56 €`
- Währungssymbol **nach** der Zahl: `12,50 €` – nicht `€12,50`
- Negativbeträge: Minuszeichen U+2212 (`−`), kein ASCII-Bindestrich –
  `Intl.NumberFormat` erledigt dies korrekt.
- Einheiten mit Leerzeichen: `5 MB`, `100 %` – nicht `5MB`, `100%`
- Prozent: Leerzeichen vor `%` in Deutsch: `42 %`

### Datum & Zeit

- Anzeige: `DD.MM.YYYY` oder relative Begriffe „Heute", „Gestern" (bereits
  umgesetzt).
- Monatsnamen ausschreiben wenn Platz vorhanden; nur kürzen wenn nötig
  (Jan, Feb, …).
- Intern immer ISO 8601: `YYYY-MM-DD`.
- Niemals Datums- / Zahlenformate hardcoden – immer `Intl.DateTimeFormat` /
  `Intl.NumberFormat`.

### Satzzeichen & Typografie

- Anführungszeichen: `„Text"` (deutscher Standard, bereits umgesetzt für
  Buchungstitel).
- Ellipse: `…` (U+2026), niemals drei Punkte `...`.
- Gedankenstrich: `–` (En-Dash, U+2013) für Einschübe in Deutsch; kein `--`.
- Apostroph: `'` (U+2019), nicht ASCII `'`.
- Keine doppelten Leerzeichen, kein harter Zeilenumbruch in UI-Labels.

### Touch & Interaktion

- Mindest-Tippfläche: **44 × 44 pt** für alle interaktiven Elemente.
- Berührungsaktionen mit „tippen" beschreiben – nicht „klicken" oder „drücken".
- Swipe-Gesten explizit benennen wenn nötig: „Wische nach links zum Löschen".

### Offline- & Sync-Zustand

Spezifisch statt generisch – Nutzer wissen, was gerade passiert:

| Zustand | Text |
|---|---|
| Aktiv | „Wird synchronisiert…" |
| Abgeschlossen | „Gespeichert" |
| Offline | „Offline – Änderungen werden gespeichert" |
| Fehler | „Synchronisation fehlgeschlagen – Verbindung prüfen" |
| Laden | „Buchungen werden geladen…" (nicht nur „Laden…") |
