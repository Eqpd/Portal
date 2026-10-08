const db = require('./db');
const { v4: uuidv4 } = require('uuid');

// ── Local auth middleware ───────────────────────────────────────────────────
// Requires a valid token that matches the stored token exactly.
function portalAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const storedToken = db.getConfig('token');
  if (!token || token !== storedToken) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.armouryId = db.getConfig('armouryId');
  if (!req.armouryId) {
    return res.status(401).json({ message: 'Portal not paired' });
  }
  next();
}

module.exports = function registerRoutes(app, { apiBaseUrl = '', onOrganisationPaired, onUnpair } = {}) {

  // ── POST /api/portal/pair ─────────────────────────────────────────────────
  const pairing = require('./organisation-pairing').createOrganisationPairing({
    database: db, getApiBaseUrl: () => apiBaseUrl,
    onPaired: (base, domain) => {
      apiBaseUrl = base;
      onOrganisationPaired?.(base, domain);
    },
  });
  app.get('/api/portal/organisation', pairing.organisation);
  app.post('/api/portal/pair', pairing.pair);
  app.post('/api/portal/unpair', portalAuth, (_req, res) => {
    if (db.getPendingCount() > 0) return res.status(409).json({ message: 'Sync pending offline transactions before disconnecting.' });
    db.setConfig('token', '');
    db.setConfig('pairingCode', '');
    db.setConfig('settings', '');
    onUnpair?.();
    res.json({ success: true });
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
