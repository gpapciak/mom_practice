/**
 * Upload: one batch per session, never a byte during a timed task.
 *
 * A per-trial POST would contaminate the reaction-time measures, which is the
 * reason this design is local-first at all. The network is touched in exactly
 * three places, all of them outside timing:
 *
 *   1. session end, after the closing screen is already on screen
 *   2. the start of the next session, before START is pressed
 *   3. visibilitychange -> hidden, because local storage is not persistent on the
 *      target machine and an unsent batch is the only thing eviction could destroy
 *
 * Unsent batches accumulate in the outbox and drain. A fortnight offline drains as
 * a fortnight of batches.
 */

import { ENDPOINT, TOKEN, COLLECTING } from './config.js';
import { TRIAL_COLUMNS, SESSION_COLUMNS, TEXT_COLUMNS } from './columns.js';
import * as store from './store.js';

/**
 * Content-Type MUST be text/plain.
 *
 * An application/json POST triggers a preflight OPTIONS request, which Apps Script
 * web apps do not answer, and it fails in Safari with a CORS error that looks
 * exactly like a network problem and is not. The endpoint parses the body itself.
 */
const CONTENT_TYPE = 'text/plain;charset=utf-8';

const REQUEST_TIMEOUT_MS = 20000;

/** Row objects -> arrays in schema column order. */
function block(columns, rows) {
  return {
    columns,
    rows: rows.map(r => columns.map(c => (r[c] === undefined ? null : r[c]))),
    text_columns: TEXT_COLUMNS
  };
}

/**
 * Columns for the _events tab. Matches what the script's own logEvent_ writes, so
 * client and server notices land in one readable list rather than two shapes.
 */
export const EVENT_COLUMNS = ['logged_at_ms', 'source', 'type', 'detail'];

export function buildBatch(trialRows, sessionRows, eventRows) {
  const batch = {
    batch_id: store.uuid(),
    kind: 'batch',
    trials: block(TRIAL_COLUMNS, trialRows),
    sessions: block(SESSION_COLUMNS, sessionRows),
    queued_at: Date.now()
  };
  if (eventRows && eventRows.length) {
    batch.events = block(EVENT_COLUMNS, eventRows);
  }
  return batch;
}

async function post(batch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': CONTENT_TYPE },
      body: JSON.stringify({ token: TOKEN, ...batch }),
      signal: ctl.signal
    });
    const json = await res.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drains the outbox. Returns { sent, kept, quarantined, config }.
 *
 * Three outcomes per batch, and the distinction matters:
 *
 *   ok                  -> remove from the outbox. A duplicate reply counts as ok:
 *                          the batch already landed, so keeping it would double it.
 *   retryable           -> leave it. Network down, endpoint busy, tokens not yet
 *                          configured. Nothing is lost; the next session tries again.
 *   not retryable       -> QUARANTINE, do not retry and do not silently drop.
 *                          Retrying identical rejected input fails identically, but
 *                          a rejected batch is either an attack on the endpoint or a
 *                          bug in this client, and both need to be visible. Dropping
 *                          it would hide a client bug for weeks.
 */
export async function drain({ onlyIfCollecting = true } = {}) {
  const result = { sent: 0, kept: 0, quarantined: 0, config: null };

  if (onlyIfCollecting && !COLLECTING) {
    const pending = await store.allOutbox();
    result.kept = pending.filter(b => !b.quarantined).length;
    return result;
  }

  const batches = (await store.allOutbox())
    .filter(b => !b.quarantined)
    .sort((a, b) => (a.queued_at || 0) - (b.queued_at || 0));

  for (const batch of batches) {
    let res;
    try {
      res = await post(batch);
    } catch (e) {
      result.kept++;                       // offline or aborted: keep and move on
      continue;
    }

    if (res && res.ok) {
      await store.deleteOutbox(batch.batch_id);
      await cleanupLocal(batch);
      result.sent++;
      if (res.config) result.config = res.config;
    } else if (res && res.retryable) {
      result.kept++;
    } else {
      // Quarantine in place rather than delete. The rows stay readable locally and
      // the reason is recorded next to them.
      batch.quarantined = true;
      batch.quarantine_reason = (res && res.error) || 'rejected';
      batch.quarantined_at = Date.now();
      await store.putOutbox(batch);
      result.quarantined++;
      // A quarantined batch means either a client bug or an attack on the endpoint,
      // and until now it was reported only to the debug pane - which nobody is
      // looking at, least of all from another country. Queue an event so the NEXT
      // batch carries the news into the Sheet, where it can actually be seen.
      await store.queueEvent('batch_quarantined',
        `${batch.batch_id}: ${batch.quarantine_reason}`);
    }
  }
  return result;
}

/**
 * Once a batch is acknowledged, its local trial and session rows are no longer the
 * system of record and can go. Quarantined batches keep theirs.
 */
async function cleanupLocal(batch) {
  try {
    const tUid = TRIAL_COLUMNS.indexOf('trial_uid');
    const sUid = SESSION_COLUMNS.indexOf('session_uid');
    if (tUid >= 0) await store.deleteTrials(batch.trials.rows.map(r => r[tUid]).filter(Boolean));
    if (sUid >= 0) await store.deleteSessions(batch.sessions.rows.map(r => r[sUid]).filter(Boolean));
  } catch (e) { /* leaving local copies is harmless; losing them is not */ }
}

/** Queue a session's data. Does not upload — callers choose when. */
export async function enqueue(trialRows, sessionRows, eventRows) {
  const batch = buildBatch(trialRows, sessionRows, eventRows);
  await store.putOutbox(batch);
  return batch.batch_id;
}

/**
 * Config arrives piggybacked on a successful POST, so a settings change lands on
 * the next session with no extra round trip. This is the same-day path: a
 * non-blocking GET at page load, with a short timeout, that can never delay START.
 */
export async function fetchConfig({ timeoutMs = 3000 } = {}) {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = ENDPOINT + '?action=config&token=' + encodeURIComponent(TOKEN);
    const res = await fetch(url, { signal: ctl.signal });
    const json = await res.json();
    return json && json.ok ? json.config : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The training content. Cached locally so a session still has content offline; the
 * cache is refreshed whenever the network answers.
 *
 * Not gated by COLLECTING. That flag protects the canonical trial tables from
 * placeholder data; it has nothing to do with whether the practice half can run.
 */
export async function fetchTraining({ timeoutMs = 5000 } = {}) {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = ENDPOINT + '?action=training&token=' + encodeURIComponent(TOKEN);
    const res = await fetch(url, { signal: ctl.signal });
    const json = await res.json();
    return json && json.ok ? json.items : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes the schedule back: interval, last tested, exposures, streak. Never the
 * prompt or the answer, which belong to whoever wrote them.
 *
 * Also not gated by COLLECTING, and for the same reason. If this never ran, every
 * item would stay at its starting interval forever and the practice would quietly
 * stop being spaced retrieval at all.
 */
export async function postTrainingProgress(updates) {
  if (!updates || !updates.length || !TOKEN) return { ok: false, skipped: true };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': CONTENT_TYPE },
      body: JSON.stringify({ token: TOKEN, kind: 'training_progress', updates }),
      signal: ctl.signal
    });
    return await res.json();
  } catch (e) {
    return { ok: false, retryable: true, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire every pending batch with sendBeacon, for the moment the page is going away.
 *
 * WHY THIS EXISTS. `drain()` is an async fetch. When the lid closes or the tab is
 * closed, the page can be frozen or torn down with that fetch still in flight, and
 * the request is simply dropped. So the one moment the outbox most needs emptying is
 * the moment the normal path is least likely to finish.
 *
 * `sendBeacon` is the browser API for exactly this: the request is handed to the
 * browser, which is obliged to send it even after the page is gone.
 *
 * THE CATCH, AND WHY IT IS FINE. A beacon cannot be read, so there is no way to know
 * whether it landed, and therefore no way to safely delete the batch. So nothing is
 * deleted: the batch stays in the outbox and is posted again by the next session. The
 * endpoint's `_batches` ledger recognises the repeat and reports it as a duplicate
 * without writing a second copy. Idempotency is what makes an unacknowledged send
 * safe, and this is the case it was built for.
 *
 * Returns the number of batches handed over, which is not the number that arrived.
 */
export async function beaconOutbox() {
  if (!COLLECTING || !TOKEN || typeof navigator === 'undefined' ||
      typeof navigator.sendBeacon !== 'function') return 0;
  let handed = 0;
  try {
    const batches = (await store.allOutbox()).filter(b => !b.quarantined);
    for (const batch of batches) {
      const body = new Blob([JSON.stringify({ token: TOKEN, ...batch })],
        { type: CONTENT_TYPE });
      // Returns false when the payload is over the browser's beacon limit (64 KB in
      // Safari). A refusal is not a failure to handle: the batch is still in the
      // outbox, and the next session posts it normally with no size limit.
      if (navigator.sendBeacon(ENDPOINT, body)) handed++;
    }
  } catch (e) { /* the outbox is intact either way */ }
  return handed;
}

/**
 * The newest session the SERVER knows about.
 *
 * Used once, at boot, to tell an evicted device from a new one. See
 * `recoverFromEviction` in main.js.
 */
export async function fetchLastSession({ timeoutMs = 4000 } = {}) {
  if (!TOKEN) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = ENDPOINT + '?action=last_session&token=' + encodeURIComponent(TOKEN);
    const res = await fetch(url, { signal: ctl.signal });
    const json = await res.json();
    return json && json.ok ? json : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function outboxSummary() {
  const all = await store.allOutbox();
  return {
    pending: all.filter(b => !b.quarantined).length,
    quarantined: all.filter(b => b.quarantined).length
  };
}
