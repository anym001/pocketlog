# TODO / Backlog

Bewusst zurückgestellte Punkte. Keine feste Reihenfolge — wer einen Eintrag
anfasst, ihn hier bitte gleich streichen.

## Erstinbetriebnahme nach dem ersten Merge auf `main`

Einmalige Schritte, danach kann der Abschnitt raus.

- [ ] **GitHub-Package auf Public stellen.** GitHub → Profil → *Packages* →
  `pocketlog` → *Package settings* → *Change visibility* → **Public**. Erst
  danach kann Unraid `ghcr.io/anym001/pocketlog:latest` ohne Login pullen.
- [ ] **Container auf Unraid anlegen.** `unraid/pocketlog.xml` aus dem Repo
  herunterladen und nach `/boot/config/plugins/dockerMan/templates-user/`
  kopieren. Anschließend *Apps → Add Container → Template: pocketlog* wählen,
  Felder (DB_HOST, DB_PASSWORD, Netzwerk) prüfen und *Apply*.
- [ ] **SWAG + Authentik verdrahten.** `swag/pocketlog.subdomain.conf` nach
  `/swag/config/nginx/proxy-confs/` kopieren, SWAG neu laden. In Authentik
  einen Forward-Auth-Provider + Application für `pocketlog.<deinedomain>`
  anlegen und dem Outpost zuweisen. Im Proxy-Provider unter *Advanced
  protocol settings* die Option **"HTTP Basic authentication"** aktivieren,
  danach den Outpost neu deployen.

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

## Security

- **Backend-Port niemals außerhalb des SWAG-Netzwerks exponieren.** Der
  `X-Authentik-Username`-Header wird vom Backend ungeprüft als Identität
  übernommen — die Validierung passiert vorgelagert im Authentik-Outpost
  (HTTP-Basic-Auth-Modus). Solange der Backend-Port nur über SWAG erreichbar
  ist, kann der Header nicht gefälscht werden. Auf direkter LAN-Erreichbarkeit
  bleibt das Risiko bestehen.
  Weitergehende Härtung (falls je nötig): Shared-Secret-Header zwischen SWAG
  und Backend, mTLS zwischen den Containern, oder signierte JWTs aus Authentik
  (OIDC statt Forward Auth).

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
- **Versions-Tags / Release-Prozess dokumentieren.** Der Workflow unterstützt
  `vX.Y.Z`-Tags (→ Image-Tags `X.Y.Z` und `X.Y`), aber README/CLAUDE.md
  erwähnen keinen Release-Workflow. Solange nur `:latest` deployt wird,
  irrelevant.
