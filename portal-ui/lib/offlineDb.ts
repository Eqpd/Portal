// Minimal IndexedDB portal session store for the Electron portal UI.
// Only the session-related helpers are needed; equipment/transaction storage
// is handled by SQLite in the main process.

interface PortalSession {
  armouryId: string;
  armouryName: string;
  stationName: string;
  portalToken: string;
  portalCode?: string;
  lastSynced: number;
}

const DB_NAME = 'equip-portal-v2';
const DB_VERSION = 1;
let db: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(new Error('Failed to open IndexedDB'));
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onupgradeneeded = (e) => {
      const database = (e.target as IDBOpenDBRequest).result;
      if (!database.objectStoreNames.contains('session')) {
        database.createObjectStore('session', { keyPath: 'armouryId' });
      }
    };
  });
}

export async function savePortalSession(session: PortalSession): Promise<void> {
  const database = await openDb();
  const tx = database.transaction('session', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('session').put(session);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getPortalSession(): Promise<PortalSession | null> {
  const database = await openDb();
  const tx = database.transaction('session', 'readonly');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('session').getAll();
    req.onsuccess = () => resolve(req.result?.[0] ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearPortalSession(): Promise<void> {
  const database = await openDb();
  const tx = database.transaction('session', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('session').clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
