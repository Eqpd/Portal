const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('unpaired setup ignores a legacy PIN, exits, and paired exit still checks the PIN', async () => {
  const handles = new Map(), events = new Map();
  let ready, quitCount = 0, window, syncCalls = 0;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      window = this;
      this.webContents = { on() {}, once() {}, send() {} };
    }
    loadURL() {}
    setKiosk() {}
    setFullScreen(value) { this.fullscreen = value; }
    setAlwaysOnTop() {}
    setWindowButtonVisibility() {}
    isDestroyed() { return false; }
  }
  const updater = new EventEmitter();
  updater.checkForUpdatesAndNotify = async () => {};
  const app = {
    whenReady: () => ({ then: callback => { ready = callback; } }),
    on() {}, getPath: () => '/fixture', getVersion: () => '1.0.0',
    quit: () => { quitCount++; },
  };
  const electron = {
    app, BrowserWindow: Window,
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) },
    ipcMain: { handle: (name, fn) => handles.set(name, fn), on: (name, fn) => events.set(name, fn) },
    globalShortcut: { register() {}, unregisterAll() {} }, shell: {},
  };
  const sync = { init() {}, stop() {}, configureSession() {}, async syncNow() { syncCalls++; return { online: true, pendingCount: 0, lastSyncAt: 'fixture' }; } };
  const mocks = {
    electron, 'electron-updater': { autoUpdater: updater },
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ supervisorPin: 'legacy-pin' }), mkdirSync() {}, writeFileSync() {} },
    './local-server/server': { start: async () => 1234, stop() {} },
    './sync/sync': sync,
    './unsigned-mac-updater': { UnsignedMacUpdater: class extends EventEmitter {
      async checkForUpdatesAndNotify() {}
    } },
  };
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  vm.runInNewContext(source, {
    require: name => mocks[name] || require(name), __dirname: path.resolve(__dirname, '..'),
    process: { argv: [], platform: 'darwin' }, console: { log() {}, info() {}, warn() {}, error() {} },
    setInterval: () => 0, setTimeout: () => 0, setImmediate: fn => fn(),
  });
  await ready();
  assert.equal(window.options.fullscreen, true, 'launch fullscreen even without a supervisor PIN');
  events.get('set-supervisor-pin')(null, '');
  assert.equal(window.options.fullscreen, true);
  window.emit('leave-full-screen');
  assert.equal(window.fullscreen, true);
  assert.equal((await handles.get('sync-now')()).success, true);
  assert.equal(syncCalls, 1);
  const exit = handles.get('confirm-exit');
  assert.equal((await exit(null, '')).success, true);
  assert.equal(quitCount, 1);
  // Establish a paired PIN using the same IPC contract as the portal UI.
  events.get('set-supervisor-pin')(null, 'paired-pin');
  assert.equal((await exit(null, 'wrong')).success, false);
  assert.equal(quitCount, 1);
  assert.equal((await exit(null, 'paired-pin')).success, true);
  assert.equal(quitCount, 2);
});
