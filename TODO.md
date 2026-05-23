# TODO / Backlog

Bewusst zurückgestellte Punkte. Keine feste Reihenfolge — wer einen Eintrag
anfasst, ihn hier bitte gleich streichen.

## Features

- Echte App-Icons. Die aktuellen sind farbige Platzhalter, generiert mit einem
  Python-Snippet — kein Branding, keine Maskable-Sicherheitszone.
- Wiederkehrende Buchungen (monatlich, wöchentlich).
- Budget-Grenzen pro Kategorie inkl. Warnung im UI.
- Push-Benachrichtigungen bei Budget-Überschreitung.

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
- **Stärkerer Aktiv-Marker im Drawer-Mainmenü.** Aktuell wird der aktive
  Eintrag in `.drawer-nav-item.active` (`frontend/index.html`) nur über
  `color: var(--accent)` + `font-weight: 600` markiert. Farbe allein
  verstößt gegen WCAG 1.4.1 ("Use of Color") und ist gegen den
  Glas-Hintergrund schwach erkennbar. Ein zweites, formbasiertes Signal
  ergänzen — z. B. Akzent-Bar links (`box-shadow: inset 3px 0
  var(--accent)`, macOS-Sidebar-Look), Hintergrund-Pill mit
  `var(--accent-tint)` (iOS-Settings-Look) oder Trailing-Checkmark.
  Design-Review #16, dort als "nicht kritisch" markiert, weil der Marker
  ohnehin nur kurz sichtbar ist (Drawer schließt nach Auswahl).
- **SVG-Sprite in eigene Datei auslagern.** Aktuell sitzt der Inline-Sprite
  (`icon-menu`, `icon-chevron-left/-right`, `icon-close`, `icon-search`,
  `icon-plus`) direkt am `<body>`-Anfang in `frontend/index.html`. Bei
  sechs Glyphen kostet das ~1 KB HTML und spart einen Fetch — bei
  spürbarem Wachstum (20+ Icons) oder Wiederverwendung außerhalb der PWA
  Sinn macht ein konsolidiertes `frontend/svg/icons.svg`, referenziert
  via `<use href="/svg/icons.svg#icon-menu" />`. Beim Umzug daran denken:
  Service-Worker (`frontend/sw.js`) muss die Datei explizit cachen, sonst
  bricht der Offline-Modus.
