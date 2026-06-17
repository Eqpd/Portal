/**
 * ui-cache.js — Remote UI caching for the Electron portal.
 *
 * Fetches the portal UI from the deployed Replit server and stores it on disk.
 * The local Express server serves from this cache, giving instant offline loads
 * while transparently updating to the latest version whenever the server is reachable.
 *
 * Flow:
 *   1. init()          — point at cache dir and remote base URL
 *   2. checkAndUpdate()— compare remote version hash vs cached; download if different
 *   3. startRefreshTimer(ms, cb) — repeat check every N ms; call cb() if updated
 *   4. stop()          — clear timer on app quit
 */

const fs = require('fs');
const path = require('path');

let cacheDir = null;
let baseUrl = null;
let refreshTimer = null;

// ── Initialise ────────────────────────────────────────────────────────────────
function init({ dir, url }) {
  cacheDir = dir;
  baseUrl = url;
  if (cacheDir && !fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────
function hasCachedUI() {
  return !!(cacheDir && fs.existsSync(path.join(cacheDir, 'index.html')));
}

function getCachedVersion() {
  if (!cacheDir) return null;
  const f = path.join(cacheDir, '_version.txt');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
}

function setCachedVersion(v) {
  fs.writeFileSync(path.join(cacheDir, '_version.txt'), String(v));
}

// ── Version check + download ─────────────────────────────────────────────────
/**
 * Returns true if a new version was downloaded, false otherwise.
 * Never throws — all errors are caught and logged.
 */
async function checkAndUpdate() {
  if (!baseUrl || !cacheDir) return false;
  try {
    const res = await fetch(`${baseUrl}/api/electron-portal-version`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;

    const { version } = await res.json();
    if (!version || version === 'none') return false;

    // Already on this version and cache exists — nothing to do
    if (version === getCachedVersion() && hasCachedUI()) return false;

    console.log(`[ui-cache] Downloading version ${version}…`);
    const ok = await downloadUI();
    if (ok) {
      setCachedVersion(version);
      console.log(`[ui-cache] Updated to version ${version}`);
      return true;
    }
    return false;
  } catch (e) {
    console.warn('[ui-cache] Version check failed:', e.message);
    return false;
  }
}

async function downloadUI() {
  try {
    // Fetch the HTML entry point
    const htmlRes = await fetch(`${baseUrl}/electron-portal/`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!htmlRes.ok) return false;
    const html = await htmlRes.text();

    // Collect all asset references — handle both absolute (/assets/foo.js)
    // and relative (./assets/foo.js) paths produced by Vite builds.
    // Resolve everything to a server path under /electron-portal/ for
    // downloading, and a local path relative to cacheDir for storage.
    const assets = []; // [{ serverPath, localRelPath }]
    for (const m of html.matchAll(/(?:src|href)=["']([^"'?#]+\.(?:js|css|woff2?|ttf|eot|ico|png|svg|webp))["']/g)) {
      let p = m[1];
      let localRel;
      if (p.startsWith('./')) {
        // ./assets/foo.js  →  download from /electron-portal/assets/foo.js
        //                     store at  cacheDir/assets/foo.js
        localRel = p.slice(2); // strip ./
        p = '/electron-portal/' + localRel;
      } else if (p.startsWith('/')) {
        // absolute path — store stripped of leading /
        localRel = p.replace(/^\//, '');
      } else {
        // bare relative — treat same as ./
        localRel = p;
        p = '/electron-portal/' + p;
      }
      assets.push({ serverPath: p, localRelPath: localRel });
    }

    // Download all assets in parallel; abort the whole update if any fail
    // (a partial cache = missing JS/CSS = white screen)
    const results = await Promise.allSettled(assets.map(async ({ serverPath, localRelPath }) => {
      const r = await fetch(`${baseUrl}${serverPath}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${serverPath}`);
      const localPath = path.join(cacheDir, localRelPath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, Buffer.from(await r.arrayBuffer()));
    }));

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      failed.forEach(r => console.warn('[ui-cache] Asset download failed:', r.reason?.message));
      console.warn('[ui-cache] Keeping existing cache to avoid partial update');
      return false;
    }

    // Write HTML last — only reached if all assets succeeded
    fs.writeFileSync(path.join(cacheDir, 'index.html'), html);
    return true;
  } catch (e) {
    console.error('[ui-cache] Download failed:', e.message);
    return false;
  }
}

// ── Periodic refresh ──────────────────────────────────────────────────────────
/**
 * @param {number} intervalMs  How often to check (default 5 min)
 * @param {Function} onUpdate  Called with no args when a new version is applied
 */
function startRefreshTimer(intervalMs, onUpdate) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try {
      const updated = await checkAndUpdate();
      if (updated && onUpdate) onUpdate();
    } catch {}
  }, intervalMs);
}

function stop() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function getCacheDir() { return cacheDir; }

module.exports = { init, hasCachedUI, checkAndUpdate, startRefreshTimer, stop, getCacheDir };
