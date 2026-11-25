# Prompt für die THNLink-Plugin-Implementierung

Implementiere die Gegenstelle für TattyHost in THNLink. Prüfe zuerst den
vorhandenen Plugin-Code und integriere die Änderungen in seine bestehenden
Konfigurations-, Threading- und Backup-Strukturen. Nimm keine Änderungen am
TattyHost-Webprojekt vor.

## Sicherheit und Verbindung

- Die Plugin-zu-Web-Verbindung nutzt HTTPS und
  `Authorization: Bearer <service-key>`. Der Schlüssel gehört genau zu einem
  Server, wird nur in der geschützten Plugin-Konfiguration gespeichert und
  niemals protokolliert oder an die lokale API weitergegeben.
- Die lokale HTTP-API bindet ausschließlich an Loopback, standardmäßig
  `127.0.0.1`, mit einem bei jedem Plugin-Start neu gewählten Port. Sie hat
  keine Authentifizierung und darf niemals öffentlich erreichbar sein.
- Netzwerk- und Dateioperationen nicht auf dem Minecraft-Hauptthread
  blockieren; Bukkit/Paper-Zugriffe und Live-Restore auf dem richtigen
  Serverthread ausführen. Fehler sichtbar melden; POST nicht automatisch
  wiederholen.
- Die Web-API antwortet bei Fehlern mit JSON `{ "error": "..." }`. Fehlende
  oder ungültige Service-Schlüssel ergeben 401; Limits können 429 ergeben.

## Heartbeat und Whitelist

Sende bei Bereitschaft und danach etwa alle 30 Sekunden
`PUT /api/services/status` mit `Content-Type: application/json`:

```json
{"status":"online","details":"Ready","players":{"online":3,"max":20},"minecraftVersion":"26.1","api":{"port":43127}}
```

Port mit dem **aktuellen** lokalen API-Port ersetzen. Auch `maintenance` ist
möglich. Erfolg ist `204`, ohne Antwortkörper.

Rufe alle 30 Sekunden `GET /api/services/whitelist` ab. Verwende den ETag der
letzten erfolgreich gespeicherten vollständigen Liste als `If-None-Match`;
bei `304` bleibt die bestehende Liste unverändert. Nach einem Neustart ohne
verfügbare lokale Liste darf kein alter ETag gesendet werden. `200` liefert
`{"revision":12,"players":[{"uuid":"01234567-89ab-cdef-0123-456789abcdef","name":"Player"}]}`.
Auch `players: []` ist gültig und muss die lokale Whitelist leeren. UUIDs
sind kanonisch, Namen 1–16 Zeichen `[A-Za-z0-9_]`; die Liste ist vollständig,
höchstens 10.000 Einträge und 1 MiB groß. Änderungen atomar übernehmen und
fehlerhafte Antworten niemals als leere Liste behandeln.

## Spielstatistiken

Sende alle 30 Sekunden alle aktuell online befindlichen Spieler zusammen an
`PUT /api/services/players/stats`; beim Verlassen zusätzlich einen letzten
Eintrag mit `online:false`. Erfolg ist `204`. Beispiel:

```json
{"players":[{"uuid":"01234567-89ab-cdef-0123-456789abcdef","name":"Player","lastSeen":1764076800000,"online":true,"playtimeTicks":123456,"deaths":4,"mobKills":8,"playerKills":1,"level":10,"health":20,"foodLevel":20,"gameMode":"SURVIVAL","world":"world","x":1.5,"y":64,"z":2.5,"primaryGroup":"default"}]}
```

`lastSeen` ist Unix-Zeit in Millisekunden und muss bei jeder aktuellen Meldung
aktualisiert werden; `playtimeTicks` ist die gesamte Spielzeit in Minecraft-Ticks
(20 Ticks pro Sekunde). `primaryGroup` nur bei verfügbarem LuckPerms melden.
UUIDs sind Kleinbuchstaben im kanonischen Format. `gameMode` enthält nur
Buchstaben und `_`, Weltname nur `[A-Za-z0-9._-]`. Keine NaN- oder
Infinity-Koordinaten senden. Bis zu 10.000 Einträge und 8 MiB je Anfrage;
ungültige Einzel-Einträge werden auf dem Webserver übersprungen und geloggt.
Fehler nicht automatisch erneut senden. `GET /api/services/players/stats?uuid=...`
liefert die zuletzt global gespeicherte Statistik oder 404.

## Minecraft-Verifizierung: `/link`

Ergänze einen **nur für Spieler** ausführbaren Befehl `/link <code>`. Der
Spieler erstellt den sechsstelligen, zehn Minuten gültigen Einmalcode zuerst
in seinen TattyHost-Minecraft-Einstellungen. Behandle den Code als String,
damit führende Nullen erhalten bleiben, und zeige oder logge ihn nicht an
andere Spieler.

Bei `/link 001234` sendet das Plugin asynchron:

```http
PUT /api/services/players/link
Authorization: Bearer <service-key>
Content-Type: application/json

{"uuid":"01234567-89ab-cdef-0123-456789abcdef","code":"001234"}
```

Die UUID muss **immer vom tatsächlich ausführenden Online-Spieler** aus der
Server-API stammen, nie aus einem Befehlargument. `204` bedeutet erfolgreich
verifiziert, `400` ungültiger/abgelaufener Code, `409` bereits anderweitig
verifiziert, `429` zu viele Versuche, `401` fehlerhafter Service-Schlüssel.
Zeige dem Spieler eine passende Meldung. Keine Codes oder Schlüssel loggen;
keine automatischen Wiederholungen. Bestehende unbestätigte Web-Verknüpfungen
gelten nicht als Eigentumsnachweis.

## Lokale HTTP-API

Alle Antworten sind JSON außer den gestreamten Downloads; Fehler als
`{"error":"..."}`. POST muss `Content-Type: application/json` akzeptieren,
auch bei `{}`. Nur die folgenden Endpunkte bereitstellen:

- `GET /v1/status` → `{version,minecraftVersion,online,max,luckPerms}`.
- `GET /v1/players` → `{"players":[{"uuid":"...","name":"..."}]}`.
- `GET /v1/players/{uuid}/stats` → Live-Statistiken; offline: 404.
- `GET /v1/players/{uuid}/backups` → `{"backups":[{"id":"...","createdAt":1764076800000,"reason":"quit|manual|web","sizeBytes":123}]}`, neueste zuerst.
- `POST /v1/players/{uuid}/backups` → 201 `{"id":"..."}`; nur online, sonst 404.
- `GET /v1/players/{uuid}/backups/{id}` → vollständiges Backup-JSON streamen.
- `POST /v1/players/{uuid}/backups/{id}/restore` → `{"message":"..."}`; `id=latest` unterstützen. Online Inventar, Ender-Chest, XP, Leben, Hunger, Spielmodus und Position live überschreiben; offline Spielerdateien für den nächsten Login schreiben.
- `GET /v1/worlds/backups` → `{"worlds":[{"world":"world","backups":[{"id":"1764076800000","createdAt":1764076800000,"sizeBytes":123}]}]}`.
- `GET /v1/worlds/{world}/backups/{id}` → ZIP ohne Größenlimit streamen, `Content-Disposition` und `Content-Length` setzen.
- `POST /v1/worlds/{name|all}/backups` → 202 `{"started":["world"]}`, asynchron; 404 bei unbekannter Welt, 409 während eines laufenden Welt-Backups.

Spieler-Backup-IDs erfüllen `^[0-9]{1,18}_[a-z]{1,16}$`, Welt-Backup-IDs
`^[0-9]{1,18}$`; Weltname `[A-Za-z0-9._-]{1,128}`, aber nicht `.` oder `..`.
UUIDs strikt kanonisch validieren und Pfade gegen Traversal und Symlinks
absichern. Backups ausschließlich unter `plugins/THNLink/backups/players/<uuid>/`
und `plugins/THNLink/backups/worlds/<world>/` speichern. Kein Welt-Restore-API
anbieten; Welt-Backups automatisch alle sechs Stunden erstellen und fünf pro
Welt behalten. Statuscodes 400/404/409/413/415/500 korrekt zurückgeben.

Ergänze Tests für `/link` einschließlich führender Nullen und Herkunft der
UUID, Authentifizierung/Fehler, Heartbeat-Portwechsel, ETag/304/leere
Whitelist, Stats-Batch und Quit-Meldung, lokale Bindung, Pfadvalidierung,
Backup/Restore, Streaming und Konflikte. Dokumentiere Konfiguration, sichere
Inbetriebnahme und die Kompatibilität zum Webvertrag.
