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

const el = id => document.getElementById(id);

let config = Object.assign({}, DEFAULTS);
let trainingItems = [];

async function boot() {
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
    el('screen').innerHTML = `
      <div class="pane">
        <p class="lead">Nothing to do today.</p>
        <p class="sub">Have a lovely day.</p>
      </div>`;
    return;
  }

  el('screen').innerHTML = `
    <div class="pane">
      <p class="lead">Good morning.</p>
      <p class="sub">Some practice — about ten minutes.</p>
      <button id="start" class="big primary">Start</button>
    </div>`;

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

function debugLog(msg) {
  if (!DEBUG) return;
  const box = el('debug');
  if (box) box.textContent = msg + '\n' + box.textContent;
}

boot();
