const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { UnsignedMacUpdater, newerVersion, releaseAsset } = require('../unsigned-mac-updater');
const bytes = Buffer.from('fake installer bytes for checksum tests');
function release(architecture = 'arm64', digest = createHash('sha256').update(bytes).digest('hex')) {
  return {
    tag_name: 'v1.0.19', draft: false, prerelease: false,
    assets: [{
      name: `Equip-Portal-1.0.19-${architecture === 'arm64' ? 'arm64-' : ''}mac.zip`,
      digest: `sha256:${digest}`, size: bytes.length,
      browser_download_url: 'https://github.com/Eqpd/Portal/releases/download/v1.0.19/test.zip',
    }],
  };
}
test('version comparison is numeric and excludes malformed/prerelease tags', () => {
  assert.equal(newerVersion('v1.0.19', '1.0.18'), true);
  assert.equal(newerVersion('1.0.9', '1.0.18'), false);
  assert.equal(newerVersion('1.0.18', '1.0.18'), false);
  assert.throws(() => newerVersion('1.0.19-beta', '1.0.18'));
});
test('selects the correct architecture and rejects missing checksums/untrusted locations', () => {
  const combined = { assets: [...release('arm64').assets, ...release('x64').assets] };
  assert.match(releaseAsset(combined, 'arm64').name, /arm64/);
  assert.doesNotMatch(releaseAsset(combined, 'x64').name, /arm64/);
  assert.throws(() => releaseAsset(release('arm64', ''), 'arm64'));
  const foreign = release();
  foreign.assets[0].browser_download_url = 'https://example.com/test.zip';
  assert.throws(() => releaseAsset(foreign, 'arm64'));
});
async function withUpdater(t, data, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'equip-updater-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const updater = new UnsignedMacUpdater({
    version: '1.0.18', directory, architecture: 'arm64',
    fetchImpl: async url => url.includes('api.github.com')
      ? Response.json(data) : new Response(bytes),
  });
  await callback(updater, directory);
}
test('verified ZIP reaches ready status and does not download repeatedly', async t => {
  await withUpdater(t, release(), async updater => {
    let ready;
    let downloads = 0;
    updater.on('error', error => { throw error; });
    updater.on('update-available', () => downloads++);
    updater.on('update-downloaded', info => { ready = info; });
    await updater.checkForUpdatesAndNotify();
    assert.equal(ready.version, '1.0.19');
    assert.deepEqual(await fs.readFile(ready.downloadedFile), bytes);
    await updater.checkForUpdatesAndNotify();
    assert.equal(downloads, 1);
  });
});
test('checksum mismatch is an error, deletes partial ZIP and never signals installable', async t => {
  await withUpdater(t, release('arm64', '0'.repeat(64)), async (updater, directory) => {
    let error;
    let ready = false;
    updater.on('error', value => { error = value; });
    updater.on('update-downloaded', () => { ready = true; });
    await updater.checkForUpdatesAndNotify();
    assert.match(error.message, /checksum/);
    assert.equal(ready, false);
    assert.deepEqual(await fs.readdir(directory), []);
  });
});
test('draft/prerelease builds never become installable', async t => {
  const data = release();
  data.prerelease = true;
  await withUpdater(t, data, async updater => {
    let ready = false;
    updater.on('update-downloaded', () => { ready = true; });
    updater.on('error', error => { throw error; });
    await updater.checkForUpdatesAndNotify();
    assert.equal(ready, false);
  });
});
