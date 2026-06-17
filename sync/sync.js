const db = require('../local-server/db');
const { v4: uuidv4 } = require('uuid');

let remoteToken = null;
let armouryId = null;
let apiBaseUrl = null;
let pairingCode = null;
let isOnline = false;
let syncStatusCallback = null;

let networkCheckTimer = null;
let syncTimer = null;

function init(config, onStatus) {
  apiBaseUrl = config.apiBaseUrl;
  pairingCode = config.portalPairingCode || db.getConfig('pairingCode');
  armouryId = db.getConfig('armouryId');
  remoteToken = db.getConfig('token');
  syncStatusCallback = onStatus;

  startNetworkCheck();
  startSyncLoop();
}

function emitStatus() {
  if (!syncStatusCallback) return;
  syncStatusCallback({
    online: isOnline,
    pendingCount: db.getPendingCount(),
    lastSyncAt: db.getConfig('lastSyncAt'),
  });
}

async function ping() {
  if (!apiBaseUrl) return false;
  try {
    const res = await fetch(`${apiBaseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function startNetworkCheck() {
  if (networkCheckTimer) clearInterval(networkCheckTimer);
  networkCheckTimer = setInterval(async () => {
    const wasOnline = isOnline;
    isOnline = await ping();
    if (isOnline && !wasOnline) {
      // Just came online — sync immediately
      runSync().catch(() => {});
    }
    emitStatus();
  }, 10000);
  // Initial check
  ping().then(online => { isOnline = online; emitStatus(); });
}

function startSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (isOnline) runSync().catch(() => {});
  }, 30000);
}

async function runSync() {
  if (!apiBaseUrl) return;

  if (!remoteToken) {
    await doReauth();
  }

  await Promise.allSettled([pushQueue(), pullData()]);
  db.setConfig('lastSyncAt', new Date().toISOString());
  emitStatus();
}

async function doReauth() {
  const code = pairingCode || db.getConfig('pairingCode');
  if (!code || !apiBaseUrl) return false;
  try {
    const res = await fetch(`${apiBaseUrl}/api/portal/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portalCode: code }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.token) {
      remoteToken = data.token;
      db.setConfig('token', data.token);
      if (data.armoury?.id) {
        armouryId = data.armoury.id;
        db.setConfig('armouryId', data.armoury.id);
        db.setConfig('armouryName', data.armoury.name || '');
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function remoteGet(path) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${remoteToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) {
    const ok = await doReauth();
    if (!ok) throw new Error('AUTH_FAILED');
    return remoteGet(path);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function remotePost(path, body) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${remoteToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) {
    const ok = await doReauth();
    if (!ok) throw new Error('AUTH_FAILED');
    return remotePost(path, body);
  }
  return res;
}

async function pullData() {
  if (!armouryId || !apiBaseUrl) return;
  try {
    const [equipmentList, userList] = await Promise.all([
      remoteGet('/api/portal/equipment'),
      remoteGet('/api/portal/users'),
    ]);

    // Upsert equipment
    if (Array.isArray(equipmentList)) {
      for (const eq of equipmentList) {
        db.upsertEquipment(eq);
        // Extract and upsert category from enriched equipment data
        if (eq.categoryId && eq.categoryName) {
          db.upsertCategory({
            id: eq.categoryId,
            name: eq.category || eq.categoryId,
            displayName: eq.categoryName,
          });
        }
      }
    }

    // Upsert users
    if (Array.isArray(userList)) {
      for (const u of userList) db.upsertUser(u);
    }
  } catch (e) {
    if (e.message !== 'AUTH_FAILED') console.error('[sync] pull error:', e.message);
  }

  // Pull recent movements from the server so they survive restarts and reflect
  // transactions done on other portals or from the back office.
  try {
    const movements = await remoteGet('/api/portal/recent-movements');
    if (Array.isArray(movements)) {
      for (const m of movements) db.upsertCachedMovement(m);
    }
  } catch (e) {
    if (e.message !== 'AUTH_FAILED') console.error('[sync] pull movements error:', e.message);
  }
}

async function pushQueue() {
  const items = db.getPendingQueue();
  for (const item of items) {
    try {
      let payload;
      try { payload = JSON.parse(item.payload); } catch { db.markQueueItemSynced(item.id); continue; }

      if (item.type === 'checkout') {
        // Pass the local transactionId so the remote uses the same UUID
        const res = await remotePost('/api/portal/checkout', {
          equipmentId: payload.equipmentId,
          userId: payload.userId,
          transactionId: payload.transactionId, // propagate local UUID
        });
        if (res.ok || res.status === 409) db.markQueueItemSynced(item.id);
      } else if (item.type === 'checkin') {
        const res = await remotePost('/api/portal/checkin', {
          equipmentId: payload.equipmentId,
        });
        if (res.ok || res.status === 409) db.markQueueItemSynced(item.id);
      }
    } catch (e) {
      if (e.message === 'AUTH_FAILED') break;
    }
  }
}

function stop() {
  if (networkCheckTimer) { clearInterval(networkCheckTimer); networkCheckTimer = null; }
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

function getStatus() {
  return {
    online: isOnline,
    pendingCount: db.getPendingCount(),
    lastSyncAt: db.getConfig('lastSyncAt'),
  };
}

module.exports = { init, stop, runSync, getStatus, doReauth };
