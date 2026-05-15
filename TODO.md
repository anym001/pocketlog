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
- **Icon-Größen in Tokens überführen.** Aktuell sitzen `cat-view-icon`
  (`1.375rem`), `cat-icon` (`1.0625rem`), `t-icon`
  (`var(--btn-icon-size)`), `fab` (`1.625rem`), `fab.search-exit`
  (`1.375rem`) und `empty-state .icon` (`3.25rem`) als Literale im CSS.
  Sinnvoll wären z. B. `--icon-sm` / `--icon-md` / `--icon-lg` /
  `--icon-illustration`, damit Emoji- und Symbol-Größen genauso zentral
  steuerbar werden wie die Text-Skala in `DESIGN_CONVENTIONS.md`.
