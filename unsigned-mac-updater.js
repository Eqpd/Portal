const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function versionParts(version) {
  if (!/^v?\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid stable release version');
  return version.replace(/^v/, '').split('.').map(Number);
}
function newerVersion(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}
function releaseAsset(release, architecture) {
  if (!['arm64', 'x64'].includes(architecture)) throw new Error('Unsupported Mac architecture');
  const asset = release.assets?.find(item =>
    /[-.]mac\.zip$/.test(item.name) &&
    (architecture === 'arm64' ? /arm64[-.]mac\.zip$/.test(item.name) : !item.name.includes('arm64')));
  if (!asset) throw new Error(`No ${architecture} Mac ZIP in the release`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('Release is missing its GitHub SHA-256 checksum');
  const url = new URL(asset.browser_download_url);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/Eqpd/Portal/releases/download/')) {
    throw new Error('Unexpected release download location');
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error('Invalid release download size');
  return asset;
}

// Unsigned macOS applications cannot use Squirrel/ShipIt, which requires an
// Apple signing identity. Download from the fixed public repository over TLS,
// verify GitHub's checksum, then let the operator explicitly install.
// This does NOT disable Gatekeeper or certificate verification.
class UnsignedMacUpdater extends EventEmitter {
  constructor({ version, directory, architecture = process.arch, fetchImpl = fetch }) {
    super();
    this.version = version;
    this.directory = directory;
    this.architecture = architecture;
    this.fetch = fetchImpl;
    this.busy = false;
    this.readyVersion = null;
    this.readyFile = null;
  }
  async checkForUpdatesAndNotify() {
    if (this.busy) return;
    this.busy = true;
    let destination;
    try {
      this.emit('checking-for-update');
      const response = await this.fetch('https://api.github.com/repos/Eqpd/Portal/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Equip-Portal-Updater' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`GitHub release check returned HTTP ${response.status}`);
      const release = await response.json();
      const version = release.tag_name?.replace(/^v/, '');
      if (release.draft || release.prerelease || !newerVersion(version, this.version)) {
        this.emit('update-not-available');
        return;
      }
      if (version === this.readyVersion && fs.existsSync(this.readyFile)) {
        this.emit('update-downloaded', { version, downloadedFile: this.readyFile });
        return;
      }
      const asset = releaseAsset(release, this.architecture);
      this.emit('update-available', { version });
      await fsp.mkdir(this.directory, { recursive: true });
      destination = path.join(this.directory, `Equip-Portal-${version}-${this.architecture}.zip.partial`);
      const download = await this.fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!download.ok || !download.body) throw new Error(`Update download returned HTTP ${download.status}`);
      const hash = createHash('sha256');
      let transferred = 0;
      const started = Date.now();
      const inspect = new Transform({
        transform: (chunk, _encoding, callback) => {
          transferred += chunk.length;
          if (transferred > asset.size) return callback(new Error('Update exceeded the expected size'));
          hash.update(chunk);
          this.emit('download-progress', {
            percent: transferred / asset.size * 100,
            bytesPerSecond: transferred / Math.max((Date.now() - started) / 1000, 1),
          });
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(download.body), inspect, fs.createWriteStream(destination, { mode: 0o600 }));
      if (transferred !== asset.size || hash.digest('hex') !== asset.digest.split(':')[1].toLowerCase()) {
        throw new Error('Update checksum/size verification failed; the installed app was not changed');
      }
      const readyFile = destination.replace(/\.partial$/, '');
      await fsp.rename(destination, readyFile);
      this.readyVersion = version;
      this.readyFile = readyFile;
      this.emit('update-downloaded', { version, downloadedFile: readyFile });
    } catch (error) {
      if (destination) await fsp.rm(destination, { force: true }).catch(() => {});
      this.emit('error', error);
    } finally {
      this.busy = false;
    }
  }
}
module.exports = { UnsignedMacUpdater, newerVersion, releaseAsset };
