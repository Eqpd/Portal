const { contextBridge, ipcRenderer } = require('electron');

// Suppress right-click context menu in the renderer
window.addEventListener('contextmenu', (e) => e.preventDefault(), true);

// Prevent accidental page unloads in production kiosk mode.
// Electron fires webContents 'will-prevent-unload' when this handler returns
// a non-empty value, giving main.js the opportunity to route the close attempt
// through the supervisor PIN dialog instead of showing the native browser dialog.
window.addEventListener('beforeunload', (e) => {
  e.returnValue = '';
});

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  onRfidTag: (cb) => {
    ipcRenderer.on('rfid-tag', (_, data) => cb(data));
  },

  onSyncStatus: (cb) => {
    ipcRenderer.on('sync-status', (_, data) => cb(data));
  },

  onUpdateStatus: (cb) => {
    ipcRenderer.on('update-status', (_, data) => cb(data));
  },

  installUpdate: () => ipcRenderer.invoke('install-update'),

  simulateRfidTag: (tag) => ipcRenderer.invoke('rfid-simulate-tag', tag),

  removeListener: (channel) => ipcRenderer.removeAllListeners(channel),

  // Kiosk exit flow — renderer receives this when user tries to close the window
  onExitRequested: (cb) => {
    ipcRenderer.on('request-exit', (_, data) => cb(data));
  },

  // Renderer calls this with the supervisor PIN; main process verifies and exits if correct
  confirmExit: (pin) => ipcRenderer.invoke('confirm-exit', pin),

  // Fired when the local server has downloaded a new UI version from Replit.
  // The renderer should reload at the next safe opportunity (e.g. when idle).
  onUiUpdate: (cb) => {
    ipcRenderer.on('ui-updated', (_, data) => cb(data));
  },

  // After pairing, the renderer passes the server-managed supervisor PIN to
  // the main process so it can be used for kiosk exit without needing config.json.
  setSupervisorPin: (pin) => ipcRenderer.send('set-supervisor-pin', pin),
});
