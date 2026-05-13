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
