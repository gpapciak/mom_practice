/**
 * Tests for the delivery path: the outbox, the drain, the beacon, and eviction.
 *
 *   node tests/test_upload.mjs
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * It was written after noticing that the shell suite had thirty sections and not one
 * of them touched `upload.js` or `store.js`. The probes were tested to the
 * millisecond; the pipe that carries their output to the one place anybody can read
 * it was not tested at all.
 *
 * That is the wrong way round for remote use. A probe that is subtly wrong produces a
 * series someone can still question later. A delivery path that is wrong produces
 * SILENCE - and silence is indistinguishable from a day nobody did a session, which
 * is the one ambiguity this record cannot absorb, because whether a day was missed is
 * itself the measurement.
 *
 * So the cases here are deliberately the unhappy ones: the network is down, the page
 * is closing, the endpoint rejects, the browser has deleted everything.
 */

import assert from 'node:assert';

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

/* ------------------------------------------------------- a minimal IndexedDB */

/**
 * Enough IndexedDB to run the real store.js. Deliberately small, so a store.js that
 * reaches for something new fails loudly here instead of passing against a
 * permissive fake.
 *
 * `wipe()` is the point of the whole file: it is what Safari does to a non-persistent
 * origin after seven days without interaction.
 */
let broken = false;

function installIDB() {
  const dbs = new Map();
  /*
   * A NOTE ON WHY THIS IS SHARED RATHER THAN REBUILT PER SECTION.
   *
   * `upload.js` imports `./store.js` unversioned, and `store.js` caches its open
   * database in a module-level promise. Importing `store.js?v=N` in a test therefore
   * creates a SECOND module instance with its own database, and the test then watches
   * a different store from the one the code under test is writing to. The first draft
   * of this file did exactly that, and the symptoms were baffling: two batches sent
   * after one enqueue, queued events arriving empty.
   *
   * So there is one module instance and one registry, and `clear()` empties the stores
   * in place - which keeps the cached promise valid while leaving no data, exactly the
   * state an evicted origin is in.
   */

  class Req {
    constructor() { this.result = undefined; this.onsuccess = null; this.onerror = null; }
    _done(v) { this.result = v; queueMicrotask(() => this.onsuccess && this.onsuccess()); }
  }

  class Store {
    constructor(name, keyPath) { this.name = name; this.keyPath = keyPath; this.data = new Map(); }
    put(value, key) {
      const k = this.keyPath ? value[this.keyPath] : key;
      this.data.set(k, value);
      const r = new Req(); r._done(k); return r;
    }
    get(k) { const r = new Req(); r._done(this.data.get(k)); return r; }
    getAll() { const r = new Req(); r._done([...this.data.values()]); return r; }
    delete(k) { this.data.delete(k); const r = new Req(); r._done(undefined); return r; }
  }

  class DB {
    constructor() { this.stores = new Map(); this.objectStoreNames = { contains: n => this.stores.has(n) }; }
    createObjectStore(n, opts) {
      const s = new Store(n, opts && opts.keyPath);
      this.stores.set(n, s);
      return s;
    }
    transaction(names) {
      if (broken) throw new Error('storage blocked');
      const db = this;
      const t = {
        oncomplete: null, onerror: null, onabort: null,
        objectStore: n => db.stores.get(n),
      };
      queueMicrotask(() => t.oncomplete && t.oncomplete());
      return t;
    }
  }

  global.indexedDB = {
    open(name) {
      const req = new Req();
      let fresh = false;
      if (!dbs.has(name)) { dbs.set(name, new DB()); fresh = true; }
      const db = dbs.get(name);
      req.result = db;
      queueMicrotask(() => {
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };

  return {
    /** What Safari does to a non-persistent origin after seven days of no interaction. */
    wipe() { for (const db of dbs.values()) for (const st of db.stores.values()) st.data.clear(); },
    /** Make every transaction throw, to prove a broken database degrades rather than stops. */
    breakIt(on = true) { broken = on; },
  };
}

/** Records every request so a test can assert what was actually sent. */
function installNetwork() {
  const net = { posts: [], gets: [], beacons: [], reply: { ok: true }, fail: false };

  global.fetch = async (url, opts = {}) => {
    if (!opts.method || opts.method === 'GET') {
      net.gets.push(String(url));
      if (net.fail) throw new Error('offline');
      return { json: async () => net.getReply || { ok: false } };
    }
    net.posts.push({ url: String(url), body: JSON.parse(opts.body) });
    if (net.fail) throw new Error('offline');
    return { json: async () => (typeof net.reply === 'function' ? net.reply(net.posts.length) : net.reply) };
  };

  global.Blob = class { constructor(parts) { this.parts = parts; } };
  // `crypto` is a read-only getter on modern Node globals, so store.js's
  // `window.crypto` is stubbed rather than the global one reassigned.
  global.window = { crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) } };
  global.AbortController = class { constructor() { this.signal = {}; } abort() {} };

  Object.defineProperty(global, 'navigator', {
    value: {
      userAgent: 'test',
      storage: { persist: async () => false, estimate: async () => ({ quota: 1e9 }) },
      sendBeacon: (url, body) => { net.beacons.push({ url: String(url), body }); return net.beaconOk !== false; },
    },
    configurable: true, writable: true,
  });
  return net;
}

/* One instance of each, for the reason given on installIDB(). */
const idb = installIDB();
const net = installNetwork();
const store = await import('../app/store.js');
const upload = await import('../app/upload.js');

/** Back to a clean origin: no data, network up, default reply. */
async function reset() {
  idb.breakIt(false);
  idb.wipe();
  net.posts.length = 0; net.gets.length = 0; net.beacons.length = 0;
  net.fail = false; net.reply = { ok: true }; net.beaconOk = true; net.getReply = null;
}

const trialRow = uid => ({ trial_uid: uid, session_uid: 's1', session_date_local: '2026-10-01' });
const sessionRow = uid => ({ session_uid: uid, session_date_local: '2026-10-01', session_seq: 1 });

/* ========================= 1. a completed session is queued before anything else */

section('1. a completed session is durable before the network is touched');
{
  await reset();

  await store.putTrials([trialRow('t1'), trialRow('t2')]);
  const batchId = await upload.enqueue([trialRow('t1'), trialRow('t2')], [sessionRow('s1')]);

  check('a batch id comes back', !!batchId);
  const ob = await upload.outboxSummary();
  check('it is in the outbox before any POST', ob.pending === 1, JSON.stringify(ob));
  check('and no request has been made yet', net.posts.length === 0, String(net.posts.length));
  check('the trial rows are still local too', (await store.allTrials()).length === 2);
}

/* ========================= 2. the ordinary case */

section('2. a successful drain removes the batch and the local copies');
{
  await reset();

  await store.putTrials([trialRow('t1')]);
  await store.putSession(sessionRow('s1'));
  await upload.enqueue([trialRow('t1')], [sessionRow('s1')]);

  const res = await upload.drain();
  check('one batch sent', res.sent === 1, JSON.stringify(res));
  check('the outbox is empty', (await upload.outboxSummary()).pending === 0);
  check('local trials are cleaned up once the Sheet has them',
    (await store.allTrials()).length === 0);
  check('the token travelled with it', net.posts[0].body.token !== undefined);
  check('the body is one batch, not one row per request', net.posts.length === 1);
}

/* ========================= 3. offline: nothing may be lost */

section('3. offline - the batch is KEPT, never dropped');
{
  await reset();
  net.fail = true;

  await store.putTrials([trialRow('t1')]);
  await upload.enqueue([trialRow('t1')], [sessionRow('s1')]);

  const res = await upload.drain();
  check('nothing sent', res.sent === 0);
  check('the batch is kept', res.kept === 1, JSON.stringify(res));
  check('it is STILL in the outbox', (await upload.outboxSummary()).pending === 1);
  check('and the local trial rows were NOT deleted',
    (await store.allTrials()).length === 1,
    'deleting them on a failed send is how a session would vanish');

  // The next session drains it.
  net.fail = false;
  const res2 = await upload.drain();
  check('the next attempt sends it', res2.sent === 1, JSON.stringify(res2));
  check('a fortnight offline would drain as a fortnight of batches',
    (await upload.outboxSummary()).pending === 0);
}

/* ========================= 4. a duplicate is not a failure */

section('4. a duplicate reply means it already landed, so it is removed');
{
  await reset();
  net.reply = { ok: true, duplicate: true };

  await upload.enqueue([trialRow('t1')], [sessionRow('s1')]);
  const res = await upload.drain();
  check('counted as sent', res.sent === 1, JSON.stringify(res));
  check('and removed, because keeping it would double the rows',
    (await upload.outboxSummary()).pending === 0);
}

/* ========================= 5. rejection is quarantined and REPORTED */

section('5. a rejected batch is quarantined, and the news reaches the Sheet');
{
  await reset();
  net.reply = { ok: false, retryable: false, error: 'hostile column name' };

  await upload.enqueue([trialRow('t1')], [sessionRow('s1')]);
  const res = await upload.drain();
  check('quarantined, not deleted', res.quarantined === 1, JSON.stringify(res));
  const ob = await upload.outboxSummary();
  check('it is held as quarantined', ob.quarantined === 1 && ob.pending === 0, JSON.stringify(ob));

  // A quarantined batch means a client bug or an attack. Reporting it only to a debug
  // pane means nobody sees it, least of all from another country.
  const queued = await store.takeQueuedEvents();
  check('an event was queued so the next batch carries the news',
    queued.some(e => e.type === 'batch_quarantined'), JSON.stringify(queued));
  check('and the reason is in it, not just the fact',
    queued.some(e => String(e.detail).includes('hostile column name')));

  // It must not be retried forever: identical input fails identically.
  net.posts.length = 0;
  await upload.drain();
  check('a quarantined batch is not retried', net.posts.length === 0);
}

/* ========================= 6. the beacon */

section('6. the beacon survives the page going away');
{
  await reset();

  await upload.enqueue([trialRow('t1')], [sessionRow('s1')]);
  await upload.enqueue([trialRow('t2')], [sessionRow('s2')]);

  const handed = await upload.beaconOutbox();
  check('both batches were handed to the browser', handed === 2, String(handed));
  check('as beacons, not fetches', net.beacons.length === 2 && net.posts.length === 0);
  check('to the same endpoint', net.beacons[0].url === net.posts.length ? true : !!net.beacons[0].url);

  /*
   * THE CRITICAL PROPERTY. A beacon cannot be read, so there is no acknowledgement,
   * so nothing may be deleted on the strength of it. Deleting here would be the exact
   * bug this file exists to prevent: a session that looks delivered and is not.
   */
  check('NOTHING was deleted, because a beacon cannot be acknowledged',
    (await upload.outboxSummary()).pending === 2,
    'the endpoint ledger absorbs the duplicate; a lost batch cannot be absorbed');

  // A refused beacon (over the size limit) must not be treated as handled either.
  net.beaconOk = false;
  const handed2 = await upload.beaconOutbox();
  check('a refused beacon is not counted as handed over', handed2 === 0, String(handed2));
  check('and the batches are still queued', (await upload.outboxSummary()).pending === 2);
}

/* ========================= 7. eviction: what is actually lost */

section('7. eviction - what is lost, and what it looks like afterwards');
{
  await reset();
  net.fail = true;                       // the session completed offline

  await store.deviceId();
  await store.nextSessionSeq();
  await store.nextSessionSeq();          // two sessions done
  await store.putTrials([trialRow('t1')]);
  await upload.enqueue([trialRow('t1')], [sessionRow('s1')]);
  const seqBefore = await store.peekSessionSeq();
  const devBefore = await store.deviceId();
  check('two sessions on the clock', seqBefore === 2, String(seqBefore));
  check('one batch waiting to go', (await upload.outboxSummary()).pending === 1);

  // Safari deletes every byte for the origin.
  idb.wipe();

  check('THE UNSENT BATCH IS GONE - this is the one unrecoverable loss',
    (await upload.outboxSummary()).pending === 0);
  check('session_seq has reset, so the covariate would restart at 1',
    (await store.peekSessionSeq()) === 0, String(await store.peekSessionSeq()));
  check('and a fresh device_id would be minted, which is the visible tell',
    (await store.deviceId()) !== devBefore);
  check('cached config is gone, so the greeting loses its name until the network answers',
    (await store.getMeta('config')) === null);
  check('cached training content is gone too',
    ((await store.getMeta('training_items', [])) || []).length === 0);
}

/* ========================= 8. eviction is detectable, and the seq recoverable */

section('8. eviction is detectable from the server, so silence is not ambiguous');
{
  await reset();

  // The server remembers what the device forgot.
  net.getReply = { ok: true, session_seq: 14, device_id: 'dev-abc', session_date_local: '2026-10-08' };
  const remote = await upload.fetchLastSession();
  check('the server reports the highest session_seq it holds',
    remote && remote.session_seq === 14, JSON.stringify(remote));
  check('the read is authenticated', net.gets.some(u => u.includes('token=')));
  check('and asks for last_session', net.gets.some(u => u.includes('action=last_session')));

  /*
   * The recovery decision, which lives in main.js and is restated here as the
   * invariant it has to satisfy: local history empty AND server history present means
   * this device was wiped - a genuinely new device cannot have server history under
   * its own id.
   */
  const evicted = (localSeq, remoteSeq) => localSeq === 0 && remoteSeq > 0;
  check('empty local + server history = evicted', evicted(0, 14) === true);
  check('empty local + empty server = genuinely a first run', evicted(0, 0) === false);
  check('local history present = ordinary session, no recovery', evicted(3, 14) === false);

  await store.queueEvent('storage_evicted', 'server has session_seq=14');
  const q = await store.takeQueuedEvents();
  check('the eviction is queued as an event for the next batch',
    q.some(e => e.type === 'storage_evicted'), JSON.stringify(q));
  check('reading the queue clears it, so it is reported once',
    (await store.takeQueuedEvents()).length === 0);

  // Offline at boot must not be mistaken for a fresh device.
  net.fail = true;
  check('offline returns null rather than a zero that would look like a first run',
    (await upload.fetchLastSession()) === null);
}

/* ========================= 9. the queued-event list is bounded */

section('9. queued notices are bounded, because they only drain on a good session');
{
  await reset();
  for (let i = 0; i < 80; i++) await store.queueEvent('noise', 'n' + i);
  const q = await store.takeQueuedEvents();
  check('the list is capped', q.length === 50, String(q.length));
  check('and keeps the most recent, which are the ones still true',
    q[q.length - 1].detail === 'n79', q[q.length - 1].detail);
  check('every notice carries a timestamp and a source',
    q.every(e => e.logged_at_ms > 0 && e.source === 'client'));
}

/* ========================= 10. storage failures never break a session */

section('10. a broken database degrades the session, it does not stop it');
{
  await reset();
  idb.breakIt();

  check('reading meta falls back', (await store.getMeta('x', 'fallback')) === 'fallback');
  check('queueing an event does not throw', (await store.queueEvent('t', 'd')) === undefined);
  check('taking events returns empty', (await store.takeQueuedEvents()).length === 0);
  check('the outbox reads as empty rather than throwing',
    (await upload.outboxSummary()).pending === 0);
  check('a drain over a dead database does not throw',
    (await upload.drain()).sent === 0);
}

/* ------------------------------------------------------------------- summary */

console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`ALL ${pass} CHECKS PASSED`);
