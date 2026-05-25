# Design: Drawer-Navigation & Kategorienansicht

**Datum:** 2026-05-14  
**Status:** Approved

## Überblick

Die bestehende Bottom-Tab-Navigation (Buchungen / Auswertung) wird entfernt. Die Hauptnavigation wandert vollständig in den Drawer. Eine neue Kategorienansicht zeigt Ausgaben und Einnahmen je Kategorie für den aktuellen Monat. Die Bilanz-Karte in der Summary-Section entfällt.

---

## 1. Drawer-Navigation (Hauptebene)

Vier Einträge im Drawer-Hauptpanel (`dpMain`), in dieser Reihenfolge:

| Eintrag | Aktion |
|---|---|
| Kategorien | `showPanel('categories')` + Drawer schließen |
| Transaktionen | `showPanel('transactions')` + Drawer schließen |
| Auswertung | `showPanel('charts')` + Drawer schließen |
| Einstellungen › | `drawerNav('dpSettings')` |

Das aktive Drawer-Nav-Item wird visuell hervorgehoben (Accent-Farbe, analog zu bisherigen aktiven Tabs).

Beim Öffnen des Drawers wird das zum aktiven Panel passende Item markiert.

---

## 2. Bottom-Nav entfernen

Das `<div class="nav">` mit den beiden Tab-Buttons (Buchungen / Auswertung) wird vollständig aus dem HTML entfernt. Die zugehörigen CSS-Klassen (`.nav`, `.nav-tab`) können ebenfalls entfernt werden.

---

## 3. Bilanz-Karte entfernen

Die dritte Summary-Karte (`summary-card full`) mit Label „Bilanz", dem `#balance`-Element und dem `#balanceBar` wird aus dem HTML entfernt. Die Ausgaben- und Einnahmen-Karten bleiben erhalten.

Aus `renderAll()` werden die drei Zeilen entfernt, die `balance`, `balance` className und `balanceBar` setzen. Die Berechnungsvariable `bal` und `pct` werden ebenfalls entfernt.

---

## 4. Panel-System: neues `panel-categories`

Ein neues Panel `<div class="panel" id="panel-categories">` wird neben den bestehenden Panels eingefügt. Es enthält einen Container `<div id="categoryViewList">`.

`showPanel()` wird erweitert:
- Schaltet weiterhin `.panel.active` um
- Ruft bei `'categories'` die neue `renderCategoryView()` auf
- Markiert das passende Drawer-Nav-Item als aktiv (Klasse `active`)
- Schließt den Drawer (`closeDrawer()`)

---

## 5. Kategorienansicht (`renderCategoryView`)

### Datengrundlage
- Nutzt das bereits geladene `transactions`-Array (aktueller Monat, gefiltert über `loadAndRender`)
- Nutzt das bereits geladene `categories`-Array

### Darstellung
Eine Liste, eine Zeile pro Kategorie:

```
[Icon]  [Name]                    [Betrag]
 🛒     Lebensmittel             −234,50 €
 🚗     Auto                     −180,00 €
```

- **Icon** links
- **Name** linksbündig in der Mitte
- **Betrag** rechtsbündig: Summe aller Buchungen dieser Kategorie im aktuellen Monat
  - Ausgaben (type=`out`): Accent-Farbe (negatives Vorzeichen via `fmtCurrency`)
  - Einnahmen (type=`in`): Grün (positives Vorzeichen via `fmtCurrency`)
  - Hat eine Kategorie sowohl Ein- als auch Ausgaben: Nettobetrag wird angezeigt
- **Sortierung:** alphabetisch nach Kategoriename (case-insensitive, `localeCompare`)
- **Filter:** Kategorien ohne Buchungen im aktuellen Monat werden ausgeblendet
- **Empty State:** wenn keine Buchungen vorhanden, analog zur bestehenden Leer-Zustand-Meldung in der Transaktionsansicht

### Aktualisierung
`renderCategoryView()` wird aufgerufen:
- Wenn `showPanel('categories')` ausgeführt wird
- Am Ende von `renderAll()` (sofern das aktive Panel `categories` ist)

---

## 6. Einstellung: Startansicht

### Ort im Drawer
Neues viertes Item im `dpSettings`-Panel: **„Darstellung"**, platziert zwischen „Import/Export" und dem (ggf. vorhandenen) Ende der Liste. Öffnet neues Panel `dpDisplay`.

### Inhalt des `dpDisplay`-Panels
Zwei Radio-ähnliche Auswahlfelder:

> **Startansicht**  
> ○ Transaktionen  
> ○ Kategorien

- Gespeichert in `localStorage` unter `pocketlog.defaultView`
- Standardwert: `'transactions'`
- Beim App-Start wird `showPanel(defaultView)` aufgerufen

---

## 7. Betroffene Dateien

| Datei | Änderungen |
|---|---|
| `frontend/index.html` | HTML: Bottom-Nav entfernen, Bilanz-Karte entfernen, Drawer-Nav-Items hinzufügen, `panel-categories` hinzufügen, `dpDisplay`-Panel hinzufügen |
| `frontend/index.html` | CSS: `.nav`, `.nav-tab` entfernen; `.drawer-nav-item.active`-Stil hinzufügen |
| `frontend/index.html` | JS: `showPanel()` erweitern, `renderAll()` bereinigen, `renderCategoryView()` neu, Default-View-Logik beim Init |
