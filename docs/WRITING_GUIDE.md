# PocketLog – Schreibstil & Texte (Apple Style Guide)

Gilt für alle sichtbaren Texte in der UI. Regeln basieren auf dem
[Apple Style Guide](https://help.apple.com/pdf/applestyleguide/en_US/apple-style-guide.pdf)
und den [HIG: Writing](https://developer.apple.com/design/human-interface-guidelines/writing).

## Groß-/Kleinschreibung

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

## Aktions-Buttons

- Verb-first: „Speichern", „Löschen", „Importieren" – nicht „OK", „Ja", „Nein".
- Destruktive Aktionen (Löschen) immer mit „Abbrechen"-Button ergänzt,
  destruktiver Button visuell abgesetzt (bereits:
  `border:1px solid var(--accent)`).
- „Abbrechen" beendet Dialog ohne Änderungen; „Schließen" nur wenn nichts
  geändert werden konnte.
- Buttons, die einen weiteren Dialog öffnen, enden mit Ellipse:
  „Importieren…" (Unicode `…`, nicht `...`).

## Ton & Formulierung

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
- **Keine Füllphrasen:** Adjektive/Adverbien weglassen wenn kein Informationsgehalt.
- **Keine Ausrufezeichen:** Klingen bevormundend und unaufrichtig.

## Alerts & Fehlermeldungen

Struktur: **[Was ist passiert.] [Wie beheben.]**

- Gut: „Der Betrag ist ungültig. Bitte eine Zahl größer als null eingeben."
- Schlecht: „Fehler.", „Bitte alles ausfüllen."
- Alert-Titel: ein Satz oder Satzfragment, kein abschließender Punkt wenn
  Satzfragment.
- Alert-Text: vollständige Sätze, mit Punkt.
- Keine technischen Fehlercodes / Stack Traces in nutzer-sichtbaren Meldungen.
- Kurze Labels (Button-Text, einzelne Labels) **ohne** abschließenden Punkt.
- Mehrsätzige Hilfetexte und Beschreibungen enden **mit** Punkt.

## Terminologie (Deutsch)

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

## Zahlen & Währung

- Alle Beträge via `fmtCurrency(n)` (de-DE Locale): `1.234,56 €`
- Währungssymbol **nach** der Zahl: `12,50 €` – nicht `€12,50`
- Negativbeträge: Minuszeichen U+2212 (`−`), kein ASCII-Bindestrich –
  `Intl.NumberFormat` erledigt dies korrekt.
- Einheiten mit Leerzeichen: `5 MB`, `100 %` – nicht `5MB`, `100%`
- Prozent: Leerzeichen vor `%` in Deutsch: `42 %`

## Datum & Zeit

- Anzeige: `DD.MM.YYYY` oder relative Begriffe „Heute", „Gestern" (bereits
  umgesetzt).
- Monatsnamen ausschreiben wenn Platz vorhanden; nur kürzen wenn nötig
  (Jan, Feb, …).
- Intern immer ISO 8601: `YYYY-MM-DD`.
- Niemals Datums- / Zahlenformate hardcoden – immer `Intl.DateTimeFormat` /
  `Intl.NumberFormat`.

## Satzzeichen & Typografie

- Anführungszeichen: `„Text"` (deutscher Standard, bereits umgesetzt für
  Buchungstitel).
- Ellipse: `…` (U+2026), niemals drei Punkte `...`.
- Gedankenstrich: `–` (En-Dash, U+2013) für Einschübe in Deutsch; kein `--`.
- Apostroph: `'` (U+2019), nicht ASCII `'`.
- Keine doppelten Leerzeichen, kein harter Zeilenumbruch in UI-Labels.

## Touch & Interaktion

- Mindest-Tippfläche: **44 × 44 pt** für alle interaktiven Elemente.
- Berührungsaktionen mit „tippen" beschreiben – nicht „klicken" oder „drücken".
- Swipe-Gesten explizit benennen wenn nötig: „Wische nach links zum Löschen".

## Offline- & Sync-Zustand

| Zustand | Text |
|---|---|
| Aktiv | „Wird synchronisiert…" |
| Abgeschlossen | „Gespeichert" |
| Offline | „Offline – Änderungen werden gespeichert" |
| Fehler | „Synchronisation fehlgeschlagen – Verbindung prüfen" |
| Laden | „Buchungen werden geladen…" (nicht nur „Laden…") |
