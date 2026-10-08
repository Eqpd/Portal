const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('an old reauthentication response cannot overwrite a newly paired organisation', async () => {
  const values = new Map(Object.entries({
    token: 'first-fixture', pairingCode: 'ABCD1234', armouryId: 'first',
    organizationDomain: 'first.example.org',
  }));
  const database = {
    getConfig: key => values.get(key) || '',
    setConfig: (key, value) => values.set(key, value),
    getPendingCount: () => 0,
  };
  let resolveOld;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../sync/sync.js'), 'utf8'), {
    module, require: name => name === '../local-server/db' ? database : { v4: () => 'fixture' },
    fetch: async url => url.endsWith('/health') ? { ok: true } : new Promise(resolve => { resolveOld = resolve; }),
    AbortSignal, setInterval: () => 0, clearInterval() {}, console,
  });
  const sync = module.exports;
  sync.init({ apiBaseUrl: 'https://first.example.org' }, () => {});
  const request = sync.doReauth();
  values.set('token', 'second-fixture');
  values.set('armouryId', 'second');
  values.set('organizationDomain', 'second.example.org');
  sync.configureSession('https://second.example.org');
  resolveOld({ ok: true, json: async () => ({ token: 'stale-first-fixture', armoury: { id: 'first' } }) });
  assert.equal(await request, false);
  assert.equal(values.get('token'), 'second-fixture');
  assert.equal(values.get('armouryId'), 'second');
  sync.stop();
});
