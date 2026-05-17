# HIG & Design Review

Führe eine vollständige Design-Prüfung der übergebenen Datei oder des genannten UI-Bereichs durch. Falls keine Datei genannt wird, prüfe `frontend/index.html`.

## Aufgabe

Lies die relevanten Bereiche von `frontend/index.html` (und ggf. `frontend/sw.js`, `frontend/db.js`) sowie `DESIGN_CONVENTIONS.md` und `CLAUDE.md`. Prüfe dann systematisch jeden der folgenden Punkte. Melde **jeden Fund** mit:

- **Fundort:** Zeile oder CSS-Klasse / JS-Funktion
- **Problem:** Was gegen die Regel verstößt
- **Fix:** Konkrete Korrektur (Code-Snippet wenn sinnvoll)

Gruppiere Funde nach Kategorie. Schreibe am Ende eine kurze Zusammenfassung: wie viele Funde pro Kategorie, was kritisch ist und was optional/nice-to-have.

## Ergebnis-Datei

Schreibe den Bericht **immer** in eine neue Datei `docs/DESIGN_REVIEW_<YYYY-MM-DD>.md` (Datum von heute). Format-Vorlage: das archivierte `docs/DESIGN_REVIEW_2026-05-15.md`.

Pflicht-Struktur der Datei:

- Header mit Datum, Bezug (geprüfte Dateien + Zeilenzahl), Grundlage (`DESIGN_CONVENTIONS.md`, Apple HIG, WCAG 2.2, `CLAUDE.md`)
- Hinweis-Satz: „Checkboxen zum Abhaken beim Bearbeiten. Reihenfolge folgt Priorität (Kritisch → Polish)."
- Funde nach Priorität sortiert (Kritisch → Hoch → Mittel → Niedrig), durchnummeriert
- Jeder Punkt mit `### [ ] N. Titel`, Fundort, kurzer Problembeschreibung und konkretem Fix-Snippet
- Zusammenfassungstabelle am Ende mit Anzahl pro Priorität + empfohlene Reihenfolge der Bearbeitung
- Akzeptanzkriterium pro Punkt nennen (Code geändert + Browser-Test Light/Dark/Tab-Nav)

Datei selbst legt nur die Funde an — keine eigenmächtigen Fixes im Code. Anschließend committen und auf die Branch pushen (siehe Branch-Vorgaben aus dem Session-Kontext); der User hakt die Punkte beim Abarbeiten ab.

---

## 1 · Design Tokens

- [ ] Keine Hex-/RGBA-Literale als `color`, `background`, `border-color` – ausschließlich `var(--…)` aus `:root`
- [ ] Alle Margins/Paddings aus der `--space-*`-Skala (2, 4, 8, 10, 12, 14, 16, 20, 24, 56) – keine freien `px`-Werte
- [ ] Schriftgrößen nur über `var(--fs-*)` – keine festen `rem`/`px` inline
- [ ] Radien via `var(--r-*)`, Schatten via `var(--shadow-*)`, Z-Layer via `var(--z-*)`, Animationsdauern via `var(--dur-*)`
- [ ] `color-mix(in oklab, var(--accent) X%, transparent)` statt `rgba(…)` für Akzent-Transparenzen

## 2 · Light/Dark Mode

- [ ] Kein hardcodiertes Schwarz/Weiß – immer `var(--bg-canvas)` / `var(--text)`
- [ ] Neue Farben haben einen Eintrag in beiden `:root`-Blöcken (`prefers-color-scheme: dark`)
- [ ] Material-Fallback für `prefers-reduced-transparency: reduce` vorhanden (opake Fläche statt Blur)

## 3 · Typografie

- [ ] Ausschließlich **DM Serif Display** + **DM Sans** – kein Inter, Roboto, Arial, System-Stack
- [ ] Kein `text-transform: uppercase` in Labels
- [ ] `font-variant-numeric: tabular-nums` auf Betragsspalten/-zellen
- [ ] Kein `px` für Schriftgrößen – `rem` oder `var(--fs-*)` verwenden
- [ ] `line-height: 1.25` für DM Serif Display, `1.4` für DM Sans Body

## 4 · Touch-Targets & Layout

- [ ] Alle interaktiven Elemente mindestens `44 × 44 px` – per `padding` vergrößert, nicht per festen Dimensionen
- [ ] `max-width: 430px`, zentriert, horizontale Innenränder `16px`
- [ ] Fixed-Bottom-Elemente: `padding-bottom: max(16px, env(safe-area-inset-bottom))`
- [ ] Top-Bar: `height: 56px` + `padding-top: env(safe-area-inset-top)`
- [ ] Kein horizontales Scrollen (außer bewusst bei Chart/Tag-Reihe)
- [ ] Lesebreite für Fließtext ≤ `60ch`

## 5 · Liquid Glass & Materialien

- [ ] Liquid Glass nur auf: Bottom-Bar, Modal-Header, Floating-Elemente – nicht auf Cards in der Liste
- [ ] CSS-Rezept korrekt: `backdrop-filter: blur(20px) saturate(140%)`, Border `color-mix(in oklab, var(--text) 8%, transparent)`, Radius `22px`
- [ ] Max. 3 Layer: Canvas → Card → Material-Overlay – keine gestapelten Blur-Effekte
- [ ] `@supports not (backdrop-filter: blur(1px))` Fallback vorhanden
- [ ] `prefers-reduced-transparency: reduce` → opake Fläche
- [ ] Performance: `backdrop-filter` nicht auf scrollenden Listen

## 6 · Icons & SVG

- [ ] Neue UI-Glyphen als `<symbol>` im Sprite ergänzt, kein Ad-hoc-Unicode oder externes SVG
- [ ] `stroke="currentColor"` / `fill="currentColor"` damit Icons die Textfarbe erben
- [ ] Strichstärke `1.5–2 px` bei `24×24px`; Outline-Stil durchgängig (kein Mix mit Filled)
- [ ] Icon-only-Buttons haben `aria-label` mit **Zweck** (nicht Aussehen)
- [ ] Kategorie-Icons: exakt ein Emoji, keine ZWJ-Ketten

## 7 · Toolbars & Navigation

- [ ] Top-Bar: links Navigation, mittig Titel, rechts max. 1 Sekundäraktion
- [ ] Bottom-Bar: max. 5 Einträge, jede Tab mit Icon **und** Label (außer zentraler FAB)
- [ ] Primäraktion (Buchung hinzufügen) nie in Overflow-Menü versteckt
- [ ] Toolbar-Stil (Höhe, Material, Position) auf allen Screens identisch
- [ ] Aktive Tab: Farbe + Indikator – nicht nur Farbe

## 8 · Animationen & Motion

- [ ] `@media (prefers-reduced-motion: reduce)` → alle Transitions auf `0.01ms`, keine Animationen
- [ ] Animationsdauer ausschließlich `var(--dur-fast/base/medium/slow)` – keine freien `s`/`ms`
- [ ] Keine Spring-Effekte ohne konkreten Anlass
- [ ] Liquid-Glass-Bewegung: `transition: transform var(--dur-base) ease-out`

## 9 · Barrierefreiheit

- [ ] Semantisches HTML: `<button>` statt `<div onclick>`, `<nav>`, `<main>`, `<section>`, `<h1…h3>` in korrekter Hierarchie
- [ ] `aria-live="polite"` auf Sync-Status, Lade-Indikator, Toast
- [ ] Sichtbarer Fokusring via `--focus-ring` auf allen interaktiven Elementen; kein `outline: none` ohne Ersatz
- [ ] Modals: Focus-Trap aktiv + Fokus nach Schließen zurückgesetzt
- [ ] Layout bis 200 % Browser-Zoom nicht gebrochen – keine festen `px`-Höhen die Text abschneiden
- [ ] WCAG AA: `4.5:1` Text, `3:1` Grafik – in Light **und** Dark prüfen
- [ ] Farbe nie als einziges Signal (Vorzeichen, Icon, Text ergänzen)
- [ ] Charts haben Text-Zusammenfassung für Screenreader
- [ ] `<html lang="de">` gesetzt

## 10 · Texte & Schreibstil (Apple Style Guide)

- [ ] Sentence case auf Deutsch – kein Title Case bei Buttons/Labels
- [ ] Verb-first-Buttons: „Speichern", „Löschen" – nicht „OK", „Ja"
- [ ] Destruktive Aktionen immer mit „Abbrechen"-Alternative
- [ ] Ellipse `…` (U+2026) – nicht `...`; En-Dash `–` (U+2013) – nicht `--`
- [ ] „Tippen" nicht „Klicken" im Touch-Kontext
- [ ] Fehlermeldungen: `[Was passiert.] [Wie beheben.]`; keine technischen Codes
- [ ] Terminologie-Tabelle beachten: „Buchung" statt „Transaktion" in der UI
- [ ] App-Name immer „PocketLog" – nie „Pocketlog" oder „pocket log"

## 11 · Offline & PWA

- [ ] Offline-Zustand sichtbar (Toast / Status-Indikator)
- [ ] Sync-Statustext korrekt: „Wird synchronisiert…" / „Gespeichert" / „Offline – Änderungen werden gespeichert" / „Synchronisation fehlgeschlagen – Verbindung prüfen"
- [ ] Neue API-Calls laufen über `api()` Helper (gleicher Origin oder `API`-Variable)
- [ ] POST/PUT/DELETE: Outbox-fähig oder explizit dokumentiert warum nicht nötig
- [ ] Neue statische Assets in `sw.js` precache-Liste eingetragen
