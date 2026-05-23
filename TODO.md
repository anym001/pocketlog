# TODO / Backlog

Bewusst zurückgestellte Punkte. Keine feste Reihenfolge — wer einen Eintrag
anfasst, ihn hier bitte gleich streichen.

## Features

- Wiederkehrende Buchungen (monatlich, wöchentlich).
- Budget-Grenzen pro Kategorie inkl. Warnung im UI.
- Push-Benachrichtigungen bei Budget-Überschreitung.

## Nice-to-haves

Nicht dringend, eher Komfort/Reifegrad. Reihenfolge egal.

- **Tests in der CI.** Der Workflow baut aktuell nur das Image. Ein kleiner
  `pytest`-Step davor könnte z.B. den Schema-Roundtrip (Frontend-Body →
  Pydantic → DB-Spalte → Response) oder den CSV-Import-Parser absichern.
  Hängt davon ab, ob automatisierte Tests dauerhaft gepflegt werden sollen.
- **SVG-Sprite in eigene Datei auslagern.** Aktuell sitzt der Inline-Sprite
  (`icon-menu`, `icon-chevron-left/-right`, `icon-close`, `icon-search`,
  `icon-plus`) direkt am `<body>`-Anfang in `frontend/index.html`. Bei
  sechs Glyphen kostet das ~1 KB HTML und spart einen Fetch — bei
  spürbarem Wachstum (20+ Icons) oder Wiederverwendung außerhalb der PWA
  Sinn macht ein konsolidiertes `frontend/svg/icons.svg`, referenziert
  via `<use href="/svg/icons.svg#icon-menu" />`. Beim Umzug daran denken:
  Service-Worker (`frontend/sw.js`) muss die Datei explizit cachen, sonst
  bricht der Offline-Modus.
