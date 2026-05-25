# Feature Review – Usability & Flow

Führe eine vollständige Usability- und Ablauf-Prüfung für ein neues oder geändertes Feature durch.

**Aufruf:** `/feature-review <Featurename oder kurze Beschreibung>`

Falls du nicht weißt, welches Feature gemeint ist, frage kurz nach: Wie heißt das Feature, was soll es ermöglichen, und wer sind die primären Nutzer?

## Schritt 1 – Kontext verstehen

Lies zuerst:
- `CLAUDE.md` (Architektur, API-Endpoints, Auth-Konzept)
- `DESIGN_CONVENTIONS.md` (Grundprinzipien, Navigation, Toolbars)
- Relevante Abschnitte in `frontend/index.html` (bestehende Views, Flows, JS-Funktionen)
- Relevante Abschnitte in `backend/app/` (bestehende Endpoints, Schemas, CRUD)

Fasse in 2–3 Sätzen zusammen, was das Feature macht und welchen Nutzen es bringt.

---

## Schritt 2 – User-Flow-Analyse

Beschreibe den vollständigen Flow als nummerierte Schritte:

```
1. Einstiegspunkt: Wo/wie gelangt der Nutzer zum Feature?
2. Hauptaktion: Was ist die Kerninteraktion?
3. Zwischenzustände: Was passiert während des Vorgangs?
4. Erfolgszustand: Was sieht der Nutzer nach Abschluss?
5. Rückkehr: Wie kehrt der Nutzer zur Hauptansicht zurück?
```

Prüfe dann:

- [ ] **Einstieg erreichbar?** Ist der Einstiegspunkt in der Bottom-Bar, einem Kontextmenü oder einer klaren Aktion – oder muss der Nutzer suchen?
- [ ] **Primäraktion sichtbar?** Die wichtigste Aktion ist ohne Scrollen und ohne Menü erreichbar
- [ ] **Rückweg klar?** Es gibt immer einen „Abbrechen"- oder „Zurück"-Pfad ohne Datenverlust
- [ ] **Maximale Tiefe:** Der Flow hat max. 3 Screen-Ebenen (Hauptansicht → Detail → Modal/Sheet)
- [ ] **Tastatur/Eingabe:** Wenn Formulare vorhanden – `inputmode`, `enterkeyhint`, `autocapitalize`, `autocomplete` korrekt gesetzt?

---

## Schritt 3 – Vollständigkeit der UI-Zustände

Für jede neue View oder Komponente: Alle Zustände abgebildet?

| Zustand | Vorhanden? | Beschreibung / Fundort |
|---|---|---|
| **Leer (Empty State)** | ✅ / ❌ | Klare Meldung + Handlungsaufforderung, kein leeres Layout |
| **Laden (Loading)** | ✅ / ❌ | Skeleton oder Spinner, nie Leeraum ohne Feedback |
| **Fehler (Error)** | ✅ / ❌ | `[Was passiert.] [Wie beheben.]` – kein tech. Fehlercode |
| **Offline** | ✅ / ❌ | Einschränkungen sichtbar, Outbox-Hinweis wenn relevant |
| **Erfolg** | ✅ / ❌ | Bestätigung ohne modalen Block (Toast oder Inline) |
| **Destruktive Aktion** | ✅ / ❌ | Confirmation-Dialog mit Verb-Button + „Abbrechen" |

Fehlende Zustände als **kritische Funde** markieren.

---

## Schritt 4 – Konsistenz mit bestehenden Patterns

- [ ] **Navigation:** Nutzt das Feature Bottom-Bar, Top-Bar, Drawer oder Modal nach dem bestehenden Schema aus `DESIGN_CONVENTIONS.md`?
- [ ] **Formulare:** Gleiche Struktur wie bestehende Sheets (Buchung hinzufügen/bearbeiten): Label → Input → Fehlermeldung unter dem Feld?
- [ ] **Bestätigung/Abbruch:** Buttons in gleicher Reihenfolge wie bestehende Dialoge (Abbrechen links, primäre Aktion rechts)?
- [ ] **Swipe-Gesten:** Swipe-to-Delete nur auf Listenelementen – nicht auf anderen Flächen?
- [ ] **Toast statt Alert:** Erfolgs- und Info-Meldungen als Toast (`aria-live`), kein `window.alert()`
- [ ] **Gleiche Terminologie:** „Buchung" statt „Transaktion", „Tippen" statt „Klicken" in allen neuen Texten

---

## Schritt 5 – Backend- & Datenfluss-Review

- [ ] Braucht das Feature neue API-Endpoints? Falls ja: in `main.py`, `schemas.py`, `crud.py` angelegt, `user_id`-Filterung vorhanden?
- [ ] Neue Datenbankfelder? → Alembic-Revision nötig, kein manuelles `ALTER TABLE`
- [ ] Schreibvorgänge laufen über den `api()` Helper → automatisch Outbox-fähig
- [ ] Leseoperationen gecacht oder tolerant gegenüber Offline-Zustand?
- [ ] Auth: Kein Endpoint ohne `CurrentUser`-Dependency erreichbar

---

## Schritt 6 – Barrierefreiheit (Feature-spezifisch)

- [ ] Neue interaktive Elemente: Touch-Target ≥ 44×44 px
- [ ] Dynamische Inhalte (Ergebnisse, Status): `aria-live="polite"` gesetzt
- [ ] Modals/Sheets: Focus-Trap + Fokus-Rückgabe beim Schließen
- [ ] Icon-only-Buttons: `aria-label` mit Zweck
- [ ] Neue Animationen respektieren `prefers-reduced-motion`

---

## Schritt 7 – Abschlussbewertung

Bewerte das Feature in drei Kategorien:

**Kritisch (muss vor dem Merge behoben werden)**
→ Fehlende Fehlerzustände, fehlende Barrierefreiheit, Navigation ohne Rückweg, kein Offline-Handling bei Schreibvorgängen

**Wichtig (sollte im gleichen PR behoben werden)**
→ Inkonsistente Patterns, fehlende Empty States, falsche Terminologie

**Optional (kann als Follow-up Issue angelegt werden)**
→ Verbesserungsvorschläge, alternative Flows, Nice-to-have-Zustände

Gib eine klare Empfehlung: **Merge-ready / Überarbeitung nötig / Grundlegendes Problem**.

---

## Schritt 8 – Ergebnis-Datei

Schreibe den Bericht **immer** in eine neue Datei `docs/FEATURE_REVIEW_<feature-slug>_<YYYY-MM-DD>.md` (Slug: kebab-case-Kurzname des Features, Datum von heute). Format-Vorlage: das archivierte `docs/DESIGN_REVIEW_2026-05-15.md`.

Pflicht-Struktur der Datei:

- Header mit Datum, Featurename, Bezug (geänderte/relevante Dateien + Zeilenzahl), Grundlage (`DESIGN_CONVENTIONS.md`, `CLAUDE.md`)
- Hinweis-Satz: „Checkboxen zum Abhaken beim Bearbeiten. Reihenfolge folgt Priorität (Kritisch → Polish)."
- Kurze Feature-Zusammenfassung (2–3 Sätze) aus Schritt 1
- Tabelle der UI-Zustände aus Schritt 3 als eigener Abschnitt
- Funde nach Priorität sortiert (Kritisch → Wichtig → Optional), durchnummeriert
- Jeder Punkt mit `### [ ] N. Titel`, Fundort, kurzer Problembeschreibung und konkretem Fix-Snippet
- Abschluss-Empfehlung (Merge-ready / Überarbeitung nötig / Grundlegendes Problem) plus Zusammenfassungstabelle (Anzahl pro Priorität)

Datei selbst legt nur die Funde an — keine eigenmächtigen Fixes im Code. Anschließend committen und auf die Branch pushen (siehe Branch-Vorgaben aus dem Session-Kontext); der User hakt die Punkte beim Abarbeiten ab.
