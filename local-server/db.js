const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

let db = null;

function getDbPath() {
  const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '..', 'data');
  return path.join(userDataPath, 'equip-portal.db');
}

function getDb() {
  if (db) return db;
  db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema();
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      displayName TEXT NOT NULL,
      updatedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      firstName TEXT NOT NULL DEFAULT '',
      lastName TEXT NOT NULL DEFAULT '',
      qid TEXT,
      rfidCardNumber TEXT,
      role TEXT NOT NULL DEFAULT 'staff',
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_rfid ON users(rfidCardNumber);
    CREATE INDEX IF NOT EXISTS idx_users_qid ON users(qid);

    CREATE TABLE IF NOT EXISTS equipment (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      categoryId TEXT,
      categoryName TEXT,
      status TEXT NOT NULL DEFAULT 'available',
      rfidTag TEXT,
      armouryId TEXT,
      updatedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_rfid ON equipment(rfidTag);
    CREATE INDEX IF NOT EXISTS idx_equipment_armoury ON equipment(armouryId);
    CREATE INDEX IF NOT EXISTS idx_equipment_category ON equipment(categoryId);

    CREATE TABLE IF NOT EXISTS equipment_transactions (
      id TEXT PRIMARY KEY,
      equipmentId TEXT NOT NULL,
      userId TEXT NOT NULL,
      action TEXT NOT NULL,
      checkedOutAt TEXT NOT NULL,
      checkedInAt TEXT,
      equipmentName TEXT,
      equipmentCategory TEXT,
      userFirstName TEXT,
      userLastName TEXT,
      userQid TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_equipment ON equipment_transactions(equipmentId);
    CREATE INDEX IF NOT EXISTS idx_tx_user ON equipment_transactions(userId);
    CREATE INDEX IF NOT EXISTS idx_tx_checkedout ON equipment_transactions(checkedOutAt);

    CREATE TABLE IF NOT EXISTS offline_queue (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      syncedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS portal_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS cached_movements (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      equipmentName TEXT DEFAULT '',
      equipmentCategory TEXT DEFAULT '',
      userFirstName TEXT DEFAULT '',
      userLastName TEXT DEFAULT '',
      userQid TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_cached_movements_ts ON cached_movements(timestamp);
  `);
}

// ── Config ──────────────────────────────────────────────────────────────────
function getConfig(key) {
  const row = getDb().prepare('SELECT value FROM portal_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO portal_config (key, value) VALUES (?, ?)').run(key, value);
}

// ── Categories ───────────────────────────────────────────────────────────────
function upsertCategory(cat) {
  getDb().prepare(`
    INSERT INTO categories (id, name, displayName, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      displayName = excluded.displayName,
      updatedAt = excluded.updatedAt
  `).run(
    cat.id || cat.name,
    cat.name,
    cat.displayName || cat.name,
    new Date().toISOString()
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────
function upsertUser(user) {
  getDb().prepare(`
    INSERT INTO users (id, firstName, lastName, qid, rfidCardNumber, role, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      firstName = excluded.firstName,
      lastName = excluded.lastName,
      qid = excluded.qid,
      rfidCardNumber = excluded.rfidCardNumber,
      role = excluded.role,
      updatedAt = excluded.updatedAt
  `).run(
    user.id,
    user.firstName || '',
    user.lastName || '',
    user.qid || null,
    user.rfidCardNumber || null,
    user.role || 'staff',
    new Date().toISOString()
  );
}

// ── Equipment ─────────────────────────────────────────────────────────────────
function upsertEquipment(eq) {
  getDb().prepare(`
    INSERT INTO equipment (id, name, category, categoryId, categoryName, status, rfidTag, armouryId, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      categoryId = excluded.categoryId,
      categoryName = excluded.categoryName,
      status = excluded.status,
      rfidTag = excluded.rfidTag,
      armouryId = excluded.armouryId,
      updatedAt = excluded.updatedAt
  `).run(
    eq.id,
    eq.name,
    eq.category || null,
    eq.categoryId || null,
    eq.categoryName || eq.displayName || eq.category || null,
    eq.status || 'available',
    eq.rfidTag || null,
    eq.armouryId || null,
    new Date().toISOString()
  );
}

function getUserByRfid(rfidTag) {
  return getDb().prepare('SELECT * FROM users WHERE rfidCardNumber = ? COLLATE NOCASE').get(rfidTag);
}

function getEquipmentByRfid(rfidTag) {
  return getDb().prepare('SELECT * FROM equipment WHERE rfidTag = ? COLLATE NOCASE').get(rfidTag);
}

function getEquipmentById(id) {
  return getDb().prepare('SELECT * FROM equipment WHERE id = ?').get(id);
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getCheckedOutByUser(userId, armouryId) {
  return getDb().prepare(`
    SELECT e.* FROM equipment_transactions t
    JOIN equipment e ON t.equipmentId = e.id
    WHERE t.userId = ? AND t.checkedInAt IS NULL AND e.armouryId = ?
    ORDER BY t.checkedOutAt DESC
  `).all(userId, armouryId);
}

function getRecentMovements(armouryId, limit = 20) {
  // Local transactions recorded on this machine
  const localRows = getDb().prepare(`
    SELECT t.id, t.action, t.checkedOutAt, t.checkedInAt,
           t.equipmentName, t.equipmentCategory,
           t.userFirstName, t.userLastName, t.userQid
    FROM equipment_transactions t
    JOIN equipment e ON t.equipmentId = e.id
    WHERE e.armouryId = ?
    ORDER BY CASE WHEN t.checkedInAt IS NOT NULL AND t.checkedInAt > t.checkedOutAt
                  THEN t.checkedInAt ELSE t.checkedOutAt END DESC
    LIMIT ?
  `).all(armouryId, limit);

  const local = [];
  for (const r of localRows) {
    const base = {
      equipmentName: r.equipmentName,
      equipmentCategory: r.equipmentCategory,
      userFirstName: r.userFirstName,
      userLastName: r.userLastName,
      userQid: r.userQid,
    };
    if (r.checkedInAt) {
      local.push({ ...base, id: `${r.id}_in`, action: 'check_in', timestamp: r.checkedInAt });
    }
    if (r.checkedOutAt) {
      local.push({ ...base, id: `${r.id}_out`, action: 'check_out', timestamp: r.checkedOutAt });
    }
  }

  // Movements pulled from the server (other portals, back office, etc.)
  const cached = getDb().prepare(`
    SELECT id, action, timestamp, equipmentName, equipmentCategory,
           userFirstName, userLastName, userQid
    FROM cached_movements
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit);

  // Merge, deduplicate by id, sort newest-first
  const seen = new Set();
  const merged = [];
  for (const m of [...local, ...cached]) {
    if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
  }
  merged.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
  return merged.slice(0, limit);
}

function upsertCachedMovement(m) {
  if (!m || !m.id || !m.timestamp) return;
  getDb().prepare(`
    INSERT OR REPLACE INTO cached_movements
      (id, action, timestamp, equipmentName, equipmentCategory, userFirstName, userLastName, userQid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    m.id,
    m.action || 'check_out',
    m.timestamp,
    m.equipmentName || '',
    m.equipmentCategory || '',
    m.userFirstName || '',
    m.userLastName || '',
    m.userQid || '',
  );
}

function getAvailableCounts(armouryId) {
  const rows = getDb().prepare(`
    SELECT COALESCE(e.category, e.categoryId) as categoryKey,
           COALESCE(c.displayName, e.categoryName, e.category) as categoryName,
           e.status, COUNT(*) as cnt
    FROM equipment e
    LEFT JOIN categories c ON e.categoryId = c.id
    WHERE e.armouryId = ? AND COALESCE(e.category, e.categoryId) IS NOT NULL
    GROUP BY categoryKey, categoryName, e.status
  `).all(armouryId);

  const map = {};
  for (const r of rows) {
    const key = r.categoryKey;
    if (!map[key]) map[key] = { category: key, categoryName: r.categoryName || key, available: 0, total: 0 };
    map[key].total += r.cnt;
    if (r.status === 'available') map[key].available += r.cnt;
  }
  return Object.values(map);
}

// ── Transactions ──────────────────────────────────────────────────────────────
function createCheckout(id, equipmentId, userId, userFirstName, userLastName, userQid, equipmentName, equipmentCategory) {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO equipment_transactions
      (id, equipmentId, userId, action, checkedOutAt, equipmentName, equipmentCategory, userFirstName, userLastName, userQid)
    VALUES (?, ?, ?, 'check_out', ?, ?, ?, ?, ?, ?)
  `).run(id, equipmentId, userId, now, equipmentName || '', equipmentCategory || '', userFirstName || '', userLastName || '', userQid || '');
  getDb().prepare("UPDATE equipment SET status = 'checked_out' WHERE id = ?").run(equipmentId);
}

function createCheckin(equipmentId) {
  const now = new Date().toISOString();
  getDb().prepare(`
    UPDATE equipment_transactions SET checkedInAt = ?
    WHERE equipmentId = ? AND checkedInAt IS NULL
  `).run(now, equipmentId);
  getDb().prepare("UPDATE equipment SET status = 'available' WHERE id = ?").run(equipmentId);
}

// ── Offline queue ─────────────────────────────────────────────────────────────
function addToOfflineQueue(id, type, payload) {
  getDb().prepare(`
    INSERT INTO offline_queue (id, type, payload, createdAt)
    VALUES (?, ?, ?, ?)
  `).run(id, type, JSON.stringify(payload), new Date().toISOString());
}

function getPendingQueue() {
  return getDb().prepare('SELECT * FROM offline_queue WHERE syncedAt IS NULL ORDER BY createdAt ASC').all();
}

function markQueueItemSynced(id) {
  getDb().prepare('UPDATE offline_queue SET syncedAt = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function getPendingCount() {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM offline_queue WHERE syncedAt IS NULL').get();
  return row ? row.cnt : 0;
}

module.exports = {
  getDb, getConfig, setConfig,
  upsertCategory, upsertUser, upsertEquipment,
  getUserByRfid, getEquipmentByRfid, getEquipmentById, getUserById,
  getCheckedOutByUser, getRecentMovements, upsertCachedMovement, getAvailableCounts,
  createCheckout, createCheckin,
  addToOfflineQueue, getPendingQueue, markQueueItemSynced, getPendingCount,
};
