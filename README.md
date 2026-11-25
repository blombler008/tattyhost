# React + TypeScript + Vite

## UI controls

Use the shared `Button` component for actions and `ButtonLink` for links styled
as actions. Variants are `primary`, `normal`, `danger`, `ghost`, `icon`, and
`tab`; use `danger` for destructive actions and preserve native button types
for form submissions. Run `npm run test:ui` for the shared control tests.

## Minecraft server icon

The site logo is available as a 64×64 PNG at
`https://tattyhost.com/server-icon.png`. This is a static, pre-sized image; it
does not resize other images or accept size parameters.

## Production startup

On the Linux server, install dependencies (including development dependencies,
which provide the build tools), configure the required environment variables
in `.env`, then run:

```bash
npm ci --include=dev
chmod +x start.sh
./start.sh
```

`start.sh` sets `NODE_ENV=production`, builds the client, libraries, and server,
then launches the server in a detached GNU Screen session named `tattyhost`. It
resolves the project directory from its own location and loads runtime settings
from `.env` through the app's dotenv setup. Attach with `screen -r tattyhost`;
detach with Ctrl+A, then D. The script refuses to create a duplicate session.
Do not run `npm ci --omit=dev`, since the production build and TypeScript server
runner are development dependencies.

## Production update

Run this on the Linux server from the project checkout:

```bash
chmod +x update.sh
./update.sh
```

`update.sh` fetches and fast-forwards the current branch's configured upstream,
installs dependencies, builds the project, and restarts the `tattyhost` Screen
session. It refuses to run with tracked local changes, a tracked `.env`, or an
upstream that contains `.env`. The local ignored `.env` is left untouched.
If the fetch, dependency installation, or build fails, the running Screen
session is not stopped.

## Application logging

The server writes colored, human-readable messages to the console and structured
JSON lines to daily files named `logs/tattyhost-YYYY-MM-DD.log`. Set `LOG_DIR`
to use another local directory. The `logs` folder is ignored by Git.

HTTP request completion, server lifecycle, and a database-pool snapshot are
logged to `application_logs`. Individual pool connection events and database
query/transaction outcomes are visible in the console and daily log files.
Account and administrative changes are recorded in `audit_logs` in the same
transaction as the change. Operational rows and log files are pruned after 90
days by default; set
`LOG_RETENTION_DAYS` to change this. Audit rows are retained.

Logs intentionally exclude request bodies, passwords, cookies, tokens, query
strings, and user-agent values. Existing login-attempt records continue to
include IP addresses. When using the local Nginx reverse proxy, Express trusts
loopback proxies to resolve the client IP. IP addresses are recorded for
diagnostics but no longer bind a login session, so a mobile network change does
not invalidate it.

For login troubleshooting, `auth.login.cookie_issued` records that the server
reached the cookie-setting step. On a homepage request,
`auth.session.home_diagnostic` records whether a session cookie was sent,
whether the session was accepted, and a non-sensitive rejection reason. Compare
their `requestId` values with the corresponding HTTP log entries. These events
do not record cookie contents, IP addresses, or user agents.

Available settings:

- `APP_LOG_LEVEL`: `debug`, `info` (default), `warn`, or `error`
- `LOG_DIR`: local log directory (default: `logs`)
- `LOG_RETENTION_DAYS`: retention for operational logs and files (default: `90`)

To inspect recent database logs:

```sql
SELECT created_at, log_level, event_name, method, route, status_code, duration_ms, request_id
FROM application_logs
ORDER BY id DESC
LIMIT 50;

SELECT logged_at, user_uuid, action, target_type, target_id, request_id, details
FROM audit_logs
ORDER BY id DESC
LIMIT 50;
```

## Server status API

Create each service in **Admin → Services**. Its 64-character Base64 key is
displayed once in the admin area when the service is created or its key is
rotated. Transfer it securely to the plugin's configuration. Tattyhost stores
only the SHA-256 hash. Rotating a key immediately invalidates the previous
one; deleting a service also deletes its key. Existing
global server-status keys are not accepted by this service-specific API.
Authenticated service requests are limited to 120 per minute per service
within each web-server process; excess requests receive `429`.

Choose **General service** or **Game – Minecraft** in the service settings.
Minecraft services have a Minecraft UUID/name whitelist option and a separate
THNLink switch. Enable THNLink for plugin player statistics, linking and local
backup management; the THNLink tab selects the first enabled server
automatically. General services still support status heartbeats, but not the
Minecraft whitelist or THNLink endpoints. Changing a type does not delete
existing whitelist entries. Save the settings before switching tabs.

On the first startup after this update, services with existing service keys
are migrated to Minecraft with THNLink enabled to preserve integrations;
services with a whitelist but no key are migrated to Minecraft without
THNLink, and other services become general services. Review the types in the
admin area after upgrading. This migration runs as part of normal schema setup.

Send a `PUT` request to `/api/services/status` over HTTPS with the key in the
`Authorization` header. The key identifies the service, so the body does not
include a `name`. `status` must be `online`, `offline`, or `maintenance`;
`details` is optional and limited to 255 characters. Optional `players` contains
nonnegative integer `online` and `max` counts (each up to 4,294,967,295), and
`minecraftVersion` is limited to 32 characters. Optional `api.port` is the
plugin API port (1–65535); `api.host` is accepted but not used as a connection
target. Older heartbeats may omit these fields; omitting `api` clears the
stored port so a stale endpoint cannot be used. A successful heartbeat returns
`204 No Content`. Counts and version are cleared on offline/maintenance reports and
heartbeat timeouts, so the public server cards only show them while the service
is online.

Send a heartbeat about every 30 seconds. After 90 seconds without a report, a
service without a manual override is persisted as offline once, with the
details `Keine Statusmeldung seit über 90 Sekunden`. The next heartbeat clears
that timeout detail if it omits `details`. A manual override makes the
administrator's status and details authoritative: heartbeats and automatic
timeouts do not change them until the override is disabled. Connected pages
receive status changes through a server-sent events stream. Each heartbeat is
recorded as an operational log; audit logs are written when the reported
status or details change.

PowerShell loop example (replace the status value with the result of your
server's own health check):

```powershell
$headers = @{ Authorization = "Bearer $env:TATTYHOST_STATUS_API_KEY" }
while ($true) {
    $body = @{
        status = "online"
        details = "Server läuft"
        players = @{ online = 3; max = 20 }
        minecraftVersion = "26.1"
        api = @{ port = 43127 }
    } | ConvertTo-Json

    Invoke-RestMethod `
        -Method Put `
        -Uri "https://tattyhost.com/api/services/status" `
        -Headers $headers `
        -ContentType "application/json" `
        -Body $body

    Start-Sleep -Seconds 30
}
```

Keep each service key in a server-side secret store or environment variable.
Do not put it in source control, browser code, command history, or logs.
Successful requests are recorded in `application_logs`; audit entries are
written when the reported status or details change.

## Minecraft whitelist API

The website's whitelist API stores approved players by canonical Minecraft
UUID. A signed-in user submits a Minecraft name and service ID; the server
resolves the name through Mojang's official profile API. Administrators review
the request before the UUID is added. Approval is a manual moderation step and
does not itself prove that the applicant owns the Minecraft account. The
stored UUID is resolved again during approval, so changing a Minecraft name
does not change the identity being reviewed.

The Paper server reads its own approved list using the existing per-service
Bearer key. Each service has a monotonically increasing whitelist revision.
The revision changes when a UUID is added or removed or its name changes; the ETag is scoped
to the service and revision so an unchanged list can be fetched with
`If-None-Match` and returns `304` with no body. A snapshot is limited to 10,000
players and 1 MiB; approvals are rejected when the player limit is reached.
The website remains the source
of truth while the Minecraft server is offline.

## THNLink integration

Set `IP_LOOKUP_HMAC_SECRET` in the server environment to a persistent,
independently generated 32-byte random secret encoded as 64 hexadecimal
characters, for example generated with `openssl rand -hex 32`. Startup fails
without it. Never commit or share the secret; changing it makes existing IP
records unmatchable until users visit again. All web instances sharing the
database must use the same secret.

The personal server-list lookup keeps only HMAC-SHA256 IP hashes, matches
activity from the last 24 hours, and periodically deletes records before they
reach 48 hours (also on startup). Users can opt in in account settings; the
feature is disabled by default. A
shared IP, multiple verified accounts, or missing player stats returns 404.
Existing session and login-attempt records continue to store IP addresses.

Express trusts forwarding headers only from loopback proxies. Deploy the reverse
proxy on loopback, and configure it to replace or safely append the client
address in `X-Forwarded-For`; do not expose another untrusted loopback proxy
to clients. If the proxy is not on loopback, client IPs will not be forwarded.
Run `npm run test:services` and `npm run test:settings` for the lookup and
setting tests. To include the lookup SQL integration test, set
`IP_LOOKUP_TEST_DATABASE=1` and configure the database connection; the test uses
connection-local temporary tables and does not change persistent tables.

The public and admin HTTP contracts are documented in
[openapi-thn.yaml](./openapi-thn.yaml). The implementation prompt for the
Minecraft plugin is in [thnlink-plugin-prompt.md](./docs/thnlink-plugin-prompt.md).
The local API is accessed only from the web server, using the port in the
latest heartbeat and `127.0.0.1`. An administrator may set a write-only
per-service loopback IP override with `PUT /api/admin/thn/:id/host-override`,
body `{"host":"::1"}`; use `{"host":null}` to reset it. Non-loopback hosts
are rejected, and neither host nor port is returned to the browser.

Linked-account cards display verification, online status and playtime
separately. While the player is online, the displayed server is the service
that sent the latest player report. The server fetches player skin textures from Mojang's official
profile and texture hosts to render the head; no third-party avatar service
receives the player's UUID. If the skin is unavailable, the card shows a
generic icon. The skin route checks account ownership or administrator access.

Plugin requests require the service key. For example, with the key supplied by
the process environment:

```sh
curl -X PUT 'https://tattyhost.com/api/services/status' \
  -H "Authorization: Bearer $TATTYHOST_STATUS_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"status":"online","details":"Ready","players":{"online":3,"max":20},"minecraftVersion":"26.1","api":{"port":43127}}'

curl -i 'https://tattyhost.com/api/services/whitelist' \
  -H "Authorization: Bearer $TATTYHOST_STATUS_API_KEY"

curl -X PUT 'https://tattyhost.com/api/services/players/stats' \
  -H "Authorization: Bearer $TATTYHOST_STATUS_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"players":[{"uuid":"01234567-89ab-cdef-0123-456789abcdef","name":"Player","lastSeen":1764076800000,"online":true,"playtimeTicks":123456,"deaths":4,"mobKills":8,"playerKills":1,"level":10,"health":20,"foodLevel":20,"gameMode":"SURVIVAL","world":"world","x":1,"y":64,"z":2}]}'

curl -i -X PUT 'https://tattyhost.com/api/services/players/lookup' \
  -H "Authorization: Bearer $TATTYHOST_STATUS_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"ip":"203.0.113.7"}'
```

Users first add a Minecraft name in their account settings. To verify ownership,
they generate a six-digit code there and enter `/link <code>` in-game within
ten minutes. The plugin sends the actual player's UUID and the code to
`PUT /api/services/players/link`; codes are single-use, have a five-attempt
limit per UUID per ten minutes, and are not logged. Existing name-only
associations are not verified. Only verified owners can access their stored
stats, and coordinates are excluded from their response. Stats are stored
globally by UUID: the latest timestamp from any server wins, so playtime is
not summed across servers. An online report older than 90 seconds is displayed
as offline.

Administrators can use **THNLink** in the admin area to inspect players, list,
create, download and restore player backups, and create or download world
backups. Backup content is streamed directly from the game server, not stored
in the web database. These operations are restricted server-side and audited.
The THNLink admin tab shows the latest 100 backup and whitelist audit entries
for the selected service, including the actor and target.
World restore is manual; no world-restore endpoint is provided. Local plugin
requests use a 20-second timeout, 90 seconds for backup creation, and no total
timeout after a download starts. The plugin must bind its unauthenticated API
to loopback only; do not rely on the firewall to protect an externally bound
API.

## Protected file browser

Members with the per-user **Dateizugriff** permission can browse and download
files at `/files`. Administrators grant or revoke this permission individually
in the user list. New and existing users have no file access until it is
granted. The server reads only from `FILES_ROOT`; set it to the existing
downloads directory in `.env`.
If omitted, Linux defaults to the legacy `/home/lucie/privdata/webfiles`
directory, while Windows defaults to a `webfiles` folder in the project root.
The directory must exist and be readable by the server process.

```env
FILES_ROOT=/home/lucie/privdata/webfiles
```

Administrators can edit the **filter** and **star** regular expressions in
**Admin Services → Dateien**. Manage URL-based download entries separately
under **Admin Services → Downloads**. Enter one expression per line. Filters hide
matching file and folder names; star rules mark matches as favorites. The
provided legacy `filter.json` expressions are installed as the initial
database settings. Settings changes are audited in `audit_logs`.

The files browser and file-download endpoints require both a session and the
user's file-access permission. The `/downloads` website page still requires a
login, but its active download list API and active download URLs are available
without authentication. Administrators can add external HTTP(S) links or upload
files in **Admin Services → Downloads**. Uploaded files are served as attachments
from a separate `DOWNLOADS_ROOT`, so they do not inherit the protected file
browser's permission rules. Uploaded files are available only while their
download entry is active. The upload limit defaults to 16 MB and can be changed
by an administrator from 1 to 512 MB; configure any reverse proxy to accept at
least the same request size. Paths in the protected file browser are constrained
to `FILES_ROOT`; symbolic links that resolve outside it are rejected.

```env
DOWNLOADS_ROOT=uploads/downloads
```

The default download storage path is `uploads/downloads` relative to the
application working directory.

## API reference

All routes below are prefixed with `/api`. JSON endpoints accept and return
`application/json`. Successful responses have the shape
`{ "success": true, ... }`; errors have the shape
`{ "success": false, "error": "..." }`.

Authentication types:

- **Public**: no login required.
- **Session**: requires the `HttpOnly` session cookie set by `POST /login`.
- **File permission**: requires a session and the per-user file-access permission.
- **Admin**: requires a logged-in administrator.
- **Server API key**: requires the status key in `Authorization: Bearer <key>`.

### Authentication and account

| Method and path | Auth | Purpose and request data |
| --- | --- | --- |
| `POST /login` | Public | Sign in with `{ "username": "name-or-email", "password": "..." }`. Sets the session cookie and returns the user's role. |
| `POST /register` | Public | Create an account with `{ "username": "...", "email": "...", "password": "..." }`. Registration does not automatically sign in. |
| `POST /logout` | Session | End the current session and clear its cookie. |
| `POST /password-reset` | Public | Complete a reset with `{ "token": "...", "newPassword": "..." }`. Reset tokens expire after one hour, are single-use, and revoke the user's sessions. |
| `GET /secure-data` | Session | Check the current session; returns the user's role. |
| `GET /account` | Session | Read the current account's username, email, Cloud access, and file access. |
| `PUT /account/email` | Session | Change email with `{ "currentPassword": "...", "email": "new@example.com" }`. |
| `PUT /account/password` | Session | Change password with `{ "currentPassword": "...", "newPassword": "..." }`. Other sessions and pending reset links are revoked. |
| `GET /settings` | Session | Read language, timezone, and dark-mode preference. |
| `PUT /settings` | Session | Save `{ "language": "en", "timezone": "UTC", "darkMode": true }`. |

### Services and downloads

| Method and path | Auth | Purpose and request data |
| --- | --- | --- |
| `GET /services` | Public | List services and their current status. A service with an expired heartbeat is returned as offline. |
| `GET /services/events` | Public | Open a server-sent events stream. Sends an initial service snapshot and pushes changed statuses; clients reconnect automatically. |
| `PUT /services/status` | Per-service API key | Report `{ "status": "online", "details": "...", "players": { "online": 3, "max": 20 }, "minecraftVersion": "26.1", "api": { "port": 43127 } }`. Counts, version and API are optional; statuses are `online`, `offline`, or `maintenance`. Returns 204. |
| `GET /services/whitelist` | Per-service API key | Return the full list `{ "revision": 42, "players": [{ "uuid": "01234567-89ab-cdef-0123-456789abcdef", "name": "Playername" }] }` (canonical unique UUIDs, Mojang-resolved Java names; an empty list is valid). The revision and ETag also change when only a name changes. Supports `If-None-Match`; returns an empty-body `304` when unchanged. |
| `POST /services/whitelist/requests` | Session | Submit `{ "serviceId": 1, "playerName": "Notch", "reason": "..." }` (reason required, max. 500 characters). Only allowed for services with `whitelistRequired` enabled in the admin panel. The server resolves and stores the official profile UUID; duplicate profiles are rejected. The profile is also linked to the user's Minecraft accounts. |
| `GET /account/whitelist` | Session | Own whitelist requests across all servers with status. |
| `DELETE /account/whitelist/:id` | Session | Remove an own whitelist entry. An approved entry is removed from the server whitelist (revision incremented); the request is deleted and an audit note `whitelist.self_removed` is written. |
| `GET /account/minecraft`, `POST /account/minecraft`, `DELETE /account/minecraft/:uuid` | Session | List, add (`{ "playerName": "Notch" }`, resolved via Mojang, max. 10) and unlink own Minecraft accounts. |
| `DELETE /account` | Session | Delete own account with `{ "password": "..." }`. Admin accounts are refused. |
| `GET /downloads` | Public | List active download links. The `/downloads` website page itself still requires sign-in. |
| `GET /downloads/file/:storageKey` | Public | Download an active uploaded file as an attachment. The storage key is a UUID. |
| `GET /files?path=...` | File permission | List files and folders inside the configured downloads directory. `path` is an optional relative folder path. |
| `GET /files/download?path=...` | File permission | Download a visible file using its relative path. |

### Administrator

All routes in this section require an authenticated administrator session.

| Method and path | Purpose and request data |
| --- | --- |
| `GET /admin/overview` | Read dashboard counts for users, sessions, failed logins, and downloads. |
| `GET /admin/users?search=...` | Search users by username or email; `search` is optional. |
| `PUT /admin/users/:uuid/role` | Set a user's role with `{ "role": "user" }` or `{ "role": "admin" }`. |
| `PATCH /admin/users/:uuid/status` | Activate or deactivate a user with `{ "isActive": true }`. Deactivation also revokes their sessions. |
| `PATCH /admin/users/:uuid/cloud-access` | Grant or revoke Cloud access with `{ "enabled": true }`. The Cloud navigation link is shown only when this flag is enabled. |
| `PATCH /admin/users/:uuid/file-access` | Grant or revoke this user's protected file browser permission with `{ "enabled": true }`. Access is denied by default. |
| `DELETE /admin/users/:uuid` | Delete a user account. An administrator cannot delete or demote their own account. |
| `POST /admin/users/:uuid/password-reset` | Send a one-time password-reset link to the user's account email. An optional `{ "recipientEmail": "other@example.com" }` sends it to a custom address without changing the account email. |
| `GET /admin/services` | List services and per-service API-key configuration; never returns key material. |
| `POST /admin/services` | Create `{ "name": "...", "address": "...", "status": "maintenance", "details": "" }` and return its API key once. |
| `POST /admin/services/:id/api-key` | Create or rotate the service's key and return it once; immediately invalidates the previous key. |
| `PUT /admin/services/:id` | Update a service's `name`, `address`, `status`, `details`, and `manualOverride`. Setting `manualOverride` to `true` prevents heartbeats and timeouts from changing its status/details. |
| `DELETE /admin/services/:id` | Delete a service and its associated API key. |
| `GET /admin/whitelist/requests?serviceId=1&userId=<uuid>&status=pending` | List whitelist applications; `serviceId`, `userId` and `status` are optional filters. |
| `PATCH /admin/whitelist/requests/:id` | Approve or reject a request with `{ "status": "approved" }` or `{ "status": "rejected" }` (rejected/revoked requests can be approved later). Approval resolves the profile again and increments the service revision when adding a UUID or changing its name. |
| `GET /admin/whitelist/players?serviceId=1` | List approved players for a service. |
| `DELETE /admin/whitelist/players/:serviceId/:uuid` | Revoke an approved UUID and increment the service revision. |
| `POST /admin/whitelist/grant` | Admin edit: put a user on a service's whitelist directly with `{ "userId": "<uuid>", "serviceId": 1, "playerName": "Notch" }`. Creates an approved request with the reason `Admin edit: <admin name>`, saves the Minecraft account for the user and increments the revision when the snapshot changes. This does not verify ownership. Works regardless of `whitelistRequired`; `409` if the profile is approved or requested by another user. |
| `GET /admin/whitelist/history?userId=<uuid>` | Notes about users who removed themselves from a whitelist (latest 50, from the audit log). |
| `GET`/`POST /admin/users/:uuid/minecraft` | List or add (`{ "playerName": "Notch" }`) a user's Minecraft accounts. |
| `PUT /admin/users/:uuid/minecraft/:playerUuid` | Refresh the stored name from Mojang by UUID (also updates whitelist entries). |
| `DELETE /admin/users/:uuid/minecraft/:playerUuid` | Unlink a Minecraft account; existing whitelist entries stay. |
| `GET /admin/downloads` | List all downloads, including inactive entries, and return the configured `maxUploadMb` limit. |
| `PUT /admin/downloads/settings` | Set `{ "maxUploadMb": 16 }`; accepted values are integers from 1 through 512 MB. |
| `POST /admin/downloads` | Create `{ "title": "...", "description": "...", "url": "https://..." }`. |
| `POST /admin/downloads/upload` | Multipart form upload with `file` (required), and optional `title` and `description` fields. Accepts any file type; enforces the configured upload limit and creates a public download entry. |
| `PUT /admin/downloads/:id` | Update title, description, URL, and visibility with those fields plus `"isActive": true`. Uploaded entries retain their internal file URL. |
| `DELETE /admin/downloads/:id` | Delete a download and remove its uploaded file, if any. |
| `GET /admin/files/settings` | Read the file browser's filter and star regular expressions. |
| `PUT /admin/files/settings` | Save `{ "filter": ["regex"], "star": ["regex"] }`. Each array may contain up to 100 expressions of at most 128 characters. |

Replace `:uuid` and `:id` with the target user's UUID or resource ID. Do not
send session cookies or the status API key to untrusted clients.

### SMTP configuration for password-reset emails

Set these server-side environment variables; never commit SMTP credentials:

```env
APP_BASE_URL=https://tattyhost.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
MAIL_FROM="Tattyhost <no-reply@example.com>"
```

`SMTP_PORT` defaults to `587`. If `SMTP_SECURE` is omitted, port `465` uses
implicit TLS and other ports require STARTTLS. `SMTP_USER` and `SMTP_PASSWORD`
must either both be set or both be omitted for a trusted relay. Production reset
links require an HTTPS `APP_BASE_URL`. Reset tokens are stored only as SHA-256
hashes; the raw token is placed in the link fragment so it is not sent in HTTP
requests or application logs. An SMTP delivery failure is reported in the admin
page and the newly created token is revoked.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Languages and appearance

The editable interface dictionaries are in [`languages/de.json`](./languages/de.json)
and [`languages/en.json`](./languages/en.json). Each key is the German source
phrase used by the interface; set its value to the desired text in that
language. Keep the same keys in both files, including placeholders such as
`{username}` or `{error}`. If a translation is missing, the interface falls
back to the source phrase.

The language selector and dark/light theme button are available in the global
header. Signed-in users' preferences are saved with their account; visitors'
preferences are stored in their browser. The profile settings page also lets
signed-in users change language and theme.

Server names/details and download titles/descriptions are admin-managed text.
To localize one of these values, add the exact text as a key in both locale
files and provide its German or English value.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default tseslint.config({
  extends: [
    // Remove ...tseslint.configs.recommended and replace with this
    ...tseslint.configs.recommendedTypeChecked,
    // Alternatively, use this for stricter rules
    ...tseslint.configs.strictTypeChecked,
    // Optionally, add this for stylistic rules
    ...tseslint.configs.stylisticTypeChecked,
  ],
  languageOptions: {
    // other options...
    parserOptions: {
      project: ['./tsconfig.node.json', './tsconfig.app.json'],
      tsconfigRootDir: import.meta.dirname,
    },
  },
})
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default tseslint.config({
  plugins: {
    // Add the react-x and react-dom plugins
    'react-x': reactX,
    'react-dom': reactDom,
  },
  rules: {
    // other rules...
    // Enable its recommended typescript rules
    ...reactX.configs['recommended-typescript'].rules,
    ...reactDom.configs.recommended.rules,
  },
})
```
