const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseDomain, createOrganisationPairing } = require('../local-server/organisation-pairing');
function fixture(entries = {}, pending = 0, offline = false) {
  const values = new Map(Object.entries(entries));
  const calls = [];
  let cleared = false, paired;
  const sql = {
    transaction: fn => fn,
    exec: () => { cleared = true; values.clear(); },
  };
  const database = {
    getConfig: key => values.get(key) || '',
    setConfig: (key, value) => values.set(key, value),
    getPendingCount: () => pending, getDb: () => sql,
  };
  const handlers = createOrganisationPairing({
    database, getApiBaseUrl: () => 'https://platform.example.org',
    onPaired: (base, domain) => { paired = { base, domain }; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (offline) throw new TypeError('fetch failed');
      if (url.includes('/organisation')) return Response.json({ name: 'Fixture organisation', organizationDomain: JSON.parse(options.body).organizationDomain });
      return Response.json({ token: 'fixture-token', armoury: { id: 'fixture-armoury', name: 'Fixture' }, settings: {} });
    },
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.data = data; return this; } };
  return { handlers, res, calls, values, get cleared() { return cleared; }, get paired() { return paired; } };
}
test('normalises organisation URLs and rejects URL credentials/insecure protocols', () => {
  assert.equal(normaliseDomain('https://ORG.example.org/sign-in'), 'org.example.org');
  assert.equal(normaliseDomain('org.example.org'), 'org.example.org');
  assert.throws(() => normaliseDomain('http://org.example.org'));
  assert.throws(() => normaliseDomain('https://fixture@example.org'));
});
test('organisation lookup runs before the code is sent to the selected HTTPS site', async () => {
  const f = fixture();
  await f.handlers.pair({ body: { portalCode: 'ABCD1234', organizationDomain: 'org.example.org' } }, f.res);
  assert.equal(f.res.statusCode, 200);
  assert.match(f.calls[0].url, /platform\.example\.org\/api\/portal\/organisation/);
  assert.equal(f.calls[0].options.method, 'POST');
  assert.equal(JSON.parse(f.calls[0].options.body).organizationDomain, 'org.example.org');
  assert.equal(f.calls[1].url, 'https://org.example.org/api/portal/pair');
  assert.equal(JSON.parse(f.calls[1].options.body).organizationDomain, 'org.example.org');
  assert.equal(f.paired.base, 'https://org.example.org');
  assert.equal(f.values.get('organizationDomain'), 'org.example.org');
  assert.equal(f.cleared, true);
});
test('changing organisation with the same code cannot use another organisation’s offline cache', async () => {
  const f = fixture({ organizationDomain: 'first.example.org', pairingCode: 'ABCD1234', token: 'fixture-token' }, 0, true);
  await f.handlers.pair({ body: { portalCode: 'ABCD1234', organizationDomain: 'second.example.org' } }, f.res);
  assert.equal(f.res.statusCode, 503);
  assert.equal(f.cleared, false);
});
test('same organisation and code can recover its own offline cache', async () => {
  const f = fixture({ organizationDomain: 'first.example.org', pairingCode: 'ABCD1234', token: 'fixture-token', armouryId: 'fixture-armoury' }, 0, true);
  await f.handlers.pair({ body: { portalCode: 'ABCD1234', organizationDomain: 'first.example.org' } }, f.res);
  assert.equal(f.res.statusCode, 200);
  assert.equal(f.res.data.organizationDomain, 'first.example.org');
});
test('pending transactions block a scope switch and are never cleared', async () => {
  const f = fixture({ organizationDomain: 'first.example.org', pairingCode: 'ABCD1234' }, 2);
  await f.handlers.pair({ body: { portalCode: 'ABCD1234', organizationDomain: 'second.example.org' } }, f.res);
  assert.equal(f.res.statusCode, 409);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cleared, false);
});
test('a missing organisation is an error even when the code matches a cache', async () => {
  const f = fixture({ pairingCode: 'ABCD1234', token: 'fixture-token' });
  await f.handlers.pair({ body: { portalCode: 'ABCD1234' } }, f.res);
  assert.notEqual(f.res.statusCode, 200);
  assert.equal(f.calls.length, 0);
});
