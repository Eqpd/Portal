const express = require('express');
const path = require('path');
const fs = require('fs');
const registerRoutes = require('./routes');
const uiCache = require('./ui-cache');

let server = null;
let assignedPort = null;

async function start(config = {}, onUiUpdate) {
  // Initialise UI cache if we have a remote server to pull from
  if (config.apiBaseUrl && config.uiCacheDir) {
    uiCache.init({ dir: config.uiCacheDir, url: config.apiBaseUrl });

    // Check for a newer version on startup (don't block the server from starting)
    uiCache.checkAndUpdate()
      .then(updated => { if (updated && onUiUpdate) onUiUpdate(); })
      .catch(() => {});

    // Then re-check every 5 minutes; call onUiUpdate when a new version lands
    uiCache.startRefreshTimer(5 * 60 * 1000, onUiUpdate);
  }

  const app = express();
  app.use(express.json());

  // UI serving priority:
  //   1. ui-cache/ (freshest version downloaded from Replit) — only if complete
  //   2. renderer/  (bundled fallback — always present in packaged builds)
  const cacheDir = uiCache.getCacheDir();
  const rendererPath = path.join(__dirname, '..', 'renderer');

  // Validate the cache: ensure every asset referenced by index.html is present.
  // A partial cache (index.html downloaded but assets missing) causes a white
  // screen because the bundled renderer has different asset filenames.
  function isCacheComplete(dir) {
    const indexPath = path.join(dir, 'index.html');
    if (!fs.existsSync(indexPath)) return false;
    const html = fs.readFileSync(indexPath, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)=["']([^"'?#]+\.(?:js|css))["']/g)]
      .map(m => m[1].replace(/^\.\//, ''));
    return refs.every(ref => fs.existsSync(path.join(dir, ref)));
  }

  if (cacheDir && fs.existsSync(cacheDir)) {
    if (isCacheComplete(cacheDir)) {
      app.use(express.static(cacheDir));
    } else {
      console.warn('[local-server] UI cache is incomplete — falling back to bundled renderer');
      // Remove the broken cache so the next checkAndUpdate starts fresh
      try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
    }
  }
  app.use(express.static(rendererPath));

  // Portal API routes — pass runtime config so routes can forward to remote
  registerRoutes(app, { apiBaseUrl: config.apiBaseUrl || '' });

  // SPA fallback — serve cached index.html when available, else bundled copy
  app.get(/^(?!\/api\/).*/, (req, res) => {
    const cachedIndex = cacheDir && path.join(cacheDir, 'index.html');
    if (cachedIndex && fs.existsSync(cachedIndex)) {
      return res.sendFile(cachedIndex);
    }
    res.sendFile(path.join(rendererPath, 'index.html'));
  });

  return new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      assignedPort = server.address().port;
      console.log(`[local-server] running on http://127.0.0.1:${assignedPort}`);
      resolve(assignedPort);
    });
    server.on('error', reject);
  });
}

function stop() {
  uiCache.stop();
  if (server) { server.close(); server = null; }
}

function getPort() { return assignedPort; }

module.exports = { start, stop, getPort };
