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
  anlegen und dem Outpost zuweisen.

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

- **Header-Trust-Modell härten.** Das Backend vertraut aktuell blind jedem
  `X-Authentik-Username`-Header. Wer Direktzugriff auf den Backend-Port
  hat (LAN, fehlkonfigurierte Port-Freigabe, fehlende Netzwerk-Isolation),
  kann jeden beliebigen User imitieren.
  Empfohlener nächster Schritt: ein Shared-Secret zwischen SWAG und Backend —
  SWAG injiziert einen zusätzlichen Header `X-Auth-Secret: <random>`, Backend
  prüft ihn gegen eine ENV-Variable und antwortet sonst 401.
  Alternativen: mTLS zwischen beiden Containern, signierte JWTs aus Authentik
  (OIDC statt Forward Auth).
  Bis das umgesetzt ist: Backend-Port niemals außerhalb des SWAG-Netzwerks
  exponieren.

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
