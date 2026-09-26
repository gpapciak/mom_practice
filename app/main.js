/**
 * Boot. Draws the opening screen, drains the outbox, starts a session on START.
 *
 * Order matters: the outbox drain happens here, before START is pressed, because
 * it is the one place a network call can happen without sitting in the path of a
 * timed task.
 */

import { DEFAULTS, COLLECTING, GEOMETRY_FINAL, NO_STUB_STAGES, APP_VERSION } from './config.js';
import * as store from './store.js';
import * as layout from './layout.js';
import * as upload from './upload.js';
import * as lifecycle from './lifecycle.js';
import { Session } from './session.js';
import { parseItems } from './training.js';
import * as screens from './screens.js';

/** Skipped rows are reported rather than swallowed: the tab is edited by hand. */
function trainingParse(rows) {
  const { items, skipped, warnings } = parseItems(rows);
  if (skipped.length) debugLog(`${skipped.length} training row(s) skipped: `
    + skipped.map(s => s.why).join('; '));
  // A warning means a row is running, but not on the settings somebody intended.
  if (warnings && warnings.length) debugLog(`${warnings.length} training warning(s): `
    + warnings.map(w => `${w.item_id}: ${w.why}`).join('; '));
  return items;
}

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug') === '1';
const SEED = params.get('seed');
/**
 * ?dry=1 runs a full, real session and throws the data away at the end.
 *
 * For rehearsing before the first real row lands, and for checking a change on the
 * actual machine without putting a discontinuity in the series.
 */
const DRY = params.get('dry') === '1';
/**
 * ?screens=1 walks every screen the user will see, for human review.
 *
 * The automated suite cannot judge comprehensibility - Probe A shipped unreadable
 * with 262 checks green - so the answer is not a test but making the human review
 * cheap enough to repeat after every change.
 */
const SCREENS = params.get('screens') === '1';

const el = id => document.getElementById(id);

let config = Object.assign({}, DEFAULTS);
let trainingItems = [];

async function boot() {
  if (SCREENS) {
    const review = await import('./review.js');
    const cached = await store.getMeta('config');
    await review.run(cached || DEFAULTS);
    return;
  }

  // Blocking gate, not advice. If the geometry is claimed final without a measured
  // extent behind it, refuse to collect no matter what the config flags say. Better
  // to record nothing than to record a series whose stimulus sizes changed halfway.
  const geomProblem = layout.geometryProblem(GEOMETRY_FINAL);
  if (geomProblem) {
    console.error('[cognitive-practice] collection blocked: ' + geomProblem);
    if (COLLECTING) {
      document.body.innerHTML =
        '<main id="screen"><div class="pane"><p class="lead">Not ready yet.</p>'
        + '<p class="sub">Setup is incomplete.</p></div></main>';
      return;
    }
  }

  layout.apply();
  window.addEventListener('resize', () => layout.apply());
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => layout.apply());
  }

  if (DEBUG) el('debug').hidden = false;

  // A session interrupted hard enough that its own code never ran again leaves a
  // synchronous localStorage stamp. Reconcile it so the row is not left claiming
  // it never started.
  await reconcileLastAlive();

  // Cached config first, so the screen can be drawn immediately without waiting
  // on the network. A fresh device runs entirely on compiled-in defaults.
  const cached = await store.getMeta('config');
  if (cached) config = Object.assign({}, DEFAULTS, cached);

  // Training content, cache-first so a session can run with no network at all. The
  // cache refreshes whenever the network answers.
  trainingItems = (await store.getMeta('training_items', [])) || [];

  drawOpening();

  // Not awaited: it makes one network call and must never delay START. It only ever
  // matters on a device whose storage has just been wiped, and on that device there
  // is nothing to delay.
  recoverFromEviction().catch(() => {});

  /*
   * Retry the moment connectivity returns.
   *
   * Otherwise the drain happens only at boot, at session end and on hide. A session
   * done during a brief outage would sit in the outbox until the NEXT session, which
   * is the window an eviction has to land in to destroy it. Listening for `online`
   * shrinks that window to about as small as it can be made without polling, and it
   * costs one event listener.
   */
  window.addEventListener('online', () => { upload.drain().catch(() => {}); });

  // Neither of these may block START.
  upload.drain().then(res => {
    if (res.config) {
      config = Object.assign({}, DEFAULTS, res.config);
      store.setMeta('config', res.config);
      drawOpening();
    }
    if (res.quarantined) debugLog(`${res.quarantined} batch(es) quarantined`);
    if (DEBUG) debugLog(`outbox: sent ${res.sent}, kept ${res.kept}`);
  }).catch(() => {});

  upload.fetchTraining().then(items => {
    if (!items) return;
    trainingItems = items;
    store.setMeta('training_items', items);
    if (DEBUG) debugLog(`training content: ${items.length} rows fetched`);
  }).catch(() => {});

  upload.fetchConfig().then(cfg => {
    if (!cfg) return;
    config = Object.assign({}, DEFAULTS, cfg);
    store.setMeta('config', cfg);
    drawOpening();
  }).catch(() => {});

  if (DEBUG) {
    const est = await store.storageEstimate();
    const ob = await upload.outboxSummary();
    if (DRY) debugLog('DRY RUN — nothing will be uploaded or written back');
    debugLog(`${APP_VERSION} | collecting=${COLLECTING}`
             + ` (stages=${NO_STUB_STAGES} geometry=${GEOMETRY_FINAL}) | u=${layout.unit()}px`);
    debugLog(`quota ${est.quota ? Math.round(est.quota / 1048576) + 'MB' : '?'}`
             + ` | outbox ${ob.pending} pending, ${ob.quarantined} quarantined`);
    if (SEED) debugLog('seed override: ' + SEED);
  }
}

/**
 * The opening screen: a greeting, how long it will take, one large button.
 * Nothing else — no question, no summary of yesterday, nothing to read past.
 */
function drawOpening() {
  if (!config.session_active) {
    el('screen').innerHTML = screens.inactiveHtml(config);
    return;
  }
  el('screen').innerHTML = screens.openHtml(config);
  el('start').addEventListener('click', startSession, { once: true });
}

async function startSession() {
  const session = new Session({ config, debug: DEBUG, dry: DRY });
  // Parsed fresh each session so an edit made this morning is picked up today.
  session.trainingItems = trainingParse(trainingItems);
  session.onReset = () => { drawOpening(); };
  await session.prepare();
  try {
    await session.run();
  } finally {
    // Whether it completed or was abandoned, the next thing anyone sees is the
    // ordinary opening screen. No "resume?" prompt: a screen that refers to a
    // previous screen is unusable by someone who cannot carry instructions
    // forward, and a half-finished session is not worth resuming anyway.
    setTimeout(drawOpening, 1500);
  }
}

/**
 * If the previous run left a stamp from a session whose row still says
 * never_started or which has no end time, patch it up. The stamp is the last
 * moment we know the page was alive, so it is the best available ended_at_utc.
 */
async function reconcileLastAlive() {
  const alive = lifecycle.readLastAlive();
  if (!alive || !alive.session_uid) return;
  const row = await store.getSession(alive.session_uid);
  lifecycle.clearAlive();
  if (!row) return;
  if (row.end_reason && row.end_reason !== 'never_started' && row.ended_at_utc) return;

  row.ended_at_utc = alive.at;
  row.last_stage_reached = alive.stage || row.last_stage_reached;
  row.end_reason = row.start_pressed_at_utc ? 'abandoned_closed' : 'never_started';
  row.total_ms = alive.at - row.opened_at_utc;
  await store.putSession(row);

  const trials = await store.trialsForSession(row.session_uid);
  row.n_trials = trials.length;
  await store.putSession(row);
  await upload.enqueue(trials, [row]);
  debugLog(`recovered interrupted session ${row.session_uid.slice(0, 8)}: ${row.end_reason}`);
}

/**
 * Tell an evicted device from a new one, and say so in the record.
 *
 * Storage measured NON-PERSISTENT on the target machine, so Safari may delete every
 * byte this app has written. That is not a hypothetical: Safari's policy deletes all
 * script-writable storage for an origin after seven days without interaction.
 *
 * WHAT EVICTION COSTS, and why silence is the worst part of it:
 *
 *   - an unsent batch is destroyed. There is no recovering that.
 *   - `session_seq` resets to 0, so the practice-effect covariate restarts at 1 and
 *     the series looks like a new participant.
 *   - `days_since_prev_session` is computed from local history, so the first session
 *     after an eviction reports null instead of the real gap.
 *   - the cached config and training content go, and come back on the next network
 *     answer.
 *
 * None of that announces itself. Read from a distance, a destroyed session looks
 * exactly like a session nobody did - which is the one ambiguity this record cannot
 * afford, because whether a day was missed IS the measurement.
 *
 * So: if there is no local history but the server has some, this device was wiped.
 * Log it as an event, and adopt the server's sequence number so the covariate
 * continues instead of restarting. The gap still cannot be recovered, but it stops
 * being invisible - and "the data says storage was wiped on the 14th" is a different
 * conversation from "there is nothing for the 14th".
 */
async function recoverFromEviction() {
  const localSeq = await store.peekSessionSeq();
  if (localSeq > 0) return;                       // ordinary device with its history

  const remote = await upload.fetchLastSession();
  if (!remote || !remote.session_seq) return;     // genuinely a first run, or offline

  /*
   * THE EVENT STATES THE OBSERVATION, NOT A DIAGNOSIS - and the first draft got this
   * wrong by calling it `storage_evicted`.
   *
   * Empty local history with server history present has TWO causes, and only one of
   * them is a loss:
   *
   *   1. storage was evicted. An unsent batch, if there was one, is gone.
   *   2. the app is running in a NEW CONTAINER - added to the Dock as a web app, or
   *      opened in a different browser or profile. Nothing was lost; the old
   *      container still holds whatever it held, including any unsent batch, which
   *      is now stranded rather than destroyed.
   *
   * Cause 2 is the likelier one the first time, because adding the app to the Dock is
   * a deliberate act somebody performs. Reporting it as an eviction would mean the
   * record's first notable event is a data-loss claim about something that did not
   * happen - and worse, it would train whoever reads it to discount the event that
   * does matter later.
   *
   * The recovery is identical either way: adopt the server's sequence so the
   * practice-effect covariate continues instead of restarting at 1.
   */
  await store.setMeta('session_seq', remote.session_seq);
  if (remote.device_id) await store.setMeta('device_id', remote.device_id);
  await store.queueEvent('local_history_missing',
    `no local history, server has session_seq=${remote.session_seq}`
    + ` (last seen ${remote.session_date_local || 'unknown'}).`
    + ' Cause is either a storage eviction or a new container, e.g. added to the Dock.'
    + ' Sequence adopted from the server. If this was an eviction, anything unsent at'
    + ' the time is lost; if it was a new container, it is stranded in the old one.');
  debugLog(`no local history: resumed at session_seq ${remote.session_seq}`);
}

function debugLog(msg) {
  if (!DEBUG) return;
  const box = el('debug');
  if (box) box.textContent = msg + '\n' + box.textContent;
}

boot();
