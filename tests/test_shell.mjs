/**
 * Tests for the session shell, run against stubs of the browser APIs.
 *
 *   node tests/test_shell.mjs
 *
 * No dependencies, no build step, no browser.
 *
 * WHY THIS EXISTS, AND WHY IT IS FIRST
 * ------------------------------------
 * The interruption logic is the part of this app most likely to be wrong in a way
 * nobody notices. A closed lid suspends the machine: timers stop, and on wake a
 * pending timeout simply fires late with no indication that hours passed. If that
 * is mishandled, a session silently reports a five-hour pause as a normal trial,
 * and the damage is invisible in the data.
 *
 * So it is built and tested before the probes, and the case that matters most is
 * section 1: a frozen page must be detected by a wall-clock heartbeat, not by
 * trusting visibility events to fire.
 */

import assert from 'node:assert';

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

/* ------------------------------------------------------------------ stubs */

class Target {
  constructor() { this._h = {}; }
  addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); }
  removeEventListener(t, f) { this._h[t] = (this._h[t] || []).filter(x => x !== f); }
  dispatch(t, ev = {}) { (this._h[t] || []).slice().forEach(f => f(ev)); }
}

function installBrowser({ w = 1424, h = 686, dpr = 2, scale = 1 } = {}) {
  let now = 1790000000000;
  const intervals = [];
  const timeouts = [];
  const storage = new Map();

  const doc = new Target();
  doc.visibilityState = 'visible';
  doc.documentElement = { clientWidth: w, clientHeight: h, style: { _p: {}, setProperty(k, v) { this._p[k] = v; } } };
  doc.nodes = {};
  doc.getElementById = id => (doc.nodes[id] = doc.nodes[id] || { id, hidden: true, textContent: '', innerHTML: '' });

  const win = new Target();
  win.devicePixelRatio = dpr;
  win.visualViewport = Object.assign(new Target(), { scale, width: w, height: h });
  win.screen = { width: 1440, height: 900 };

  global.document = doc;
  global.window = win;
  // navigator is a read-only getter in modern Node, so it needs defineProperty.
  Object.defineProperty(global, 'navigator', {
    value: { userAgent: 'test', storage: undefined }, configurable: true, writable: true
  });
  global.localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };
  global.Date.now = () => now;
  global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  global.clearInterval = () => {};
  global.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; };
  global.clearTimeout = () => {};

  return {
    doc, win, storage,
    advance(ms) { now += ms; },
    now: () => now,
    tick() { intervals.forEach(i => i.fn()); },
    intervals, timeouts
  };
}

/* ============================================================ 1. lifecycle */

section('1. interruption detection — the closed-lid case');
{
  const env = installBrowser();
  const lifecycle = await import('../app/lifecycle.js');

  const events = [];
  const w = lifecycle.watch({
    getState: () => ({ session_uid: 'S1', stage: 'crt_1' }),
    onInterruption: (ms, src) => events.push(['interruption', Math.round(ms), src]),
    onAbandon: (ms, src) => events.push(['abandon', Math.round(ms), src]),
    onHide: () => events.push(['hide'])
  });

  check('heartbeat registered', env.intervals.length === 1);
  check('ticks every second', env.intervals[0].ms === 1000);

  // A normal second passing must not look like an interruption.
  env.advance(1000); env.tick();
  check('a normal tick reports nothing', events.length === 0, JSON.stringify(events));

  // Scheduler jitter must not either.
  env.advance(1800); env.tick();
  check('small jitter reports nothing', events.length === 0, JSON.stringify(events));

  // THE CASE THAT MATTERS: the page was frozen and no visibility event fired.
  env.advance(30000); env.tick();
  check('a 30s freeze is detected with no visibility event',
    events.length === 1 && events[0][0] === 'interruption' && events[0][2] === 'freeze',
    JSON.stringify(events));
  check('freeze duration is right (~29s after the expected tick)',
    Math.abs(events[0][1] - 29000) < 1100, String(events[0] && events[0][1]));

  // A freeze past the threshold must END the session, not resume it.
  events.length = 0;
  env.advance(6 * 60 * 1000); env.tick();
  check('a 6min freeze abandons rather than resumes',
    events.length === 1 && events[0][0] === 'abandon', JSON.stringify(events));

  // Exactly at the boundary counts as abandon (>=).
  events.length = 0;
  env.advance(5 * 60 * 1000 + 1000); env.tick();
  check('the 5min boundary abandons', events[0][0] === 'abandon', JSON.stringify(events));

  check('hidden time accumulates', w.hiddenTotalMs() > 0);
  check('interruption events are counted, not just totalled', w.hiddenEvents() >= 3,
    String(w.hiddenEvents()));
  const taken = w.takeHidden();
  check('takeHidden resets so a gap is attributed once only',
    taken.ms > 0 && taken.n > 0 && w.hiddenTotalMs() === 0 && w.hiddenEvents() === 0,
    JSON.stringify(taken) + ' then ' + w.hiddenTotalMs());

  w.stop();
  events.length = 0;
  env.advance(60000); env.tick();
  check('stop() really stops', events.length === 0, JSON.stringify(events));
}

section('2. interruption detection — tab hidden and restored');
{
  const env = installBrowser();
  const lifecycle = await import('../app/lifecycle.js?v=2');
  const events = [];
  const w = lifecycle.watch({
    getState: () => ({ session_uid: 'S2', stage: 'encoding' }),
    onInterruption: (ms, src) => events.push(['interruption', Math.round(ms), src]),
    onAbandon: (ms, src) => events.push(['abandon', Math.round(ms), src]),
    onHide: () => events.push(['hide'])
  });

  env.doc.visibilityState = 'hidden';
  env.doc.dispatch('visibilitychange');
  check('going hidden triggers a flush/upload attempt',
    events.some(e => e[0] === 'hide'), JSON.stringify(events));

  env.advance(45000);
  env.doc.visibilityState = 'visible';
  env.doc.dispatch('visibilitychange');
  check('returning reports the gap from the visibility path',
    events.some(e => e[0] === 'interruption' && e[2] === 'visibility' && Math.abs(e[1] - 45000) < 50),
    JSON.stringify(events));

  // The same gap must not also be counted by the next heartbeat tick.
  const before = events.filter(e => e[0] === 'interruption').length;
  env.advance(1000); env.tick();
  check('the gap is not double-counted by the heartbeat',
    events.filter(e => e[0] === 'interruption').length === before, JSON.stringify(events));

  env.doc.visibilityState = 'hidden';
  env.doc.dispatch('visibilitychange');
  env.advance(7 * 60 * 1000);
  env.doc.visibilityState = 'visible';
  env.doc.dispatch('visibilitychange');
  check('a long hide abandons', events.some(e => e[0] === 'abandon'), JSON.stringify(events));
  w.stop();
}

section('3. the synchronous last-gasp stamp');
{
  const env = installBrowser();
  const lifecycle = await import('../app/lifecycle.js?v=3');
  const w = lifecycle.watch({
    getState: () => ({ session_uid: 'S3', stage: 'recognition_short' }),
    onInterruption: () => {}, onAbandon: () => {}, onHide: () => {}
  });

  env.advance(1000); env.tick();
  let alive = lifecycle.readLastAlive();
  check('heartbeat stamps session and stage',
    alive && alive.session_uid === 'S3' && alive.stage === 'recognition_short',
    JSON.stringify(alive));

  const at = alive.at;
  env.advance(5000);
  env.win.dispatch('pagehide');
  alive = lifecycle.readLastAlive();
  check('pagehide re-stamps synchronously (the only reliable last act)',
    alive.at === at + 5000, `${alive.at} vs ${at + 5000}`);

  lifecycle.clearAlive();
  check('clearAlive removes it', lifecycle.readLastAlive() === null);

  // Blocked storage must never break a session.
  const broken = { getItem() { throw new Error('blocked'); },
                   setItem() { throw new Error('blocked'); },
                   removeItem() { throw new Error('blocked'); } };
  global.localStorage = broken;
  let threw = false;
  try { lifecycle.stampAlive('S3', 'crt_2'); lifecycle.readLastAlive(); }
  catch (e) { threw = true; }
  check('blocked localStorage does not throw', !threw);
  w.stop();
}

/* ============================================================== 4. layout */

section('4. layout geometry against the real measured viewport');
{
  const env = installBrowser({ w: 1409, h: 686 });   // content box, scrollbar excluded
  const layout = await import('../app/layout.js');

  // 686/0.825 = 831.5, floored to 831. The diagnostic originally REPORTED 832
  // because it rounded; both now floor, so stage_px means one thing.
  const u = layout.unit();
  check('u = 831 on the measured machine (floor of 831.5)', u === 831, String(u));
  check('height-bound, as measured', 686 / 0.825 < 1409 / 1.32);

  const vp = layout.viewport();
  check('viewport uses clientWidth, not innerWidth', vp.w === 1409, String(vp.w));

  const g = layout.apply();
  const props = env.doc.documentElement.style._p;
  check('--u published', props['--u'] === '831px', props['--u']);
  check('recognition image 299px', props['--recImage'] === '299px', props['--recImage']);
  check('CRT offset 324px', props['--crtOffset'] === '324px', props['--crtOffset']);

  // The layout must fit without scrolling at every size, by construction.
  for (const [w, h] of [[1409, 686], [1280, 720], [1024, 640], [1680, 1050], [800, 500]]) {
    const uu = Math.floor(Math.min(w / 1.32, h / 0.825));
    const fitsW = 1.20 * uu <= w;
    const fitsH = 0.75 * uu <= h;
    check(`fits without scrolling at ${w}x${h}`, fitsW && fitsH,
      `u=${uu} needs ${Math.round(1.20 * uu)}x${Math.round(0.75 * uu)}`);
  }

  check('no drift on an empty history', layout.driftFlag(831, []) === 'none');
  check('identical is none', layout.driftFlag(831, [831, 831, 831]) === 'none');
  check('3% is minor', layout.driftFlag(857, [832, 832, 832]) === 'minor',
    layout.driftFlag(857, [832, 832, 832]));
  check('10% is major', layout.driftFlag(915, [832, 832, 832]) === 'major',
    layout.driftFlag(915, [832, 832, 832]));
}

/* ========================================================= 5. column order */

section('5. column contract');
{
  const cols = await import('../app/columns.js');
  // Deliberately NOT an exact count. An exact count encodes no invariant - the
  // schema is append-only, so it grows by design - and it failed three times in a
  // row purely because it had to be hand-edited after each append, never once
  // catching a real problem. A lower bound still catches a truncated or
  // half-regenerated columns.js, which is the failure that would matter.
  check('trial columns look complete', cols.TRIAL_COLUMNS.length >= 66,
    String(cols.TRIAL_COLUMNS.length));
  check('session columns look complete', cols.SESSION_COLUMNS.length >= 36,
    String(cols.SESSION_COLUMNS.length));
  check('the last trial column is not a truncation artefact',
    /^[a-z][a-z0-9_]*$/.test(cols.TRIAL_COLUMNS[cols.TRIAL_COLUMNS.length - 1]),
    cols.TRIAL_COLUMNS[cols.TRIAL_COLUMNS.length - 1]);
  check('trial_uid is first', cols.TRIAL_COLUMNS[0] === 'trial_uid');
  check('no duplicate trial columns',
    new Set(cols.TRIAL_COLUMNS).size === cols.TRIAL_COLUMNS.length);
  check('no duplicate session columns',
    new Set(cols.SESSION_COLUMNS).size === cols.SESSION_COLUMNS.length);
  check('delay_actual_ms present — the actual retention interval',
    cols.TRIAL_COLUMNS.includes('delay_actual_ms'));
  check('decision and travel latency are separate columns',
    cols.TRIAL_COLUMNS.includes('decision_latency_ms') &&
    cols.TRIAL_COLUMNS.includes('travel_latency_ms'));
  check('session table records opens that never started',
    cols.SESSION_COLUMNS.includes('end_reason') &&
    cols.SESSION_COLUMNS.includes('start_pressed_at_utc'));
  check('text columns declared', cols.TEXT_COLUMNS.includes('session_date_local'));
  check('a contaminated interval is distinguishable from a contaminated response',
    cols.TRIAL_COLUMNS.includes('pre_trial_interruption_ms') &&
    cols.TRIAL_COLUMNS.includes('pre_trial_interruption_n') &&
    cols.TRIAL_COLUMNS.includes('hidden_ms'));
  check('training shares the stream without borrowing a probe stage name',
    cols.TRIAL_COLUMNS.includes('training_interval_days') &&
    cols.TRIAL_COLUMNS.includes('training_is_retest'));
  check('the three-way self-report has its own column, separate from correct',
    cols.TRIAL_COLUMNS.includes('training_recall') &&
    cols.TRIAL_COLUMNS.includes('training_reveal_latency_ms') &&
    cols.TRIAL_COLUMNS.includes('training_max_interval_days'));
}

/* ============================================================ 6. localDate */

section('6. the local day boundary is fixed, not the device guess');
{
  installBrowser();
  const { localDateFor, localTimeFor } = await import('../app/session.js');

  // 2026-09-24 06:30 UTC is still the 23rd in Los Angeles.
  const ms = Date.UTC(2026, 8, 24, 6, 30, 0);
  check('a late-evening session lands on the local day',
    localDateFor(ms) === '2026-09-23', localDateFor(ms));
  check('local time of day is local', localTimeFor(ms) === '23:30', localTimeFor(ms));

  // And just after local midnight it rolls over.
  const ms2 = Date.UTC(2026, 8, 24, 7, 30, 0);
  check('rolls over at local midnight', localDateFor(ms2) === '2026-09-24', localDateFor(ms2));

  // A January date must use standard time, not a hardcoded offset.
  const ms3 = Date.UTC(2027, 0, 15, 7, 30, 0);
  check('handles the DST transition', localDateFor(ms3) === '2027-01-14', localDateFor(ms3));
}

/* ================================== 7. the stale-stimulus window */

section('7. nothing stale can be answered');
{
  const env = installBrowser();
  const lifecycle = await import('../app/lifecycle.js?v=7');

  const suspends = [];
  const w = lifecycle.watch({
    getState: () => ({ session_uid: 'S7', stage: 'crt_1' }),
    onInterruption: () => {}, onAbandon: () => {},
    onSuspend: src => suspends.push(src),
    onHide: () => {}
  });

  check('not stale while the heartbeat is current', lifecycle.isStale() === false);

  // A bare freeze: no visibility event at all, which is the lid case.
  env.advance(20000);
  check('isStale() is true after a clock jump, with no event fired',
    lifecycle.isStale() === true);
  check('no suspend has fired yet — this is exactly the unguarded window',
    suspends.length === 0, JSON.stringify(suspends));

  // The heartbeat catches up and veils BEFORE classifying.
  env.tick();
  check('the freeze raises a suspend', suspends.includes('freeze'), JSON.stringify(suspends));
  check('and the heartbeat clears staleness', lifecycle.isStale() === false);

  // Going hidden veils immediately, so the veil is already up on return.
  suspends.length = 0;
  env.doc.visibilityState = 'hidden';
  env.doc.dispatch('visibilitychange');
  check('going hidden raises a suspend before any freeze',
    suspends.includes('hidden'), JSON.stringify(suspends));

  suspends.length = 0;
  env.win.dispatch('pagehide');
  check('pagehide raises a suspend too', suspends.includes('pagehide'));
  w.stop();
}

/* ============================ 8. interruption attribution (the caught bug) */

section('8. a contaminated interval is not a contaminated response');
{
  const env = installBrowser();
  const { Session } = await import('../app/session.js?v=8');

  const s1 = new Session({ config: { audio_enabled: false }, debug: false });
  s1.deviceId = 'dev';
  s1.seq = 1;
  s1.seed = 'seed';
  s1.daysSincePrev = null;
  s1.startedAt = Date.now();
  s1.stage = 'recognition_short';

  // A 4-minute lid closure DURING a retention interval. Under the 5-minute
  // threshold, so the session resumes — and a nominal 2-minute delay is now a real
  // 6-minute one.
  s1.trialOpen = false;
  s1.onInterruption(4 * 60 * 1000, 'freeze');

  const pre = s1.beginTrial();
  check('the interval interruption is carried to the trial that follows it',
    pre.preMs === 240000 && pre.preN === 1, JSON.stringify(pre));

  const row = s1.addTrial({ probe_id: 'B_recognition', probe_version: 1, correct: 1,
                            outcome_flag: 'ok', delay_arm: 'A_short' });
  check('it lands in pre_trial_interruption_ms',
    row.pre_trial_interruption_ms === 240000, String(row.pre_trial_interruption_ms));
  check('with its event count', row.pre_trial_interruption_n === 1);
  check('hidden_ms stays 0 — the RESPONSE was not interrupted',
    row.hidden_ms === 0, String(row.hidden_ms));
  check('THE BUG: a good response is NOT flagged aborted just because the delay was interrupted',
    row.outcome_flag === 'ok', row.outcome_flag);

  // And the reverse: an interruption during the trial itself.
  const s2 = new Session({ config: { audio_enabled: false }, debug: false });
  s2.deviceId = 'dev'; s2.seq = 1; s2.seed = 'seed'; s2.daysSincePrev = null;
  s2.startedAt = Date.now(); s2.stage = 'crt_1';
  s2.beginTrial();
  s2.onInterruption(30000, 'freeze');        // trialOpen is true now
  const row2 = s2.addTrial({ probe_id: 'A_crt', probe_version: 1, outcome_flag: 'ok' });
  check('an interruption during the trial lands in hidden_ms',
    row2.hidden_ms === 30000, String(row2.hidden_ms));
  check('leaving the interval figure at 0',
    row2.pre_trial_interruption_ms === 0, String(row2.pre_trial_interruption_ms));

  // hidden_ms and outcome_flag are ORTHOGONAL. Timing validity must not overwrite
  // response quality: a wrong-side click during an interrupted trial still has a
  // meaningful accuracy, and clobbering 'error' with 'aborted' to record a timing
  // problem would throw that away.
  check('an interruption does NOT overwrite the probe response flag',
    row2.outcome_flag === 'ok', row2.outcome_flag);

  const s3 = new Session({ config: { audio_enabled: false }, debug: false });
  s3.deviceId = 'dev'; s3.seq = 1; s3.seed = 'seed'; s3.daysSincePrev = null;
  s3.startedAt = Date.now(); s3.stage = 'crt_1';
  s3.beginTrial();
  s3.onInterruption(30000, 'freeze');
  const row4 = s3.addTrial({ probe_id: 'A_crt', probe_version: 1 });   // no flag
  check('a trial that never produced a response IS flagged aborted',
    row4.outcome_flag === 'aborted', String(row4.outcome_flag));

  const s4 = new Session({ config: { audio_enabled: false }, debug: false });
  s4.deviceId = 'dev'; s4.seq = 1; s4.seed = 'seed'; s4.daysSincePrev = null;
  s4.startedAt = Date.now(); s4.stage = 'crt_1';
  s4.beginTrial();
  s4.onInterruption(30000, 'freeze');
  const row5 = s4.addTrial({ probe_id: 'A_crt', probe_version: 1, outcome_flag: 'error' });
  check('an error during an interrupted trial keeps its accuracy meaning',
    row5.outcome_flag === 'error' && row5.hidden_ms === 30000,
    row5.outcome_flag + ' / ' + row5.hidden_ms);

  // Accumulators must not leak between trials.
  const row3 = s2.addTrial({ probe_id: 'A_crt', probe_version: 1, outcome_flag: 'ok' });
  check('accumulators reset, so one gap is counted once',
    row3.hidden_ms === 0 && row3.pre_trial_interruption_ms === 0,
    JSON.stringify([row3.hidden_ms, row3.pre_trial_interruption_ms]));
}

/* ============================================ 9. the collection gate */

section('9. collection cannot start before the geometry is final');
{
  installBrowser();
  const cfg = await import('../app/config.js?v=9');
  const lay = await import('../app/layout.js?v=9');

  check('COLLECTING is derived, not a standalone switch',
    cfg.COLLECTING === (cfg.NO_STUB_STAGES && cfg.GEOMETRY_FINAL),
    `${cfg.COLLECTING} vs ${cfg.NO_STUB_STAGES} && ${cfg.GEOMETRY_FINAL}`);

  check('claiming final geometry without a measured extent is refused',
    lay.geometryProblem(true, null) !== null, String(lay.geometryProblem(true, null)));
  check('and is accepted once an extent is recorded',
    lay.geometryProblem(true, 0.55) === null, String(lay.geometryProblem(true, 0.55)));
  check('not-final needs nothing', lay.geometryProblem(false) === null);

  // The invariant that matters: flipping one flag is not enough.
  const would = (stages, geom, extent) =>
    stages && geom && lay.geometryProblem(geom, extent) === null;
  check('flipping NO_STUB_STAGES alone would not enable collection', would(true, false, null) === false);
  check('flipping GEOMETRY_FINAL alone would not enable collection', would(false, true, 0.55) === false);
  check('both, plus a measured extent, does', would(true, true, 0.55) === true);
  check('and GEOMETRY_FINAL with no extent behind it is still refused',
    lay.geometryProblem(true, null) !== null);
}

/* =========================================== 10. Probe A frozen parameters */

section('10. Probe A - the frozen parameters');
{
  installBrowser();
  const crt = await import('../app/probe_crt.js');

  check('24 trials per block', crt.TRIALS_PER_BLOCK === 24);
  check('12 per side', crt.SIDES_PER_BLOCK === 12);
  check('8 px movement-onset threshold', crt.MOVE_THRESHOLD_PX === 8);
  check('anticipation under 150 ms', crt.ANTICIPATION_MS === 150);
  check('5 s response timeout', crt.RESPONSE_TIMEOUT_MS === 5000);
  check('16 foreperiods, 1000-2500 in 100 ms steps',
    crt.FOREPERIODS.length === 16 &&
    crt.FOREPERIODS[0] === 1000 &&
    crt.FOREPERIODS[15] === 2500 &&
    crt.FOREPERIODS.every((v, i) => i === 0 || v - crt.FOREPERIODS[i - 1] === 100));
  check('probe_version starts at 1', crt.PROBE_VERSION === 1);
}

section('11. Probe A - block construction');
{
  installBrowser();
  const crt = await import('../app/probe_crt.js?v=11');

  const b = crt.makeBlock('s1-abcdef12:crt_1');
  check('exactly 24 trials', b.length === 24, String(b.length));
  const l = b.filter(t => t.side === 'left').length;
  const r = b.filter(t => t.side === 'right').length;
  check('sides balanced 12/12 structurally, not by chance', l === 12 && r === 12, `${l}/${r}`);
  check('every foreperiod is from the frozen list',
    b.every(t => crt.FOREPERIODS.includes(t.foreperiod_ms)));

  // 24 trials from 16 values cannot balance exactly; the rule guarantees every
  // value appears at least once and never more than twice.
  const counts = {};
  b.forEach(t => { counts[t.foreperiod_ms] = (counts[t.foreperiod_ms] || 0) + 1; });
  check('every foreperiod appears at least once',
    crt.FOREPERIODS.every(v => counts[v] >= 1),
    JSON.stringify(crt.FOREPERIODS.filter(v => !counts[v])));
  check('and none more than twice',
    Object.values(counts).every(n => n <= 2), JSON.stringify(counts));

  // Reconstructability: rng_seed on the rows must regenerate the exact sequence.
  const again = crt.makeBlock('s1-abcdef12:crt_1');
  check('the same seed rebuilds the identical sequence',
    JSON.stringify(again) === JSON.stringify(b));
  const other = crt.makeBlock('s1-abcdef12:crt_2');
  check('a different seed gives a different sequence',
    JSON.stringify(other) !== JSON.stringify(b));

  // The blocks must be identical in PARAMETERS, differing only in order - that is
  // what makes crt_2 minus crt_1 a fatigue measure rather than a design artifact.
  check('both blocks have the same shape',
    other.length === b.length &&
    other.filter(t => t.side === 'left').length === 12);
}

section('12. Probe A - response classification');
{
  installBrowser();
  const crt = await import('../app/probe_crt.js?v=12');
  const C = o => crt.classify(o);

  check('a correct click is ok',
    C({ clicked: 'left', expected: 'left', responseMs: 600, beforeOnset: false })
      .outcome_flag === 'ok');
  check('and scores correct',
    C({ clicked: 'left', expected: 'left', responseMs: 600, beforeOnset: false }).correct === 1);
  check('the wrong side is an error, not a discard',
    C({ clicked: 'right', expected: 'left', responseMs: 600, beforeOnset: false })
      .outcome_flag === 'error');
  check('no response is an omission with correct = null, not 0',
    (() => { const c = C({ clicked: null, expected: 'left', responseMs: null, beforeOnset: false });
             return c.outcome_flag === 'omission' && c.correct === null; })());
  check('a click before onset is an anticipation',
    C({ clicked: 'left', expected: 'left', responseMs: null, beforeOnset: true })
      .outcome_flag === 'anticipation');
  check('149 ms is an anticipation, not a very fast decision',
    C({ clicked: 'left', expected: 'left', responseMs: 149, beforeOnset: false })
      .outcome_flag === 'anticipation');
  check('150 ms is a response',
    C({ clicked: 'left', expected: 'left', responseMs: 150, beforeOnset: false })
      .outcome_flag === 'ok');
}

section('13. Probe A - the decision/travel split');
{
  installBrowser();
  const crt = await import('../app/probe_crt.js?v=13');
  const start = { x: 500, y: 300 };

  // Stationary for 250 ms, then moves and clicks at 700 ms. The 8 px threshold is
  // crossed by the sample at 260 ms.
  const samples = [
    { t: 1000 + 12, x: 501, y: 300 },   // jitter, under threshold
    { t: 1000 + 24, x: 503, y: 300 },   // still under
    { t: 1000 + 260, x: 520, y: 300 },  // 20 px: movement onset
    { t: 1000 + 400, x: 700, y: 300 },
    { t: 1000 + 690, x: 824, y: 300 }
  ];
  const mv = crt.analyseMovement(samples, start, 1000, 1700);
  check('decision time runs to movement onset, not to the first jitter',
    mv.decision_latency_ms === 260, String(mv.decision_latency_ms));
  check('travel time runs from movement onset to the click',
    mv.travel_latency_ms === 440, String(mv.travel_latency_ms));
  check('the two sum to the total response time',
    mv.decision_latency_ms + mv.travel_latency_ms === 700);
  check('samples are counted', mv.n_mousemove_samples === 5);
  check('path length is summed along the trace, not straight-line',
    mv.travel_path_px === 324, String(mv.travel_path_px));

  // Sub-threshold jitter must never register as a movement. This is the tremor case
  // that justifies keeping the threshold at 8 px.
  const tremor = [
    { t: 1010, x: 503, y: 301 }, { t: 1022, x: 497, y: 299 },
    { t: 1034, x: 502, y: 302 }, { t: 1046, x: 498, y: 298 }
  ];
  const mvT = crt.analyseMovement(tremor, start, 1000, 1500);
  check('tremor under 8 px does not count as movement onset',
    mvT.decision_latency_ms === null, String(mvT.decision_latency_ms));
  check('but the path is still recorded', mvT.travel_path_px > 0);

  // A click with no movement at all: nulls, never a fabricated zero.
  const none = crt.analyseMovement([], start, 1000, 1400);
  check('no samples gives nulls, not zeros',
    none.decision_latency_ms === null && none.travel_latency_ms === null
    && none.travel_path_px === null);
  check('and records that there were none', none.n_mousemove_samples === 0);
}

section('14. Probe A - timestamp base');
{
  installBrowser();
  const crt = await import('../app/probe_crt.js?v=14');
  global.performance = { now: () => 5000, timeOrigin: 1790000000000 };

  check('a high-res timestamp passes through',
    crt.eventTime({ timeStamp: 1234.5 }) === 1234.5);
  check('a Unix-epoch timestamp is converted, not used raw',
    crt.eventTime({ timeStamp: 1790000001234 }) === 1234,
    String(crt.eventTime({ timeStamp: 1790000001234 })));
  check('a missing timestamp falls back to the clock',
    crt.eventTime({ timeStamp: 0 }) === 5000);
}

/* ============================================ 15. training: the schedule */

section('15. training - expanding intervals');
{
  installBrowser();
  const tr = await import('../app/training.js');

  const R = tr.RECALL;
  const step = (days, recall, opts) => tr.nextInterval(days, recall, opts).interval_days;

  check('steps are the standard expanding schedule',
    JSON.stringify(tr.STEPS) === JSON.stringify([1, 2, 4, 7, 14, 30, 60]));
  check('a clean success steps up', step(2, R.GOT) === 4, String(step(2, R.GOT)));

  // THE BRAKE THAT MATTERS: partial recall holds. Collapsing 'partly' into 'got it'
  // is what pushes intervals up fastest, and over-reporting is the expected failure
  // mode when awareness of deficit may itself be affected.
  check('PARTLY holds the interval rather than extending it',
    step(4, R.PARTLY) === 4, String(step(4, R.PARTLY)));
  check('partly is not treated as a miss either',
    step(4, R.PARTLY) > step(4, R.MISSED), `${step(4, R.PARTLY)} vs ${step(4, R.MISSED)}`);

  check('a miss drops two steps, not to the start',
    step(14, R.MISSED) === 4, String(step(14, R.MISSED)));
  check('and never below the first step',
    step(1, R.MISSED) === 1 && step(2, R.MISSED) === 1);
  check('an omission is scheduled like a miss, since no retrieval happened',
    step(14, R.OMITTED) === step(14, R.MISSED));

  // The streak gate: one optimistic report cannot carry an item far.
  check('beyond a week, a single success does NOT advance',
    step(7, R.GOT, { streak: 0 }) === 7, String(step(7, R.GOT, { streak: 0 })));
  check('two consecutive successes do',
    step(7, R.GOT, { streak: 1 }) === 14, String(step(7, R.GOT, { streak: 1 })));
  check('below the gate one success is enough',
    step(4, R.GOT, { streak: 0 }) === 7);
  check('a partial resets the streak',
    tr.nextInterval(4, R.PARTLY, { streak: 3 }).streak === 0);
  check('a success builds it',
    tr.nextInterval(4, R.GOT, { streak: 1 }).streak === 2);

  // The ceiling, and the volatile-content case that motivates it.
  check('the default ceiling is well below the top step',
    tr.DEFAULT_MAX_INTERVAL_DAYS === 21);
  check('growth stops at the ceiling',
    step(14, R.GOT, { streak: 5 }) === 21, String(step(14, R.GOT, { streak: 5 })));
  check('a volatile item is capped where the human said',
    step(2, R.GOT, { streak: 5, maxDays: 2 }) === 2,
    String(step(2, R.GOT, { streak: 5, maxDays: 2 })));
  check('a stable item may be allowed higher than the default',
    step(21, R.GOT, { streak: 5, maxDays: 60 }) === 30,
    String(step(21, R.GOT, { streak: 5, maxDays: 60 })));

  // The tab is edited by hand: a typo must not drop an item out of rotation.
  check('an off-schedule interval snaps down to a real step',
    step(5, R.GOT, { streak: 5 }) === 7, String(step(5, R.GOT, { streak: 5 })));
  check('an absurd interval still yields a real, capped step',
    step(999, R.MISSED) <= 21 && step(999, R.MISSED) > 0, String(step(999, R.MISSED)));
}

section('16. training - selection is due-based and slot-capped');
{
  installBrowser();
  const tr = await import('../app/training.js?v=16');
  const DAY = 86400000;
  const now = 1790000000000;

  const items = [
    { item_id: 't:volatile', prompt: 'p', answer: 'a', interval_days: 14, max_interval_days: 1,
      last_tested_ms: now - 2 * DAY },
    { item_id: 't:a', prompt: 'p', answer: 'a', interval_days: 1, last_tested_ms: now - 3 * DAY },
    { item_id: 't:b', prompt: 'p', answer: 'a', interval_days: 1, last_tested_ms: now - 2 * DAY },
    { item_id: 't:c', prompt: 'p', answer: 'a', interval_days: 7, last_tested_ms: now - 1 * DAY },
    { item_id: 't:new', prompt: 'p', answer: 'a', interval_days: 1, last_tested_ms: null },
    { item_id: 't:off', prompt: 'p', answer: 'a', interval_days: 1, last_tested_ms: null, active: false }
  ];

  const due = tr.selectDue(items, now, 10, 'seed');
  const ids = due.map(i => i.item_id);
  check('an item not yet due is left alone', !ids.includes('t:c'), ids.join(','));
  check('a parked item never appears', !ids.includes('t:off'), ids.join(','));
  check('a brand new item is introduced immediately', ids.includes('t:new'), ids.join(','));
  check('the most overdue leads', ids[0] === 't:new' || ids[0] === 't:a', ids.join(','));
  // A volatile item whose stored interval drifted above its ceiling must still come
  // due on its ceiling, not on the stale number.
  check('a per-item ceiling governs when an item is due, not the stored interval',
    ids.includes('t:volatile'), ids.join(','));

  // Training expands to fill its slots and never beyond them: a longer session
  // would change what the reaction-time bracket is measuring.
  const capped = tr.selectDue(items, now, 2, 'seed');
  check('the cap is the slot budget, not the backlog', capped.length === 2, String(capped.length));

  const many = Array.from({ length: 50 }, (_, i) =>
    ({ item_id: 't:x' + i, prompt: 'p', answer: 'a', interval_days: 1, last_tested_ms: null }));
  check('a 50-item backlog still yields only the cap',
    tr.selectDue(many, now, 12, 'seed').length === 12);

  check('the same seed selects the same items',
    JSON.stringify(tr.selectDue(many, now, 12, 'seed').map(i => i.item_id)) ===
    JSON.stringify(tr.selectDue(many, now, 12, 'seed').map(i => i.item_id)));
}

section('17. training - the errorless re-ask');
{
  installBrowser();
  const tr = await import('../app/training.js?v=17');
  const q = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => ({ item: { item_id: 't:' + x }, isRetest: false }));

  const after = tr.insertRetest(q, 0, q[0]);
  check('a missed item comes back later in the same session', after.length === 7);
  check('far enough to be a retrieval, not an echo',
    after[tr.RETEST_GAP].item.item_id === 't:a', after.map(e => e.item.item_id).join(','));
  check('and is flagged as a re-ask, since it is not an independent observation',
    after[tr.RETEST_GAP].isRetest === true);

  // A miss near the end still gets re-asked, at the end, so the session ends right.
  const late = tr.insertRetest(q, 5, q[5]);
  check('a miss near the end is still re-asked', late.length === 7);
  check('at the end rather than past it',
    late[late.length - 1].item.item_id === 't:f' && late[late.length - 1].isRetest === true);
}

section('18. training and probe content can never overlap');
{
  installBrowser();
  const tr = await import('../app/training.js?v=18');

  check('a namespaced id is accepted', tr.assertTrainingId('t:house_today') === 't:house_today');

  // A pool item id reaching the training path would make a measure of new learning
  // into a measure of how well the training worked.
  let threw = false;
  try { tr.assertTrainingId('boss_00412'); } catch (e) { threw = true; }
  check('a pool-style id is refused outright', threw);

  threw = false;
  try { tr.assertTrainingId(null); } catch (e) { threw = true; }
  check('so is a missing id', threw);

  const parsed = tr.parseItems([
    { item_id: 't:ok', prompt: 'Who is here?', answer: 'Anna.', interval_days: 2 },
    { item_id: 'not_namespaced', prompt: 'p', answer: 'a' },
    { item_id: 't:noprompt', prompt: '', answer: 'a' },
    { item_id: 't:noanswer', prompt: 'p', answer: '' },
    { item_id: '', prompt: 'p', answer: 'a' }
  ]);
  check('only the well-formed, namespaced row survives',
    parsed.items.length === 1 && parsed.items[0].item_id === 't:ok',
    JSON.stringify(parsed.items.map(i => i.item_id)));
  check('a non-namespaced row is skipped, not silently accepted',
    parsed.skipped.some(sk => sk.why.includes('t:')));
  check('and every skip carries a reason a human can act on',
    parsed.skipped.length === 4 && parsed.skipped.every(sk => sk.why));

  // Tolerance: the tab is edited at speed, and a session that refuses to run is
  // worse than one with fewer items.
  check('a malformed tab yields a shorter session, not a broken one',
    tr.parseItems([{ item_id: 't:a', prompt: 'p', answer: 'a' }]).items.length === 1);
  check('an empty tab is survivable', tr.parseItems([]).items.length === 0);
  check('so is a missing tab', tr.parseItems(null).items.length === 0);
}

/* ================================ 19. the runtime extent assertion */

section('19. a screen that overflows is caught, not trusted not to');
{
  installBrowser({ w: 1409, h: 686 });
  const layout = await import('../app/layout.js?v=19');
  const u = 831;

  check('the budget is the documented fraction', layout.CONTENT_BUDGET_U === 0.75);

  // scrollHeight, not clientHeight. clientHeight is what fits; scrollHeight is what
  // is actually there, and the difference is exactly the part that would be cut off
  // with nothing to say so.
  const comfortable = { scrollHeight: Math.round(0.46 * u) };   // the CRT screen
  let m = layout.measureScreen(comfortable, u);
  check('a comfortable screen fits', m.fits === true, JSON.stringify(m));
  check('and its extent is reported in units of u',
    Math.abs(m.extentU - 0.46) < 0.002, String(m.extentU));

  const exact = { scrollHeight: Math.round(0.75 * u) };
  check('a screen exactly at budget fits', layout.measureScreen(exact, u).fits === true);

  // THE ADVERSARIAL CASE: plant a screen that does not fit, confirm it is caught.
  const overflowing = { scrollHeight: Math.round(0.92 * u) };
  m = layout.measureScreen(overflowing, u);
  check('a planted oversized screen is CAUGHT', m.fits === false, JSON.stringify(m));
  check('and the overflow is quantified, not merely flagged',
    m.overflowPx > 100 && m.overflowPx < 200, String(m.overflowPx));

  // Near-misses are the ones that would otherwise be waved through.
  const barely = { scrollHeight: Math.round(0.75 * u) + 3 };
  check('even a 3px overflow fails', layout.measureScreen(barely, u).fits === false,
    JSON.stringify(layout.measureScreen(barely, u)));

  check('a missing node is not an overflow', layout.measureScreen(null, u).fits === true);

  // The gate this feeds: geometry may only be declared final with a real number.
  check('the extent gate still refuses an unbacked claim',
    layout.geometryProblem(true, null) !== null,
    String(layout.geometryProblem(true, null)));
  check('and accepts a measured one', layout.geometryProblem(true, 0.60) === null);
  check('but refuses a measurement that leaves no margin',
    layout.geometryProblem(true, 0.90) !== null,
    String(layout.geometryProblem(true, 0.90)));
}


/* ======================================= 20. the frozen session skeleton */

section('20. the skeleton: probe positions and session length do not move');
{
  installBrowser();
  const S = await import('../app/session.js?v=20');
  const train = await import('../app/probe_training.js?v=20');

  const sk = S.SKELETON;

  // THE ASSERTION THIS FILE EXISTS FOR. crt_1 and crt_2 must sit at the same
  // elapsed time in both phases, because crt_2 - crt_1 is the fatigue measure and
  // it means nothing if the blocks move or the session changes length.
  const cum = phase => {
    let t = 0;
    const at = {};
    for (const sl of sk) {
      const stage = sl[phase];
      if (stage === 'crt_1' || stage === 'crt_2') at[stage] = t;
      t += sl.ms || 0;
    }
    return { at, total: t };
  };
  const p1 = cum('phase1');
  const p2 = cum('phase2');

  check('crt_1 sits at the same elapsed time in both phases',
    p1.at.crt_1 === p2.at.crt_1, `${p1.at.crt_1} vs ${p2.at.crt_1}`);
  check('crt_2 sits at the same elapsed time in both phases',
    p1.at.crt_2 === p2.at.crt_2, `${p1.at.crt_2} vs ${p2.at.crt_2}`);
  check('the session is the same length in both phases',
    p1.total === p2.total, `${p1.total} vs ${p2.total}`);
  check('and the gap the fatigue measure spans is identical',
    (p1.at.crt_2 - p1.at.crt_1) === (p2.at.crt_2 - p2.at.crt_1));

  // Only the OCCUPANT of a slot may differ between phases.
  check('every slot keeps its duration across phases',
    sk.every(sl => typeof sl.ms === 'number' || sl.ms === null));
  check('the blocks occupy the same slots in both phases',
    sk.filter(sl => sl.phase1.startsWith('crt')).map(sl => sl.slot).join() ===
    sk.filter(sl => sl.phase2.startsWith('crt')).map(sl => sl.slot).join());

  // The invariant that keeps Probe B's series free of training data.
  const probeStages = ['opening_recognition', 'encoding', 'recognition_short',
                       'recognition_medium'];
  check('no training stage ever borrows a probe stage name',
    sk.every(sl => !(sl.phase1.startsWith('training') && probeStages.includes(sl.phase1))),
    sk.map(sl => sl.phase1).join());
  check('every slot occupant is a declared stage name',
    sk.every(sl => S.STAGES.includes(sl.phase1) && S.STAGES.includes(sl.phase2)),
    sk.map(sl => `${sl.phase1}/${sl.phase2}`).join(' '));

  // Phase 1 fills the probe slots with training; phase 2 moves it to the fillers.
  check('phase 1 puts training in the Probe B and C slots',
    S.trainingBudgetMs('phase1') === 310000, String(S.trainingBudgetMs('phase1')));
  check('phase 2 moves training into the filler slots',
    S.trainingBudgetMs('phase2') === 165000, String(S.trainingBudgetMs('phase2')));
  check('so the training dose drops when the probes arrive, as expected',
    S.trainingBudgetMs('phase2') < S.trainingBudgetMs('phase1'));

  // Training fills its slots and never overruns them.
  // Derived from the module's own per-item budget rather than hardcoded: an exact
  // number here would just need editing every time the screen timings change, which
  // is the same brittleness as an exact column count.
  const expect1 = Math.floor(S.trainingBudgetMs('phase1') / train.MS_PER_ITEM);
  const expect2 = Math.floor(S.trainingBudgetMs('phase2') / train.MS_PER_ITEM);
  check('capacity is derived from the slot budget',
    train.capacityFor(S.trainingBudgetMs('phase1')) === expect1, String(expect1));
  check('and from the smaller phase-2 budget',
    train.capacityFor(S.trainingBudgetMs('phase2')) === expect2, String(expect2));
  check('per-item budget allows for the reveal gate plus a considered answer',
    train.MS_PER_ITEM >= 20000, String(train.MS_PER_ITEM));
  check('a slot too short for one item yields none, not a partial item',
    train.capacityFor(train.MS_PER_ITEM - 1) === 0);
}

section('21. geometry is final, and backed by a number');
{
  installBrowser({ w: 1409, h: 686 });
  const cfg = await import('../app/config.js?v=21');
  const lay = await import('../app/layout.js?v=21');

  check('a measured extent is recorded', typeof lay.MEASURED_CONTENT_EXTENT_U === 'number',
    String(lay.MEASURED_CONTENT_EXTENT_U));
  check('and it leaves margin inside the budget',
    lay.MEASURED_CONTENT_EXTENT_U < lay.CONTENT_BUDGET_U,
    `${lay.MEASURED_CONTENT_EXTENT_U} vs ${lay.CONTENT_BUDGET_U}`);
  check('so the geometry gate is satisfied',
    lay.geometryProblem(cfg.GEOMETRY_FINAL) === null,
    String(lay.geometryProblem(cfg.GEOMETRY_FINAL)));
  check('COLLECTING is still derived from both flags',
    cfg.COLLECTING === (cfg.NO_STUB_STAGES && cfg.GEOMETRY_FINAL));

  // The tallest screen that will ever run must still fit.
  const u = lay.unit();
  const tallest = { scrollHeight: Math.round(lay.MEASURED_CONTENT_EXTENT_U * u) };
  check('the tallest anticipated screen fits at the measured viewport',
    lay.measureScreen(tallest, u).fits === true,
    JSON.stringify(lay.measureScreen(tallest, u)));
}


/* ============================ 22. blank cells, and the types Sheets returns */

section('22. what a blank cell means, and the boolean Sheets really sends');
{
  installBrowser();
  const tr = await import('../app/training.js?v=22');

  /* ---- active ---- */

  // BLANK MEANS ACTIVE. Requiring TRUE to opt in would mean a newly typed row
  // silently never runs, which is the worse failure for a hand-edited tab.
  check('a blank active cell means ACTIVE', tr.isActive('') === true);
  check('whitespace also means active', tr.isActive('  ') === true);
  check('an absent column means active', tr.isActive(undefined) === true);
  check('null means active', tr.isActive(null) === true);

  // THE BUG THIS SECTION EXISTS FOR. Sheets returns a FALSE cell as a JSON boolean,
  // not the string 'FALSE'. The previous parser did String(v || 'TRUE'), which turned
  // boolean false into 'TRUE' and presented a deliberately parked row.
  check('boolean false parks the row', tr.isActive(false) === false);
  check('boolean true keeps it active', tr.isActive(true) === true);
  check('the string FALSE parks it too', tr.isActive('FALSE') === false);
  check('and is case-insensitive', tr.isActive('false') === false);
  check('a few plain-English spellings park it',
    tr.isActive('no') === false && tr.isActive('N') === false
    && tr.isActive('off') === false && tr.isActive(0) === false);
  check('anything else is active', tr.isActive('yes') === true && tr.isActive(1) === true);

  /* ---- max_interval_days ---- */

  // BLANK IS NOT ZERO.
  check('a blank ceiling means "not set", so the default applies',
    tr.capFor('') === tr.DEFAULT_MAX_INTERVAL_DAYS, String(tr.capFor('')));
  check('a whitespace-only cell behaves the same', tr.capFor(' ') === 21, String(tr.capFor(' ')));
  check('an absent column behaves the same', tr.capFor(undefined) === 21);
  check('null behaves the same', tr.capFor(null) === 21);
  check('a blank ceiling is emphatically NOT read as 0',
    tr.capFor('') !== 0 && tr.capFor('') > 1);

  check('a typed ceiling is used as given',
    tr.capFor(1) === 1 && tr.capFor(2) === 2 && tr.capFor(7) === 7);
  check('a string number works, since Sheets may send either',
    tr.capFor('2') === 2);

  // An explicit 0 is asymmetric with blank, deliberately: somebody typed it, and the
  // only sensible reading is "as often as possible". Falling back to 21 there would
  // be the dangerous direction for exactly the volatile content this column exists
  // to protect.
  check('an explicit 0 clamps to the shortest step, not to the default',
    tr.capFor(0) === tr.STEPS[0], String(tr.capFor(0)));
  check('a negative does the same', tr.capFor(-3) === 1);
  check('so 0 and blank are NOT the same thing',
    tr.capFor(0) !== tr.capFor(''), `${tr.capFor(0)} vs ${tr.capFor('')}`);

  check('an unparseable ceiling falls back to the default rather than to 1',
    tr.capFor('daily') === 21, String(tr.capFor('daily')));
  check('and is capped at the top step', tr.capFor(999) === 60, String(tr.capFor(999)));

  /* ---- the whole row, with the exact shapes the live tab returns ---- */

  const parsed = tr.parseItems([
    { item_id: 't:blank_active', prompt: 'p', answer: 'a', active: '', max_interval_days: '' },
    { item_id: 't:parked', prompt: 'p', answer: 'a', active: false, max_interval_days: 1 },
    { item_id: 't:volatile', prompt: 'p', answer: 'a', active: true, max_interval_days: 1 },
    { item_id: 't:spaced', prompt: 'p', answer: 'a', active: '', max_interval_days: ' ' },
    { item_id: 't:typo', prompt: 'p', answer: 'a', active: '', max_interval_days: 'each day' }
  ]);
  const byId = Object.fromEntries(parsed.items.map(i => [i.item_id, i]));

  check('all five rows parse — a parked row is parsed, then filtered at selection',
    parsed.items.length === 5, String(parsed.items.length));
  check('the blank-active row is active', byId['t:blank_active'].active === true);
  check('the boolean-false row is NOT active', byId['t:parked'].active === false);
  check('the blank ceiling became the default', byId['t:blank_active'].max_interval_days === 21);
  check('the space-only ceiling became the default', byId['t:spaced'].max_interval_days === 21);
  check('the typed ceiling was kept', byId['t:volatile'].max_interval_days === 1);
  check('an unreadable ceiling is warned about, not silently defaulted',
    parsed.warnings.some(w => w.item_id === 't:typo'), JSON.stringify(parsed.warnings));

  // And the end-to-end consequence: a parked row must never be selected.
  const due = tr.selectDue(parsed.items, Date.now(), 10, 'seed').map(i => i.item_id);
  check('a boolean-false row never reaches a session', !due.includes('t:parked'), due.join(','));
  check('while the blank-active rows do', due.includes('t:blank_active'), due.join(','));
}


/* ================================= 23. dates from a hand-edited spreadsheet */

section('23. the three shapes a spreadsheet date arrives in');
{
  installBrowser();
  const d = await import('../app/dates.js');

  check('a plain-text cell is used as-is', d.parseSheetDate('2026-10-02') === '2026-10-02');

  // Sheets may store the cell as a real date, in which case JSON gives a UTC instant
  // at midnight IN THE SHEET'S TIMEZONE. Slicing ten characters looks right and is
  // wrong for any positive offset.
  check('a Date from a sheet behind UTC resolves correctly',
    d.parseSheetDate('2026-10-02T07:00:00.000Z') === '2026-10-02');
  check('a Date from a sheet AHEAD of UTC resolves correctly too',
    d.parseSheetDate('2026-10-01T22:00:00.000Z') === '2026-10-02',
    d.parseSheetDate('2026-10-01T22:00:00.000Z'));
  check('which a naive ten-character slice would get wrong',
    '2026-10-01T22:00:00.000Z'.slice(0, 10) === '2026-10-01');
  check('a UTC sheet resolves correctly', d.parseSheetDate('2026-10-02T00:00:00.000Z') === '2026-10-02');
  check('a real Date object works', d.parseSheetDate(new Date('2026-10-02T07:00:00Z')) === '2026-10-02');
  check('a spreadsheet serial number works', d.parseSheetDate(46297) === '2026-10-02',
    String(d.parseSheetDate(46297)));

  check('blank is not a date', d.parseSheetDate('') === null);
  check('whitespace is not a date', d.parseSheetDate('   ') === null);
  check('null is not a date', d.parseSheetDate(null) === null);
  check('prose is not a date', d.parseSheetDate('early October') === null);
  check('an implausible serial is not a date', d.parseSheetDate(0) === null);

  check('day arithmetic is whole days', d.daysBetween('2026-10-02', '2026-10-09') === 7);
  check('and signed', d.daysBetween('2026-10-09', '2026-10-02') === -7);
  // A DST transition falls between these two dates in the project timezone.
  check('a DST transition does not shift the count',
    d.daysBetween('2026-10-25', '2026-11-05') === 11,
    String(d.daysBetween('2026-10-25', '2026-11-05')));
}

section('24. expiry and starts_on: inclusive, local, and visible');
{
  installBrowser();
  const tr = await import('../app/training.js?v=24');

  const item = (over, extra) => Object.assign(
    { item_id: 't:x', prompt: 'p', answer: 'a', interval_days: 1, last_tested_ms: null },
    over, extra);

  /* ---- expires_on is INCLUSIVE: the last day the answer is true ---- */
  const chris = item({ expires_on: '2026-10-02' });
  check('valid the day before', tr.statusOf(chris, '2026-10-01') === 'active');
  check('STILL valid ON the expiry date', tr.statusOf(chris, '2026-10-02') === 'active',
    tr.statusOf(chris, '2026-10-02'));
  check('expired the day after', tr.statusOf(chris, '2026-10-03') === 'expired',
    tr.statusOf(chris, '2026-10-03'));
  check('and stays expired', tr.statusOf(chris, '2026-12-25') === 'expired');

  /* ---- starts_on is INCLUSIVE too ---- */
  const queued = item({ starts_on: '2026-10-02' });
  check('not yet, the day before', tr.statusOf(queued, '2026-10-01') === 'not_yet');
  check('active ON the start date', tr.statusOf(queued, '2026-10-02') === 'active');
  check('and after', tr.statusOf(queued, '2026-10-05') === 'active');

  /* ---- a replacement row: both bounds ---- */
  const window = item({ starts_on: '2026-10-02', expires_on: '2026-10-08' });
  check('before the window', tr.statusOf(window, '2026-10-01') === 'not_yet');
  check('inside it', tr.statusOf(window, '2026-10-05') === 'active');
  check('after it', tr.statusOf(window, '2026-10-09') === 'expired');

  /* ---- parked still wins over any window ---- */
  check('a parked row is parked even inside its window',
    tr.statusOf(item({ starts_on: '2026-10-01', expires_on: '2026-10-30', active: false }),
      '2026-10-05') === 'parked');

  /* ---- no dates: unchanged behaviour ---- */
  check('an undated row is simply active', tr.statusOf(item({}), '2026-10-05') === 'active');
  check('a blank expires_on does not expire it',
    tr.statusOf(item({ expires_on: '' }), '2030-01-01') === 'active');
  check('an unreadable expires_on does not expire it either — it warns instead',
    tr.statusOf(item({ expires_on: 'early October' }), '2030-01-01') === 'active');

  /* ---- a Date-serialised bound still lands on the right day ---- */
  check('a Date-serialised expiry from a sheet ahead of UTC is still inclusive',
    tr.statusOf(item({ expires_on: '2026-10-01T22:00:00.000Z' }), '2026-10-02') === 'active'
    && tr.statusOf(item({ expires_on: '2026-10-01T22:00:00.000Z' }), '2026-10-03') === 'expired');

  /* ---- days to expiry, logged on the row ---- */
  check('days to expiry counts down', tr.daysToExpiry(chris, '2026-09-29') === 3);
  check('zero on the last valid day', tr.daysToExpiry(chris, '2026-10-02') === 0);
  check('negative once past', tr.daysToExpiry(chris, '2026-10-05') === -3);
  check('null when undated', tr.daysToExpiry(item({}), '2026-10-05') === null);

  /* ---- an expired item never reaches a session ---- */
  const items = [
    item({ item_id: 't:visitors' }),
    item({ item_id: 't:chris-arrives', expires_on: '2026-10-02' }),
    item({ item_id: 't:kathy-arrives', expires_on: '2026-10-08' })
  ];
  const due = day => tr.selectDue(items, Date.UTC(2026, 9, 5), 10, 'seed', day)
    .map(i => i.item_id);
  check('on the 1st, all three are in rotation', due('2026-10-01').length === 3, due('2026-10-01').join());
  check('on the 3rd, the Chris row is gone', !due('2026-10-03').includes('t:chris-arrives'),
    due('2026-10-03').join());
  check('but the Kathy row remains', due('2026-10-03').includes('t:kathy-arrives'));
  check('on the 9th, both dated rows are gone',
    due('2026-10-09').join() === 't:visitors', due('2026-10-09').join());
  check('and the graceful row survives all of it', due('2026-12-01').includes('t:visitors'));

  /* ---- the notices, which are the other half of the job ---- */
  let n = tr.contentNotices(items, '2026-09-30');
  check('an item expiring in 2 days is surfaced',
    n.expiring.some(e => e.item_id === 't:chris-arrives' && e.days === 2),
    JSON.stringify(n.expiring));
  check('one expiring in 8 days is not yet noisy',
    !n.expiring.some(e => e.item_id === 't:kathy-arrives'), JSON.stringify(n.expiring));
  check('nothing has expired yet', n.expired.length === 0);

  n = tr.contentNotices(items, '2026-10-03');
  check('once past, it is reported as expired', n.expired.includes('t:chris-arrives'),
    JSON.stringify(n.expired));
  check('and is no longer merely expiring',
    !n.expiring.some(e => e.item_id === 't:chris-arrives'));

  n = tr.contentNotices([item({ item_id: 't:later', starts_on: '2026-11-01' })], '2026-10-03');
  check('a queued replacement is reported as not yet started',
    n.notYet.includes('t:later'), JSON.stringify(n.notYet));

  /* ---- parsing carries the columns and warns on an unreadable date ---- */
  const parsed = tr.parseItems([
    { item_id: 't:a', prompt: 'p', answer: 'a', expires_on: '2026-10-02' },
    { item_id: 't:b', prompt: 'p', answer: 'a', expires_on: 'sometime soon' },
    { item_id: 't:c', prompt: 'p', answer: 'a', starts_on: 'whenever' }
  ]);
  check('a readable date is carried through', parsed.items[0].expires_on === '2026-10-02');
  check('an unreadable expiry warns, because the row then has none',
    parsed.warnings.some(w => w.item_id === 't:b' && /expires_on/.test(w.why)),
    JSON.stringify(parsed.warnings));
  check('an unreadable start date warns too',
    parsed.warnings.some(w => w.item_id === 't:c' && /starts_on/.test(w.why)));
  check('an absent column produces no warning',
    !parsed.warnings.some(w => w.item_id === 't:a'));
}


/* =================================== 25. a slot consumes its whole duration */

section('25. filler fills its time, so a slot cannot end early');
{
  const env = installBrowser();
  // Record what durations are requested rather than actually waiting.
  const asked = [];
  global.setTimeout = (fn, ms) => { asked.push(ms || 0); fn(); return asked.length; };
  global.requestAnimationFrame = fn => { fn(1); return 1; };
  const f = await import('../app/filler.js');
  const { rng } = await import('../app/rng.js');

  const host = { innerHTML: '', querySelector: () => stage, firstElementChild: null };
  const stage = { children: [], appendChild(n) { this.children.push(n); },
                  removeChild(n) { this.children.shift(); },
                  get firstChild() { return this.children[0]; } };
  global.document.createElement = () => ({ style: {}, classList: { add() {} } });

  asked.length = 0;
  await f.run({ screenEl: host, ms: 75000, rand: rng('t'), photos: null });
  const total = asked.reduce((a, b) => a + b, 0);
  check('filler consumes exactly the time it is given',
    Math.abs(total - 75000) < 2, String(total));

  asked.length = 0;
  await f.run({ screenEl: host, ms: 94000, rand: rng('t'), photos: null });
  check('and an arbitrary padding duration too',
    Math.abs(asked.reduce((a, b) => a + b, 0) - 94000) < 2);

  asked.length = 0;
  await f.run({ screenEl: host, ms: 3000, rand: rng('t'), photos: null });
  check('a short pad still resolves', Math.abs(asked.reduce((a, b) => a + b, 0) - 3000) < 2);

  check('it renders something rather than a bare heading',
    stage.children.length > 0, String(stage.children.length));
  check('and it keeps the DOM small over a long filler', stage.children.length <= 2,
    String(stage.children.length));
}

/* ===================================== 26. Probe A practice and comprehension */

section('26. Probe A: practice trials, excluded by stage name');
{
  installBrowser();
  const crt = await import('../app/probe_crt.js?v=26');
  const S = await import('../app/session.js?v=26');

  check('there are practice trials', crt.PRACTICE_TRIALS === 4, String(crt.PRACTICE_TRIALS));
  check('the practice stages are declared',
    S.STAGES.includes('crt_1_practice') && S.STAGES.includes('crt_2_practice'));

  // Excluded by STAGE NAME, not a flag, so they cannot be pooled by anyone who
  // forgets to filter.
  check('practice stage names are distinct from the measured ones',
    !['crt_1', 'crt_2'].includes('crt_1_practice'));

  // Both blocks get the same warm-up, or crt_2 minus crt_1 would mix fatigue with
  // warm-up rather than measuring fatigue alone.
  check('both blocks have a practice stage',
    S.STAGES.filter(s => s.endsWith('_practice')).length === 2,
    S.STAGES.filter(s => s.endsWith('_practice')).join());

  // Practice must not reuse the measured sequence.
  const measured = crt.makeBlock('seed');
  const practice = crt.makeBlock('seed:practice').slice(0, crt.PRACTICE_TRIALS);
  check('practice draws a different sequence from the measured block',
    JSON.stringify(practice) !== JSON.stringify(measured.slice(0, crt.PRACTICE_TRIALS)));
  check('and is still a valid block', practice.every(t =>
    (t.side === 'left' || t.side === 'right') && crt.FOREPERIODS.includes(t.foreperiod_ms)));

  /* The instruction has to be on the screen, not only before it. */
  check('the field carries a standing reminder',
    crt.FIELD_HTML.includes(crt.REMINDER), crt.REMINDER);
  check('the reminder says plainly what to do',
    /click/i.test(crt.REMINDER) && /circle/i.test(crt.REMINDER), crt.REMINDER);
  check('the target has a mark inside it, so it reads as a target not a decoration',
    crt.FIELD_HTML.includes('crt-bullseye'));
  check('the home pad says what it is for',
    /start the next one/i.test(crt.FIELD_HTML));
  check('the instruction screen says a circle will turn blue and to click it',
    /turn blue/i.test(crt.instructionsHtml()) && /click it/i.test(crt.instructionsHtml()));
  check('it shows the layout rather than only describing it',
    crt.instructionsHtml().includes('crt-demo'));
  check('it does not start until the reader says so',
    crt.instructionsHtml().includes('crtGo'));
  check('the end of the block is stated',
    /finished/i.test(crt.doneHtml()) && /nothing more/i.test(crt.doneHtml()));
}

/* ======================================== 27. training screen comprehension */

section('27. the training screens explain themselves');
{
  installBrowser();
  const t = await import('../app/probe_training.js?v=27');
  const item = { item_id: 't:x', prompt: 'Who is coming to visit?', answer: 'Chris.' };

  const q = t.promptHtml(item);
  check('the question is labelled Q:', q.includes('>Q:<'));
  check('and carries the retrieval instruction',
    /say the answer out loud/i.test(q), 'missing');
  check('the instruction is styled smaller than the content',
    q.includes('class="instruction"') && q.includes('class="lead question"'));
  check('the reveal button starts hidden, so it cannot be clicked through',
    /id="trReveal" hidden/.test(q));
  check('and says what it does', /see if you were right/i.test(q));
  check('there is a gate before it appears', t.REVEAL_GATE_MS === 5000, String(t.REVEAL_GATE_MS));

  const a = t.answerHtml(item);
  check('the answer screen labels both Q: and A:', a.includes('>Q:<') && a.includes('>A:<'));
  check('the self-report question sits directly above the buttons',
    a.indexOf('Did you get it right?') < a.indexOf('Got it')
    && a.indexOf('Did you get it right?') > a.indexOf(item.answer));
  check('all three options are offered',
    /Got it/.test(a) && /Partly/.test(a) && /Not quite/.test(a));

  const closed = t.closeHtml(item, true);
  check('a miss is answered warmly, not marked', /that's all right/i.test(closed));
  check('and nothing on it is red or an X', !/✗|✘|wrong|incorrect/i.test(closed));
  check('a success is acknowledged briefly', /good/i.test(t.closeHtml(item, false)));

  check('nothing waits forever', t.NO_RESPONSE_MS > 0 && t.NO_RESPONSE_MS <= 180000,
    String(t.NO_RESPONSE_MS));
}

/* ============================ 28. the review mode covers every screen */

section('28. the screen review cannot fall out of date');
{
  installBrowser();
  const review = await import('../app/review.js?v=28');
  const S = await import('../app/session.js?v=28');
  const ids = review.screenIds();

  check('the review lists screens', ids.length >= 14, String(ids.length));

  // Every stage that puts something on screen must appear in the review, or a new
  // screen could ship without anyone ever having looked at it - which is exactly how
  // Probe A shipped unreadable.
  const needs = {
    training_1: 'training_prompt', crt_1: 'crt_field_waiting',
    filler_1: 'filler', filler_2: 'filler'
  };
  for (const [stage, id] of Object.entries(needs)) {
    check(`stage ${stage} has a reviewable screen (${id})`, ids.includes(id), ids.join(','));
  }
  for (const id of ['open', 'greeting', 'company_question', 'training_answer',
                    'training_close_missed', 'crt_instructions', 'crt_field_lit',
                    'crt_done', 'close', 'session_inactive']) {
    check(`${id} is reviewable`, ids.includes(id), ids.join(','));
  }
  check('including the remote off switch, which is easy to forget',
    ids.includes('session_inactive'));

  // Every stage the app can be in must be a declarable last_stage_reached, or an
  // abandoned session writes a value the schema never declared. This cross-check
  // caught exactly that when the practice stages were added.
  const sessionStages = [
    'open', 'greeting', 'company_question', 'opening_recognition',
    'crt_1_practice', 'crt_1', 'encoding', 'filler_1', 'recognition_short',
    'filler_2', 'recognition_medium', 'crt_2_practice', 'crt_2', 'close',
    'training_1', 'training_2', 'training_3', 'training_4'
  ];
  for (const st of S.STAGES) {
    check(`stage ${st} is a declarable last_stage_reached`, sessionStages.includes(st), st);
  }
}


/* ========================= 29. the greeting, the name, and the close */

section('29. no name in the code, and no time of day in the greeting');
{
  installBrowser();
  const sc = await import('../app/screens.js');
  const cfg = await import('../app/config.js?v=29');

  /* THE STRUCTURAL GUARD. A name cannot be caught by a pattern-matching content gate:
     names cannot be enumerated, and a gate listing the one to look for would publish
     it. So the only slot for a name is empty in the compiled-in defaults, and this
     asserts it stays that way. */
  check('the compiled-in display_name is empty', cfg.DEFAULTS.display_name === '',
    JSON.stringify(cfg.DEFAULTS.display_name));
  check('every compiled-in default is name-free',
    Object.values(cfg.DEFAULTS).every(v => typeof v !== 'string' || !/^[A-Z][a-z]{2,}$/.test(v.trim())),
    JSON.stringify(cfg.DEFAULTS));

  /* No time of day. There is no schedule and no expectation of one, so "good morning"
     is wrong whenever it is wrong, and cannot be checked against anything. */
  const all = [sc.openHtml({}), sc.greetingHtml({}), sc.closeHtml({}), sc.inactiveHtml({}),
               sc.greetingSpeech({})].join(' ');
  check('nothing greets by time of day',
    !/morning|afternoon|evening|tonight/i.test(all), all.slice(0, 120));
  check('the greeting is a plain hello', sc.hello({}) === 'Hello.', sc.hello({}));
  // The stand-in is deliberately NOT name-shaped. A gate cannot tell a fake name from
  // a real one, so "it's only a test value" is not a distinction it can make - and a
  // fixture that looks like a name is how a real one gets normalised into the code.
  const STAND_IN = 'TESTNAME';
  check('and takes a name from config when there is one',
    sc.hello({ display_name: STAND_IN }) === `Hello, ${STAND_IN}.`,
    sc.hello({ display_name: STAND_IN }));
  check('the spoken greeting matches the written one',
    sc.greetingSpeech({ display_name: STAND_IN }).startsWith(`Hello, ${STAND_IN}.`));
  check('a name with markup in it is escaped, not injected',
    !sc.openHtml({ display_name: '<b>x</b>' }).includes('<b>'),
    sc.openHtml({ display_name: '<b>x</b>' }));

  /* The close: warm, brief, never a summary of performance. */
  const close = sc.closeHtml({ display_name: STAND_IN, closing_note: 'Thank you.' });
  check('the close states completion', /finished the practice/i.test(close));
  check('and greets by name if one is set', close.includes(STAND_IN));
  check('the closing note is config, so its wording needs no deploy',
    sc.closeHtml({ closing_note: 'Great effort!' }).includes('Great effort!'));
  check('an empty closing note simply omits the line',
    !sc.closeHtml({ closing_note: '' }).includes('<p class="sub">'));
  check('NEVER a score, count or streak on the close',
    !/\b\d+\s*(of|\/)\s*\d+|score|streak|correct|points/i.test(close), close);

  /* message_line is family news, and must not be dressed as an instruction. */
  check('message_line appears when set',
    sc.closeHtml({ message_line: 'Anna comes Thursday.' }).includes('Anna comes Thursday.'));
  check('and is absent when not', !sc.closeHtml({}).includes('instruction'));
}

section('30. the company question distinguishes being helped');
{
  installBrowser();
  const sc = await import('../app/screens.js?v=30');
  const html = sc.companyHtml();

  check('three options, not two',
    (html.match(/data-value="/g) || []).length === 3,
    String((html.match(/data-value="/g) || []).length));

  // The third is the one that matters: if the responses are not the user's own, no covariate
  // fixes that, and a yes/no question makes it invisible.
  check('alone is offered', html.includes('data-value="alone"'));
  check('merely present is offered', html.includes('data-value="someone_present"'));
  check('BEING HELPED is offered separately', html.includes('data-value="someone_helping"'));

  check('it asks about right now, which is answerable from the room',
    /just now|right now|at the moment/i.test(html), html.slice(0, 80));
  check('and makes clear that any answer is fine, so help is not framed as cheating',
    /any answer is fine/i.test(html));
  check('nothing implies help is a problem',
    !/cheat|should not|must not|alone only/i.test(html));
}


/* ========================= 31. which route a session came from */

section('31. the Dock app and a Safari tab are distinguishable in the data');
{
  installBrowser();
  const lay = await import('../app/layout.js?v=31');

  /*
   * WHY THIS MATTERS ENOUGH TO BE A COLUMN. Adding the app to the Dock gives it a
   * SEPARATE STORAGE CONTAINER from Safari. So the same machine presents as two
   * devices: different device_id, independent session_seq counters, and a
   * days_since_prev_session computed from only one container's history - wrong in a
   * way that looks entirely plausible. The user agent is identical for both, so
   * without this the route is only recoverable by device_id archaeology.
   */
  global.matchMedia = q => ({ matches: q.includes('standalone') });
  check('the Dock app reports standalone', lay.displayMode() === 'standalone', lay.displayMode());

  global.matchMedia = q => ({ matches: q.includes('browser') });
  check('a Safari tab reports browser', lay.displayMode() === 'browser', lay.displayMode());

  // Never throw and never guess: an unknown route is better than a wrong one.
  global.matchMedia = () => ({ matches: false });
  check('neither matching gives unknown, not a guess', lay.displayMode() === 'unknown');
  global.matchMedia = () => { throw new Error('nope'); };
  check('a throwing matchMedia gives unknown rather than breaking the session',
    lay.displayMode() === 'unknown');
  delete global.matchMedia;
  check('no matchMedia at all is also unknown', lay.displayMode() === 'unknown');

  const cols = await import('../app/columns.js?v=31');
  check('display_mode is on the session row', cols.SESSION_COLUMNS.includes('display_mode'));
  check('and appended at the END, because rows are already being collected',
    cols.SESSION_COLUMNS[cols.SESSION_COLUMNS.length - 1] === 'display_mode',
    cols.SESSION_COLUMNS.slice(-2).join(','));
  check('it is NOT on the trial row - it is a property of the session',
    !cols.TRIAL_COLUMNS.includes('display_mode'));
}


/* ========================= 32. time-to-start is measured from page load */

section('32. ms_open_before_start measures hesitation, not prepare()');
{
  installBrowser();
  const { Session } = await import('../app/session.js?v=32');

  /*
   * The schema defines this column as how long the opening screen was looked at, with
   * an upward drift being a hesitation signal. It was measured from the Session
   * constructor - which the Start handler creates - so it measured prepare() and read
   * as a few tens of milliseconds every session.
   *
   * A hesitation signal that reads ~0 forever is worse than an absent one, because it
   * looks populated and nobody goes looking. Caught while the Sheet was still empty,
   * which is the only moment fixing it costs nothing.
   */
  const pageOpen = 1790000000000;
  const s1 = new Session({ config: {}, openedAt: pageOpen });
  check('openedAt is the value passed in, not construction time',
    s1.openedAt === pageOpen, String(s1.openedAt));

  s1.startedAt = pageOpen + 47000;        // 47 seconds on the opening screen
  s1.stage = 'close';
  const row = s1.sessionRow('completed');
  check('ms_open_before_start is the real gap', row.ms_open_before_start === 47000,
    String(row.ms_open_before_start));
  check('opened_at_utc is page load', row.opened_at_utc === pageOpen);

  // total_ms must stay TASK duration. Session length is what the reaction-time
  // bracket interprets fatigue against, so idle time must not leak into it.
  check('total_ms is measured from Start, NOT from page load',
    row.total_ms < 47000, String(row.total_ms));
  check('so the two sum to the whole visit, and neither double-counts',
    row.ms_open_before_start + row.total_ms === row.ended_at_utc - row.opened_at_utc,
    `${row.ms_open_before_start} + ${row.total_ms} vs ${row.ended_at_utc - row.opened_at_utc}`);

  // Never started: the null the schema calls the most informative value in the table.
  const s2 = new Session({ config: {}, openedAt: pageOpen });
  const row2 = s2.sessionRow('never_started');
  check('start_pressed_at_utc is null when Start was never pressed',
    row2.start_pressed_at_utc === null);
  check('and ms_open_before_start is null rather than a misleading zero',
    row2.ms_open_before_start === null, String(row2.ms_open_before_start));

  // Omitting it must not throw: a wrong-but-present time beats a crash on the device.
  check('a missing openedAt falls back to now rather than failing',
    new Session({ config: {} }).openedAt > 0);
}


console.log('\n' + (fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${pass} passed, ${fail} FAILED`));
process.exit(fail === 0 ? 0 : 1);
