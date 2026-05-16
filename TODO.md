# TODO / Backlog

Bewusst zurückgestellte Punkte. Keine feste Reihenfolge — wer einen Eintrag
anfasst, ihn hier bitte gleich streichen.

## Features

- Echte App-Icons. Die aktuellen sind farbige Platzhalter, generiert mit einem
  Python-Snippet — kein Branding, keine Maskable-Sicherheitszone.
- Wiederkehrende Buchungen (monatlich, wöchentlich).
- Budget-Grenzen pro Kategorie inkl. Warnung im UI.
- Push-Benachrichtigungen bei Budget-Überschreitung.
- Statistik-/Diagrammansichten über mehrere Monate / das gesamte Jahr.
- **Tablet-/Desktop-Layout.** Aktuell hat `body` ein hartes
  `max-width: 430px` (`frontend/index.html`) — auf iPad und Mac sieht der
  Nutzer also nur eine 430-px-Spalte mit viel Leerraum, obwohl iPhone +
  iPad + Mac laut Architektur-Diagramm in `CLAUDE.md` Ziel-Plattformen
  sind. Mindestens ein `@media (min-width: 768px)`-Branch fehlt — z. B.
  zweispaltig (Liste + Detail), breitere Karten oder Dashboard-Anordnung.
  Eigener Plan/Spike, nicht im selben PR mit Bugfixes
  (Design-Review #15).

## PWA / Offline

- Service-Worker Background-Sync nutzt aktuell fix `/api` als Basis. Bei
  konfigurierter externer Backend-URL flusht nur die fenstergetriggerte
  `syncNow()` — Hintergrund-Sync bei geschlossenem Tab erst beim nächsten
  Öffnen.

## Nice-to-haves

Nicht dringend, eher Komfort/Reifegrad. Reihenfolge egal.

- **Tests in der CI.** Der Workflow baut aktuell nur das Image. Ein kleiner
  `pytest`-Step davor könnte z.B. den Schema-Roundtrip (Frontend-Body →
  Pydantic → DB-Spalte → Response) oder den CSV-Import-Parser absichern.
  Hängt davon ab, ob automatisierte Tests dauerhaft gepflegt werden sollen.
- **`/api/health` für externes Monitoring freigeben.** Liegt aktuell hinter
  Authentik, also kein Uptime-Check von außen ohne Token. Bei Bedarf in SWAG
  einen Location-Block für `/api/health` ohne `authentik-location.conf`
  anlegen.
- **SVG-Sprite in eigene Datei auslagern.** Aktuell sitzt der Inline-Sprite
  (`icon-menu`, `icon-chevron-left/-right`, `icon-close`, `icon-search`,
  `icon-plus`) direkt am `<body>`-Anfang in `frontend/index.html`. Bei
  sechs Glyphen kostet das ~1 KB HTML und spart einen Fetch — bei
  spürbarem Wachstum (20+ Icons) oder Wiederverwendung außerhalb der PWA
  Sinn macht ein konsolidiertes `frontend/svg/icons.svg`, referenziert
  via `<use href="/svg/icons.svg#icon-menu" />`. Beim Umzug daran denken:
  Service-Worker (`frontend/sw.js`) muss die Datei explizit cachen, sonst
  bricht der Offline-Modus.
