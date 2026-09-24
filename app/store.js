/**
 * Local-first storage. IndexedDB is the system of record until a batch lands.
 *
 * Object stores:
 *   trials    completed trial rows, keyed by trial_uid
 *   sessions  one row per app open, keyed by session_uid
 *   outbox    batches awaiting upload, keyed by batch_id
 *   meta      device_id, session_seq, cached config, queue state
 *
 * WRITE DISCIPLINE
 * ----------------
 * Trials are buffered in memory and flushed in the inter-trial interval and at
 * every stage boundary — never during a trial. An IndexedDB transaction is
 * asynchronous but not free, and a flush landing inside a reaction-time trial is
 * exactly the jank that would surface as a long response time. The inter-trial
 * interval is dead time and costs nothing. Worst case on a hard crash is the
 * single trial in progress, whose latency would have been unusable anyway.
 *
 * Every read path tolerates an empty database. Storage was measured as
 * non-persistent on the target machine, so eviction is possible and nothing here
 * may assume its own history exists.
 */

const DB_NAME = 'cognitive-practice';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('trials')) {
        db.createObjectStore('trials', { keyPath: 'trial_uid' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'session_uid' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'batch_id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqValue(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

/* ---------- meta ---------- */

export function getMeta(key, fallback = null) {
  return reqValue('meta', 'readonly', s => s.get(key))
    .then(v => (v === undefined ? fallback : v))
    .catch(() => fallback);
}

export function setMeta(key, value) {
  return tx('meta', 'readwrite', s => s.put(value, key)).catch(() => null);
}

/**
 * device_id is generated once and persisted. If storage is wiped it changes, and
 * that is itself worth seeing in the data rather than papering over.
 */
export async function deviceId() {
  let id = await getMeta('device_id');
  if (!id) {
    id = uuid();
    await setMeta('device_id', id);
  }
  return id;
}

/** Monotonic per device from 1. The practice-effect covariate. */
export async function nextSessionSeq() {
  const n = (await getMeta('session_seq', 0)) + 1;
  await setMeta('session_seq', n);
  return n;
}

export function peekSessionSeq() { return getMeta('session_seq', 0); }

/* ---------- trials ---------- */

export function putTrials(rows) {
  if (!rows.length) return Promise.resolve(0);
  return tx('trials', 'readwrite', s => { rows.forEach(r => s.put(r)); })
    .then(() => rows.length);
}

export function allTrials() {
  return reqValue('trials', 'readonly', s => s.getAll()).catch(() => []);
}

export function trialsForSession(sessionUid) {
  return allTrials().then(rs => rs.filter(r => r.session_uid === sessionUid));
}

export function deleteTrials(uids) {
  if (!uids.length) return Promise.resolve();
  return tx('trials', 'readwrite', s => { uids.forEach(u => s.delete(u)); });
}

/* ---------- sessions ---------- */

export function putSession(row) {
  return tx('sessions', 'readwrite', s => s.put(row));
}

export function getSession(uid) {
  return reqValue('sessions', 'readonly', s => s.get(uid)).catch(() => null);
}

export function allSessions() {
  return reqValue('sessions', 'readonly', s => s.getAll()).catch(() => []);
}

export function deleteSessions(uids) {
  if (!uids.length) return Promise.resolve();
  return tx('sessions', 'readwrite', s => { uids.forEach(u => s.delete(u)); });
}

/**
 * The previous session that reached at least one trial. Used for
 * days_since_prev_session, which is deliberately not "the previous app open" —
 * an open that produced nothing is an engagement event, not a session.
 */
export async function lastSessionWithTrials() {
  const [sessions, trials] = await Promise.all([allSessions(), allTrials()]);
  const withTrials = new Set(trials.map(t => t.session_uid));
  return sessions
    .filter(s => withTrials.has(s.session_uid) && s.start_pressed_at_utc)
    .sort((a, b) => b.start_pressed_at_utc - a.start_pressed_at_utc)[0] || null;
}

/* ---------- outbox ---------- */

export function putOutbox(batch) {
  return tx('outbox', 'readwrite', s => s.put(batch));
}

export function allOutbox() {
  return reqValue('outbox', 'readonly', s => s.getAll()).catch(() => []);
}

export function deleteOutbox(batchId) {
  return tx('outbox', 'readwrite', s => s.delete(batchId));
}

/* ---------- misc ---------- */

export function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Requested once, and its answer recorded rather than relied on. It came back
 * false on the target machine, which is normal for Safari and is why every piece
 * of local state has to be reconstructable from the uploaded data.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return !!(await navigator.storage.persist());
    }
  } catch (e) { /* fall through */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { quota: e.quota || null, usage: e.usage || 0 };
    }
  } catch (e) { /* fall through */ }
  return { quota: null, usage: null };
}
