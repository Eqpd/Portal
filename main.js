const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const net = require('net');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// ── Config (userData path — writable in packaged builds) ─────────────────────
// app.asar is read-only; all writes go to app.getPath('userData') instead.
const BUNDLED_CONFIG_PATH = path.join(__dirname, 'config.json');

function getUserDataConfigPath() {
  return path.join(app.getPath('userData'), 'equip-portal-config.json');
}

function loadConfig() {
  const userDataPath = getUserDataConfigPath();
  // On first launch copy bundled defaults to writable userData location
  if (!fs.existsSync(userDataPath)) {
    try {
      const defaults = fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8');
      fs.mkdirSync(path.dirname(userDataPath), { recursive: true });
      fs.writeFileSync(userDataPath, defaults);
    } catch (e) {
      console.warn('[config] Could not write defaults to userData:', e.message);
    }
  }
  // Read from userData; fall back to bundled readonly defaults
  try {
    return JSON.parse(fs.readFileSync(userDataPath, 'utf8'));
  } catch {
    return JSON.parse(fs.readFileSync(BUNDLED_CONFIG_PATH, 'utf8'));
  }
}

function saveConfigToDisk(newConfig) {
  const userDataPath = getUserDataConfigPath();
  fs.mkdirSync(path.dirname(userDataPath), { recursive: true });
  fs.writeFileSync(userDataPath, JSON.stringify(newConfig, null, 2));
}

const isDev = process.argv.includes('--dev');

let config = null; // loaded inside whenReady (app.getPath requires app ready)

// Set to true once the supervisor PIN has been verified — allows the close guard
// and before-quit guard to pass through so app.quit() lifecycle runs normally.
let supervisorExitAllowed = false;

// Module-level flag — set in createWindow() so registerKioskShortcuts() and
// the confirm-exit handler can see whether kiosk mode is actually active.
let kioskMode = false;

// ── Hardware state ────────────────────────────────────────────────────────────
let mainWindow = null;
let rfidSocket = null;
let rfidReconnectTimer = null;
let serialPort = null;
let localServer = null;
let sync = null;
let serverPort = null;

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (isDev) {
    console.log('[updater] Skipping auto-update in dev mode.');
    return;
  }

  // Private GitHub repo — authenticate so the updater can download release assets
  const ghToken = config?.githubToken;
  if (ghToken) {
    autoUpdater.requestHeaders = { Authorization: `token ${ghToken}` };
  } else {
    console.warn('[updater] githubToken not set in config — auto-update from private repo will fail. ' +
      'Set githubToken in equip-portal-config.json in the app userData folder.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('update-status', { state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] Update available: v${info.version}`);
    sendToRenderer('update-status', { state: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    sendToRenderer('update-status', { state: 'current' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update-status', {
      state: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] Update downloaded: v${info.version} — will install on quit.`);
    sendToRenderer('update-status', { state: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
    sendToRenderer('update-status', { state: 'error', message: err.message });
  });

  // Check on launch, then every 4 hours
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Load config now that app is ready and getPath('userData') is available
  config = loadConfig();

  // Start local server — pass userData cache dir so it can fetch/cache the
  // latest UI from the deployed Replit server and serve it offline.
  const uiCacheDir = path.join(app.getPath('userData'), 'ui-cache');
  localServer = require('./local-server/server');
  serverPort = await localServer.start({ ...config, uiCacheDir }, () => {
    // A new UI version was downloaded — notify the renderer so it can reload
    // when the portal is next idle (handled in Portal.tsx).
    sendToRenderer('ui-updated', {});
  });

  // Init sync engine
  sync = require('./sync/sync');
  sync.init(config, (status) => {
    sendToRenderer('sync-status', status);
  });

  // Warn operators if no supervisor PIN is set — exit will be blocked in kiosk mode
  if (!isDev && !config.supervisorPin) {
    console.warn('[kiosk] WARNING: supervisorPin is not set in config.json. ' +
      'The portal cannot be exited via the UI until a PIN is configured. ' +
      'Set supervisorPin in your userData config (equip-portal-config.json) before deploying.');
  }

  createWindow();

  setupAutoUpdater();

  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  rfidSocket?.destroy();
  serialPort?.close?.();
  if (localServer) localServer.stop();
  if (sync) sync.stop();
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  // Kiosk mode requires a supervisorPin — without one the operator has no way
  // to exit the portal, which would leave the machine permanently locked.
  kioskMode = !isDev && !!config.supervisorPin;

  mainWindow = new BrowserWindow({
    width,
    height,
    fullscreen: kioskMode,
    frame: isDev,
    kiosk: kioskMode,
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Belt-and-suspenders: maximise z-order so other windows cannot overlay the portal
  if (kioskMode) mainWindow.setAlwaysOnTop(true, 'screen-saver');

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);

  // Recovery: if the page fails to load (e.g. local server not ready yet),
  // retry after a short delay rather than staying on a white screen.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED — intentional navigation, ignore
    console.warn(`[window] Page load failed (${code} ${desc}) — retrying in 2s`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
      }
    }, 2000);
  });

  // Recovery: renderer crash → reload
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.warn('[window] Renderer crashed:', details.reason, '— reloading');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
      }
    }, 1000);
  });

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Suppress native context menu in production
  mainWindow.webContents.on('context-menu', (e) => e.preventDefault());

  if (kioskMode) {
    // ── Close / quit interception ──────────────────────────────────────────────
    // Catches: window X button, OS close signal, Alt+F4 (Windows), Cmd+Q (macOS).
    // supervisorExitAllowed is set by confirm-exit IPC before app.quit() is called
    // so the normal Electron quit lifecycle (before-quit → cleanup → closed) runs.
    mainWindow.on('close', (e) => {
      if (supervisorExitAllowed) return; // supervisor has authenticated — let through
      e.preventDefault();
      sendToRenderer('request-exit', {});
    });

    // ── beforeunload interception ─────────────────────────────────────────────
    // preload.js registers window.beforeunload which causes Electron to fire
    // will-prevent-unload. We suppress the native "Leave page?" dialog and
    // route the event through the supervisor PIN flow instead.
    mainWindow.webContents.on('will-prevent-unload', (e) => {
      e.preventDefault();
      sendToRenderer('request-exit', {});
    });

    // ── Task-switch mitigation ─────────────────────────────────────────────────
    // When the kiosk window loses focus (via Alt+Tab or OS task-switch shortcuts
    // that globalShortcut cannot intercept), immediately reclaim focus.
    // This is the strongest in-process defence Electron provides without a native
    // low-level keyboard hook (e.g. SetWindowsHookEx / RegisterHotKey via a
    // native addon). Combined with setKiosk(true) + setAlwaysOnTop it effectively
    // prevents casual desktop access.
    // Note: for full suppression of OS-reserved combos (Win+L, Ctrl+Alt+Delete)
    // configure Windows Keyboard Filter via Group Policy or Intune.
    mainWindow.on('blur', () => {
      if (supervisorExitAllowed) return; // don't re-focus during graceful exit
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.focus();
      }
    });
  }

  mainWindow.on('closed', () => {
    globalShortcut.unregisterAll();
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    registerKioskShortcuts();
    wireHardware();
    if (sync) sendToRenderer('sync-status', sync.getStatus());
  });
}

// ── Kiosk shortcut suppression ─────────────────────────────────────────────
function registerKioskShortcuts() {
  if (isDev || !kioskMode) return;

  // ── DevTools shortcuts — silently blocked ──────────────────────────────────
  const devToolsShortcuts = [
    'F12',
    'Control+Shift+I',
    'Control+Shift+J',
    'Control+Shift+C',
    'Control+U',
    'Control+Shift+R',
    'F5',
  ];
  for (const sc of devToolsShortcuts) {
    try {
      globalShortcut.register(sc, () => {});
    } catch (e) {
      console.warn(`[kiosk] Could not register DevTools block for ${sc}:`, e.message);
    }
  }

  // ── Quit shortcuts — routed to supervisor PIN dialog ────────────────────────
  // Alt+F4 (Windows) and Cmd+Q (macOS) are also caught by the BrowserWindow
  // 'close' event, but intercepting them here ensures the dialog fires even
  // before the OS delivers the close signal.
  const quitShortcuts =
    process.platform === 'darwin'
      ? ['Command+Q', 'Command+W', 'Command+H', 'Command+M']
      : ['Alt+F4'];

  for (const sc of quitShortcuts) {
    try {
      globalShortcut.register(sc, () => sendToRenderer('request-exit', {}));
    } catch (e) {
      console.warn(`[kiosk] Could not intercept quit shortcut ${sc}:`, e.message);
    }
  }

  // ── Windows task-switch suppression ────────────────────────────────────────
  // Electron's globalShortcut API cannot intercept OS-reserved hotkeys such as
  // Alt+Tab, Win+L, Ctrl+Alt+Delete, or Ctrl+Escape at the application level.
  // These require OS-level configuration for full suppression. Recommended
  // deployment hardening steps (applied outside this process):
  //   1. Enable Windows Keyboard Filter via MDM (e.g. Intune) or Group Policy
  //      to block task-switch keys globally.
  //   2. Use Windows Assigned Access (single-app kiosk mode) — Settings →
  //      Accounts → Family & other users → Set up a kiosk.
  //   3. On dedicated hardware: configure BIOS to disable hot-key shortcuts and
  //      auto-boot into the kiosk account.
  //
  // What this process does do at the application level:
  //   - setKiosk(true) removes the taskbar and puts the window in fullscreen
  //     exclusive mode — the primary OS-level defense available to Electron.
  //   - setAlwaysOnTop('screen-saver') maximises window z-order so ordinary
  //     application windows cannot overlay the portal.
  if (process.platform === 'win32' && !isDev) {
    console.log('[kiosk] Windows: setKiosk + setAlwaysOnTop active. For full ' +
      'task-switch suppression configure Windows Keyboard Filter or Assigned Access.');
  }
}

// ── Hardware wiring ───────────────────────────────────────────────────────────
function wireHardware() {
  const mode = config.rfidInputMode || 'keyboard';
  if (mode === 'tcp') startRfidTcp();
  else if (mode === 'serial') startRfidSerial();
}

function startRfidTcp() {
  clearTimeout(rfidReconnectTimer);
  if (rfidSocket) { rfidSocket.destroy(); rfidSocket = null; }

  rfidSocket = new net.Socket();
  let buffer = '';

  rfidSocket.connect(config.rfidReader.port, config.rfidReader.host, () => {
    console.log('[rfid] TCP connected');
  });

  rfidSocket.on('data', (data) => {
    buffer += data.toString('ascii');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const tag = parseTagLine(line.trim());
      if (tag) sendToRenderer('rfid-tag', { tag, time: Date.now() });
    }
  });

  rfidSocket.on('close', () => {
    rfidSocket = null;
    rfidReconnectTimer = setTimeout(startRfidTcp, config.rfidReader.reconnectIntervalMs ?? 5000);
  });

  rfidSocket.on('error', () => {
    rfidSocket?.destroy();
    rfidSocket = null;
    rfidReconnectTimer = setTimeout(startRfidTcp, config.rfidReader.reconnectIntervalMs ?? 5000);
  });
}

async function startRfidSerial() {
  try {
    const { SerialPort } = require('serialport');
    const { ReadlineParser } = require('@serialport/parser-readline');

    serialPort = new SerialPort({
      path: config.irSensor?.comPort || config.rfidReader?.comPort || 'COM3',
      baudRate: config.irSensor?.baudRate ?? 9600,
      autoOpen: false,
    });

    const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (line) => {
      const tag = line.trim();
      if (tag) sendToRenderer('rfid-tag', { tag, time: Date.now() });
    });

    await new Promise((resolve, reject) => {
      serialPort.open((err) => err ? reject(err) : resolve());
    });
    console.log('[rfid] Serial connected');
  } catch (e) {
    console.error('[rfid] Serial error:', e.message);
  }
}

function parseTagLine(line) {
  if (!line) return null;
  if (line.toUpperCase().startsWith('TAG,')) {
    const parts = line.split(',');
    return parts[1]?.trim() ?? null;
  }
  return line;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => {
  const cfg = config || {};
  return {
    inputMode: cfg.rfidInputMode || 'keyboard',
    rfidReader: cfg.rfidReader || {},
    irSensor: cfg.irSensor || {},
    apiBaseUrl: cfg.apiBaseUrl || '',
  };
});

ipcMain.handle('save-config', (_, newConfig) => {
  try {
    if (!config) return { success: false, error: 'Config not loaded yet' };
    if (newConfig.rfidInputMode) config.rfidInputMode = newConfig.rfidInputMode;
    if (newConfig.rfidReader) config.rfidReader = { ...config.rfidReader, ...newConfig.rfidReader };
    if (newConfig.irSensor) config.irSensor = { ...config.irSensor, ...newConfig.irSensor };
    if (newConfig.apiBaseUrl) config.apiBaseUrl = newConfig.apiBaseUrl;
    saveConfigToDisk(config);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('rfid-simulate-tag', (_, tag) => {
  sendToRenderer('rfid-tag', { tag, time: Date.now() });
  return true;
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

// Allow the renderer to push a server-managed PIN into the main process after
// successful pairing. This overrides any PIN set in the local config file, so
// operators can rotate the PIN from the back office without touching each machine.
ipcMain.on('set-supervisor-pin', (_, pin) => {
  if (config && pin) {
    config.supervisorPin = String(pin);
    console.log('[kiosk] Supervisor PIN updated from server settings');
  }
});

ipcMain.handle('confirm-exit', (_, pin) => {
  const supervisorPin = config?.supervisorPin;

  // No PIN configured → kiosk mode is off, allow exit without any PIN check.
  if (!supervisorPin) {
    supervisorExitAllowed = true;
    globalShortcut.unregisterAll();
    setImmediate(() => app.quit());
    return { success: true };
  }

  if (String(pin) === String(supervisorPin)) {
    // Set the flag so the 'close' and 'blur' guards let the quit through,
    // then call app.quit() which runs the full graceful shutdown lifecycle:
    // before-quit → hardware cleanup → window-all-closed → quit.
    supervisorExitAllowed = true;
    globalShortcut.unregisterAll();
    setImmediate(() => app.quit());
    return { success: true };
  }

  return { success: false, error: 'Incorrect PIN. Please try again.' };
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendToRenderer(channel, data) {
  if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}
