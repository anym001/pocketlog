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

## Security

- **Backend-Port nicht direkt exponieren.** Der `X-Authentik-Username`-Header
  wird vom Backend als Identität übernommen — die Validierung läuft
  vorgelagert über die Authentik-Session (inkl. MFA). Zusätzlich prüft das
  Backend ein Shared Secret (`AUTH_SECRET` ENV, von SWAG via
  `X-Auth-Secret`-Header injiziert) per `hmac.compare_digest`. Solange das
  Secret gesetzt ist, scheitern Direktzugriffe auf Port 8000 mit gefälschten
  Headern. Trotzdem: Port 8000 nicht öffentlich erreichbar machen.
  Weitergehende Härtung (falls je nötig): mTLS zwischen den Containern oder
  signierte JWTs aus Authentik (OIDC statt Forward Auth).

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
