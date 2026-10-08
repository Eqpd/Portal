const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../electron-builder.config');
const pkg = require('../package.json');

test('uses a builder with explicit ad-hoc identity support', () => {
  assert.match(pkg.devDependencies['electron-builder'], /^26\./);
  assert.equal(config.mac.identity, process.env.CSC_NAME || '-');
  assert.equal(config.mac.entitlements, 'build/entitlements.mac.plist');
  assert.equal(config.mac.entitlementsInherit, 'build/entitlements.mac.plist');
});
test('Windows certificate options use the new builder schema', () => {
  for (const oldField of ['certificateFile', 'certificatePassword', 'signingHashAlgorithms', 'publisherName']) {
    assert.equal(Object.hasOwn(config.win, oldField), false);
  }
  if (process.env.WIN_CSC_LINK) assert.ok(config.win.signtoolOptions);
  assert.equal(config.win.verifyUpdateCodeSignature, !!process.env.WIN_CSC_LINK);
});
