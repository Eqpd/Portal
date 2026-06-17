const db = require('./db');
const { v4: uuidv4 } = require('uuid');

// ── Local auth middleware ───────────────────────────────────────────────────
// This server only listens on 127.0.0.1 so we just require a non-empty token
// (prevents unauthenticated requests) and that the portal has been paired.
// We don't do strict token equality because the sync engine can legitimately
// refresh the remote token while the UI still holds an older one from localStorage.
function portalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.armouryId = db.getConfig('armouryId');
  if (!req.armouryId) {
    return res.status(401).json({ message: 'Portal not paired' });
  }
  next();
}

module.exports = function registerRoutes(app, { apiBaseUrl = '' } = {}) {

  // ── POST /api/portal/pair ─────────────────────────────────────────────────
  app.post('/api/portal/pair', async (req, res) => {
    const { portalCode } = req.body || {};
    if (!portalCode) return res.status(400).json({ message: 'portalCode required' });

    // Try remote first
    if (apiBaseUrl) {
      try {
        const remote = await fetch(`${apiBaseUrl}/api/portal/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portalCode }),
          signal: AbortSignal.timeout(8000),
        });
        if (remote.ok) {
          const data = await remote.json();
          db.setConfig('token', data.token);
          db.setConfig('armouryId', data.armoury?.id || '');
          db.setConfig('armouryName', data.armoury?.name || '');
          db.setConfig('pairingCode', portalCode);
          return res.json(data);
        }
        const err = await remote.json().catch(() => ({}));
        return res.status(remote.status).json(err);
      } catch {
        // Fall through to offline cached config
      }
    }

    // Offline fallback
    const cachedCode = db.getConfig('pairingCode');
    const cachedToken = db.getConfig('token');
    const cachedArmouryId = db.getConfig('armouryId');
    const cachedArmouryName = db.getConfig('armouryName');

    if (cachedCode && cachedToken && portalCode.toUpperCase() === cachedCode.toUpperCase()) {
      return res.json({
        token: cachedToken,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        armoury: { id: cachedArmouryId, name: cachedArmouryName },
        settings: {},
      });
    }

    res.status(503).json({ message: 'Cannot connect to server and no cached session available.' });
  });

  // ── GET /api/portal/recent-movements ─────────────────────────────────────
  app.get('/api/portal/recent-movements', portalAuth, (req, res) => {
    const armouryId = req.armouryId;
    if (!armouryId) return res.json([]);
    res.json(db.getRecentMovements(armouryId, 20));
  });

  // ── GET /api/portal/available-counts ─────────────────────────────────────
  app.get('/api/portal/available-counts', portalAuth, (req, res) => {
    const armouryId = req.armouryId;
    if (!armouryId) return res.json([]);
    res.json(db.getAvailableCounts(armouryId));
  });

  // ── GET /api/portal/users/rfid/:rfidTag ──────────────────────────────────
  app.get('/api/portal/users/rfid/:rfidTag', portalAuth, (req, res) => {
    const user = db.getUserByRfid(req.params.rfidTag);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      qid: user.qid,
      rfidCardNumber: user.rfidCardNumber,
      role: user.role,
    });
  });

  // ── GET /api/portal/users/:userId/checked-out ─────────────────────────────
  app.get('/api/portal/users/:userId/checked-out', portalAuth, (req, res) => {
    const armouryId = req.armouryId;
    const items = db.getCheckedOutByUser(req.params.userId, armouryId || '');
    res.json(items.map(e => ({
      id: e.id, name: e.name, category: e.category,
      status: e.status, rfidTag: e.rfidTag,
    })));
  });

  // ── GET /api/portal/equipment/rfid/:rfid ─────────────────────────────────
  app.get('/api/portal/equipment/rfid/:rfid', portalAuth, (req, res) => {
    const eq = db.getEquipmentByRfid(req.params.rfid);
    if (!eq) return res.status(404).json({ message: 'Equipment not found' });
    res.json({
      id: eq.id, name: eq.name, category: eq.category,
      status: eq.status, rfidTag: eq.rfidTag, armouryId: eq.armouryId,
    });
  });

  // ── POST /api/portal/checkout ─────────────────────────────────────────────
  app.post('/api/portal/checkout', portalAuth, (req, res) => {
    const { equipmentId, userId } = req.body || {};
    if (!equipmentId || !userId) return res.status(400).json({ message: 'equipmentId and userId required' });

    const eq = db.getEquipmentById(equipmentId);
    if (!eq) return res.status(404).json({ message: 'Equipment not found' });

    const user = db.getUserById(userId);
    // Use caller-supplied transactionId (from sync) or generate a new local UUID
    const txId = uuidv4();

    db.createCheckout(
      txId, equipmentId, userId,
      user?.firstName || '', user?.lastName || '', user?.qid || '',
      eq.name, eq.category || eq.categoryName || ''
    );

    // Persist the transaction UUID in the offline queue so sync propagates the same ID to remote
    db.addToOfflineQueue(uuidv4(), 'checkout', { equipmentId, userId, transactionId: txId });

    res.json({ success: true, message: 'Checked out', transactionId: txId });
  });

  // ── POST /api/portal/checkin ──────────────────────────────────────────────
  app.post('/api/portal/checkin', portalAuth, (req, res) => {
    const { equipmentId } = req.body || {};
    if (!equipmentId) return res.status(400).json({ message: 'equipmentId required' });

    const eq = db.getEquipmentById(equipmentId);
    if (!eq) return res.status(404).json({ message: 'Equipment not found' });

    db.createCheckin(equipmentId);
    db.addToOfflineQueue(uuidv4(), 'checkin', { equipmentId });

    res.json({ success: true, message: 'Checked in' });
  });

  // ── GET /api/portal/sync-status ───────────────────────────────────────────
  app.get('/api/portal/sync-status', portalAuth, (req, res) => {
    res.json({
      pendingCount: db.getPendingCount(),
      lastSyncAt: db.getConfig('lastSyncAt'),
    });
  });

  // ── GET /api/health ───────────────────────────────────────────────────────
  app.get('/api/health', (req, res) => res.json({ ok: true }));
};
