# Equip Portal 2.0 — Desktop App

A fully self-contained Electron desktop application that replicates Portal 2.0
with zero internet dependency. Transactions are committed locally to SQLite and
synced to the Replit back office when connectivity is restored.

---

## Setup

### 1. Configure the app

Edit `config.json` before building:

```json
{
  "apiBaseUrl": "https://your-equip-app.replit.app",
  "portalPairingCode": "PAPA2024",
  "rfidInputMode": "keyboard",
  "rfidReader": { "host": "192.168.1.100", "port": 6000 },
  "irSensor": { "comPort": "COM3", "baudRate": 9600 }
}
```

**`rfidInputMode`** — choose one:
- `"keyboard"` — HID wedge USB reader (default, works out of the box)
- `"tcp"` — networked UHF portal reader over TCP socket
- `"serial"` — RS-232 / USB serial reader

These settings can also be changed from the portal settings panel at runtime
(gear icon in the header) — a restart is required to apply them.

### 2. Install dependencies

```bash
npm install
```

`@electron/rebuild` runs automatically via `postinstall` to recompile native
modules (`better-sqlite3`, `serialport`) for Electron's Node runtime.

### 3. Run in development

```bash
npm run dev
```

This opens Electron in windowed mode with DevTools. The portal UI must be built
first (or built for you via `npm run build:ui`).

---

## Build installers

```bash
# Build UI and package for Windows (.exe NSIS installer)
npm run build:win

# Build UI and package for macOS (.dmg)
npm run build:mac

# Build UI and package for Linux (AppImage)
npm run build:linux

# Build only the portal React UI (into renderer/)
npm run build:ui
```

Installers are written to `dist/`. Build configuration lives in
`electron-builder.config.js`.

---

## Code signing

Unsigned builds are blocked by Windows SmartScreen and macOS Gatekeeper on
managed machines. Set the environment variables below before running a build.
No variables set → unsigned dev/test build. Variables set → signed release build.

### Windows — OV/EV certificate

| Variable | Description |
|---|---|
| `WIN_CSC_LINK` | Path or HTTPS URL to the `.pfx` certificate file |
| `WIN_CSC_KEY_PASSWORD` | Password for the `.pfx` file |

```bash
export WIN_CSC_LINK=/certs/equip-codesign.pfx
export WIN_CSC_KEY_PASSWORD=secret
npm run build:win
```

EV certificates (on a USB token) typically require the DigiCert or Sectigo
signing tool installed on the build machine. Set `WIN_CSC_LINK` to the `.pfx`
exported from the token, or follow your CA's Electron-specific guide.

Once signed, SmartScreen clears immediately for EV certs. OV certs accumulate
reputation over multiple installs.

### macOS — Apple Developer certificate + notarization

| Variable | Description |
|---|---|
| `CSC_NAME` | Exact cert name from Keychain, e.g. `Developer ID Application: Equip Systems Ltd (XXXXXXXXXX)` |
| `APPLE_ID` | Apple ID email for the Developer account |
| `APPLE_ID_PASSWORD` | App-specific password from appleid.apple.com (not your login password) |
| `APPLE_TEAM_ID` | 10-character team ID from developer.apple.com/account |

```bash
export CSC_NAME="Developer ID Application: Equip Systems Ltd (ABC1234567)"
export APPLE_ID=build@equip.nz
export APPLE_ID_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABC1234567
npm run build:mac
```

The `afterSign` hook (`build/notarize.js`) submits the `.app` bundle to
Apple's notary service and staples the ticket. The resulting `.dmg` passes
Gatekeeper on any Mac without additional configuration.

> **Note**: if `CSC_NAME` is set but the Apple notarization variables are
> missing, the build will **fail** — a signed-but-unnotarized app still
> triggers Gatekeeper. Remove `CSC_NAME` to do an unsigned dev build.

**Prerequisites**:
1. Enrol in the Apple Developer Program (developer.apple.com)
2. Create a *Developer ID Application* certificate via Xcode → Settings →
   Accounts → Manage Certificates, or the developer portal
3. Generate an app-specific password at appleid.apple.com → Sign-In and
   Security → App-Specific Passwords

---

## Auto-update

Installed portals check for updates on launch and every 4 hours. New versions
download silently in the background and install the next time the app quits.

### Release server — GitHub Releases (recommended)

Set three environment variables before building and publishing:

| Variable | Description |
|---|---|
| `GH_TOKEN` | GitHub personal access token with `repo` scope |
| `GH_OWNER` | GitHub org or user that owns the release repository |
| `GH_REPO` | Repository name for releases (can be a private repo) |

```bash
export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
export GH_OWNER=your-org
export GH_REPO=equip-portal-releases
npm run build:mac   # or build:win
npx electron-builder --publish always
```

`electron-builder` uploads the signed installer, `latest-mac.yml` /
`latest.yml`, and the blockmap file to the GitHub Release. Installed portals
query those YAML files to detect new versions and download updates
automatically.

> If `GH_OWNER` or `GH_REPO` are not set, `electron-builder.config.js` will
> warn during the build. The installer will still be produced but auto-update
> will not work in that build.

### Release server — S3 / private server

Change the `publish` block in `electron-builder.config.js` to use the `s3`
or `generic` provider. See https://www.electron.build/configuration/publish
for all options.

### Renderer integration

`main.js` broadcasts update state over the `update-status` IPC channel
exposed on `window.electronAPI`. Listen in the portal UI like this:

```js
window.electronAPI.onUpdateStatus((status) => {
  // status.state is one of: 'checking' | 'available' | 'downloading'
  //                          | 'ready' | 'current' | 'error'
  if (status.state === 'ready') {
    console.log(`Update v${status.version} is ready — will install on quit.`);
  }
  if (status.state === 'downloading') {
    console.log(`Downloading… ${status.percent}%`);
  }
});
```

To restart the app immediately and apply the update:

```js
window.electronAPI.installUpdate();
```

| `state` | Meaning |
|---|---|
| `checking` | Querying the release server |
| `available` | New version found; download starting |
| `downloading` | Download in progress (`percent`, `bytesPerSecond`) |
| `ready` | Downloaded and ready to install on next quit (`version`) |
| `current` | Already on the latest version |
| `error` | Update check or download failed (`message`) |

---

## How it works

### Local server
The app starts a local Express server on a random port at launch. The Electron
window loads `http://127.0.0.1:<port>/` — so all relative API calls from the
portal UI resolve against the local server, not the internet.

### Offline operation
All lookups (user RFID, equipment RFID, checked-out items) are served from a
local SQLite database. Transactions are written locally first and queued for
sync. The portal is fully operational with no network.

### Sync engine
- **Network check**: pings the remote every 10 seconds
- **Pull** (every 30s when online): downloads users and equipment for the armoury
- **Push** (every 30s when online + on reconnect): replays offline transaction
  queue to the remote in order
- **Auto-reauth**: if the session token has expired, the sync engine re-pairs
  automatically using the cached pairing code — no operator action required

### Transaction refresh
Two mechanisms keep the UI live:
1. **Instant** — after every checkout/checkin, the UI immediately fetches updated
   recent-movements and available-counts from the local API
2. **Background poll** — every 30 seconds as a fallback

---

## Data storage
The SQLite database is stored in the OS user-data directory:
- **Windows**: `%APPDATA%\Equip Portal\equip-portal.db`
- **macOS**: `~/Library/Application Support/Equip Portal/equip-portal.db`
- **Linux**: `~/.config/Equip Portal/equip-portal.db`
