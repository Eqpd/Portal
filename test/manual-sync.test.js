const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ online = true, failData = false } = {}) {
  const values = new Map(Object.entries({ token: 'fixture-token', armouryId: 'fixture', lastSyncAt: 'old-sync' }));
  const module = { exports: {} };
  const db = {
    getConfig: key => values.get(key) || '',
    setConfig: (key, value) => values.set(key, value),
    getPendingCount: () => 0, getPendingQueue: () => [],
    upsertEquipment() {}, upsertUser() {}, upsertCategory() {}, upsertCachedMovement() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../sync/sync.js'), 'utf8'), {
    module, require: name => name === '../local-server/db' ? db : { v4: () => 'fixture' },
    fetch: async url => url.endsWith('/health')
      ? { ok: online, status: online ? 200 : 503 }
      : new Response(JSON.stringify([]), { status: failData ? 500 : 200 }),
    AbortSignal, setInterval: () => 0, clearInterval() {},
    console: { error() {} },
  });
  module.exports.init({ apiBaseUrl: 'https://fixture.example.org' }, () => {});
  return { sync: module.exports, values };
}

test('manual sync refreshes the data and last-synced status', async () => {
  const { sync, values } = fixture();
  const status = await sync.syncNow();
  assert.equal(status.online, true);
  assert.notEqual(values.get('lastSyncAt'), 'old-sync');
  sync.stop();
});

test('offline manual sync fails visibly without changing the last successful sync', async () => {
  const { sync, values } = fixture({ online: false });
  await assert.rejects(sync.syncNow(), /offline or unreachable/);
  assert.equal(values.get('lastSyncAt'), 'old-sync');
  sync.stop();
});

test('failed data pulls are not reported as a successful sync', async () => {
  const { sync, values } = fixture({ failData: true });
  await assert.rejects(sync.syncNow(), /Could not refresh portal data/);
  assert.equal(values.get('lastSyncAt'), 'old-sync');
  sync.stop();
});
