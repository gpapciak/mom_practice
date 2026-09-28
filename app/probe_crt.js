/**
 * Probe A — choice reaction time.
 *
 * WHY THIS PROBE EXISTS
 * ---------------------
 * The measure it is built to produce is **intraindividual variability in response
 * time, not mean speed** — the statistic most sensitive to deep frontal white
 * matter damage. So it exists to yield a clean per-trial latency distribution,
 * twice per session, under conditions identical in every session.
 *
 * THE ONE THING THAT MAKES IT WORTH ANYTHING
 * ------------------------------------------
 * Decision time and cursor-travel time are recorded separately. A slow click is not
 * a slow decision, and conflating them would make motor slowing look like cognitive
 * variability for months.
 *
 * Two mechanisms make the split possible:
 *
 *   The home pad. Every trial begins with a click on a central pad, so the cursor
 *   is at a known centre position when the stimulus appears and the distance to
 *   either target is identical on every trial of every session. Without it the
 *   cursor would start wherever the last click left it and travel time would be
 *   uninterpretable.
 *
 *   Movement onset. The first mousemove more than 8 CSS px from the position at
 *   stimulus onset splits the interval: onset→movement is the decision,
 *   movement→click is the travel. The target machine reports movement at a 12 ms
 *   median interval, so that boundary resolves to about 12 ms.
 *
 * The threshold stays at 8 px even though finer sampling makes 4 px look
 * affordable. A smaller threshold would halve the onset lag on a slow start, but
 * would sometimes trigger on hand tremor instead of on movement toward the target —
 * trading a constant bias for a variable contaminant. A constant bias cancels in
 * every longitudinal comparison; contamination does not.
 *
 * TIMING DISCIPLINE
 * -----------------
 * All response times come from `event.timeStamp`, never from a clock read inside
 * the handler, because handler dispatch can be delayed by tens of milliseconds
 * under load. Stimulus onset is the `requestAnimationFrame` timestamp of the frame
 * that paints the target, which is the same time base as `event.timeStamp`.
 *
 * FROZEN PARAMETERS. Changing any of these ends the comparability of the series.
 * `crt_1` and `crt_2` must stay identical in every respect: their difference is the
 * within-session fatigue measure, and shortening the second block would destroy
 * that measure retroactively for every session after the change.
 */

import { rng, shuffle } from './rng.js';
import * as lifecycle from './lifecycle.js';

export const PROBE_ID = 'A_crt';
export const PROBE_VERSION = 1;

/**
 * 16, down from 24, decided before the first collected row.
 *
 * The relative standard error of an intraindividual-variability estimate is about
 * 1/sqrt(2(n-1)): 14.7% at 24 trials, 18.3% at 16. A factor of 1.24 per session,
 * recoverable with about 1.5x the sessions - roughly ten extra days across six months of
 * daily use.
 *
 * Set against that: 56 clicks a session was more than the person using it would tolerate,
 * and a probe that gets refused measures nothing at all. The precision is recoverable by
 * waiting; the willingness is not.
 */
export const TRIALS_PER_BLOCK = 16;

/**
 * DERIVED, never stated. Exact left/right balance is structural, so this is
 * TRIALS_PER_BLOCK / 2 by definition - and when the trial count changed from 24 to 16, a
 * separately written 12 would have silently built 24-trial blocks from a 16-trial
 * constant.
 */
export const SIDES_PER_BLOCK = TRIALS_PER_BLOCK / 2;
export const SETTLE_MS = 300;               // after the home click, before the foreperiod
export const RESPONSE_TIMEOUT_MS = 5000;    // then omission
export const ANTICIPATION_MS = 150;         // faster than this is not a decision
export const MOVE_THRESHOLD_PX = 8;
export const FEEDBACK_MS = 400;             // target dims, then the home pad returns

/**
 * Unscored warm-up trials before the measured block, in BOTH blocks.
 *
 * This is how the task is normally administered, and for good reason: the first few
 * trials of an unfamiliar speeded task measure learning the task, not the thing the
 * task is for. They are excluded by STAGE NAME rather than by a flag, so they cannot
 * be pooled by anyone who forgets to filter.
 *
 * Both blocks get the same number. Warming only the first would make crt_2 minus
 * crt_1 a mixture of fatigue and warm-up rather than fatigue alone - and that
 * difference is the entire fatigue measure.
 */
/**
 * 3, down from 4. Both blocks still get them: warming only the first would make
 * crt_2 - crt_1 a mixture of fatigue and warm-up rather than fatigue alone.
 */
export const PRACTICE_TRIALS = 3;

/**
 * Kept on screen for the whole block, and this is not decoration.
 *
 * The rule is that every screen must make sense on its own to someone who cannot
 * carry an instruction forward from the previous screen and has nobody to ask. An
 * instruction screen shown once before the block does not satisfy that: by trial
 * three it has been forgotten. So the instruction stays visible.
 */
export const REMINDER = 'Click the circle as soon as it turns blue.';

/** 1000–2500 ms in 100 ms steps. Jittered so the onset cannot be anticipated. */
export const FOREPERIODS = [
  1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700,
  1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500
];

/* ------------------------------------------------------------------ sequence */

/**
 * Builds one block's trial list. Deterministic for a given seed, so the exact
 * sequence is reconstructable from `rng_seed` on the rows.
 *
 * Sides are exactly 12/12 — balance is structural, not left to chance.
 *
 * Foreperiods are drawn in whole shuffled passes over the 16-value list, so every value
 * appears as near equally often as the trial count allows and none is ever missing. At 16
 * trials that is exactly one pass and the balance is perfect.
 *
 * This used to take one pass and then `.slice(0, 8)` of a second - a hardcoded 8 that was
 * really `24 - 16`. Changing TRIALS_PER_BLOCK to 16 would have left it building 24
 * foreperiods for 16 trials: no error, just eight values silently discarded and the
 * balance quietly wrong. Derived from the trial count instead.
 */
export function makeBlock(seed) {
  const next = rng(seed);
  const sides = shuffle(
    Array(SIDES_PER_BLOCK).fill('left').concat(Array(SIDES_PER_BLOCK).fill('right')),
    next);

  let pool = [];
  while (pool.length < TRIALS_PER_BLOCK) pool = pool.concat(shuffle(FOREPERIODS, next));
  const fps = shuffle(pool.slice(0, TRIALS_PER_BLOCK), next);

  return sides.map((side, i) => ({ side, foreperiod_ms: fps[i] }));
}

/* ------------------------------------------------------------------ analysis */

/**
 * Normalises a DOM event timestamp to the page's time origin.
 *
 * Modern Safari gives `event.timeStamp` as a DOMHighResTimeStamp relative to the
 * time origin, the same base as rAF. Some older engines gave a Unix epoch instead,
 * which would silently produce latencies in the trillions. Cheap to guard, and the
 * failure it prevents is not subtle.
 */
export function eventTime(ev) {
  const t = ev.timeStamp;
  if (!(t > 0)) return performance.now();
  return t > 1e12 ? t - performance.timeOrigin : t;
}

/**
 * Splits a movement trace into the decision and travel components.
 *
 * samples: [{ t, x, y }] recorded from stimulus onset onward.
 * Returns decision_latency_ms and travel_latency_ms, or nulls when the trace does
 * not support them — a click with no detected movement is real and must not be
 * turned into a fabricated zero.
 */
export function analyseMovement(samples, start, onsetTime, clickTime) {
  const out = {
    decision_latency_ms: null,
    travel_latency_ms: null,
    travel_path_px: null,
    n_mousemove_samples: samples.length,
    /** True when the hand was already moving as the target lit: no decision to time. */
    moving_at_onset: false
  };
  if (!samples.length) return out;

  let path = 0;
  let prev = start;
  let onsetIdx = -1;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    path += Math.hypot(s.x - prev.x, s.y - prev.y);
    prev = s;
    if (onsetIdx < 0) {
      const d = Math.hypot(s.x - start.x, s.y - start.y);
      if (d > MOVE_THRESHOLD_PX) onsetIdx = i;
    }
  }
  out.travel_path_px = Math.round(path);

  if (onsetIdx >= 0) {
    const moveT = samples[onsetIdx].t;
    const decision = Math.round(moveT - onsetTime);

    /*
     * ALREADY MOVING WHEN THE TARGET LIT. Two of the first thirty-two trials came back
     * with decision latencies of -4 ms and -3 ms, flagged `ok`.
     *
     * The threshold is distance from the home pad, so if the hand had already drifted
     * more than 8 px before onset, the first sample crosses it and the "decision" is
     * zero or negative. There is no decision time to measure on such a trial: the
     * movement did not begin in response to anything.
     *
     * The response latency is still perfectly good - the click happened and it was
     * correct - so the trial is NOT discarded. Only the split is unmeasurable, and
     * nulling it is exactly how an analysis excludes it. A negative number that reads as
     * a decision made before the stimulus appeared is far worse than an absent one.
     */
    if (decision <= 0) {
      out.moving_at_onset = true;
      return out;                       // both components stay null
    }
    out.decision_latency_ms = decision;

    /*
     * No click means no travel. On the one omission in that session, clickTime came
     * through as 0, so `clickTime - moveT` produced -3995 ms of travel - a fabricated
     * negative for a journey that never finished. Time-to-move is real on an omission and
     * is kept; the travel component is not.
     */
    if (Number.isFinite(clickTime) && clickTime > moveT) {
      out.travel_latency_ms = Math.round(clickTime - moveT);
    }
  }
  return out;
}

/**
 * Classifies a response. Separate from the DOM so it can be tested directly, and
 * because the definitions are part of the frozen probe rather than of the UI.
 *
 * Nothing here discards a trial. Anticipations and omissions are recorded, not
 * dropped: trimming is an analysis decision made later from raw rows.
 */
export function classify({ clicked, expected, responseMs, beforeOnset }) {
  if (beforeOnset) return { outcome_flag: 'anticipation', correct: 0 };
  if (clicked === null) return { outcome_flag: 'omission', correct: null };
  if (responseMs !== null && responseMs < ANTICIPATION_MS) {
    return { outcome_flag: 'anticipation', correct: clicked === expected ? 1 : 0 };
  }
  if (clicked !== expected) return { outcome_flag: 'error', correct: 0 };
  return { outcome_flag: 'ok', correct: 1 };
}

/* ---------------------------------------------------------------------- run */

/**
 * The playing field.
 *
 * Both positions are always visible as empty sockets, so it is clear where things
 * happen. The lit one becomes a solid disc with a ring inside it: a shape that reads
 * as "aim here" without needing to be read, which matters because reading time would
 * land inside the reaction time being measured.
 *
 * The home pad is what makes travel time interpretable - it returns the cursor to a
 * known centre before every trial - and it is labelled so that its purpose is legible
 * rather than inferred.
 */
export const FIELD_HTML = `
<div class="crt" id="crt">
  <button class="crt-home" id="crtHome" type="button">
    <span class="crt-home-label">Click here<br>to start the next one</span>
  </button>
  <button class="crt-target" id="crtLeft" data-side="left" type="button" aria-label="left target">
    <span class="crt-bullseye"></span>
  </button>
  <button class="crt-target" id="crtRight" data-side="right" type="button" aria-label="right target">
    <span class="crt-bullseye"></span>
  </button>
  <p class="crt-reminder">${REMINDER}</p>
  <p class="crt-note" id="crtNote"></p>
</div>`;

/**
 * Shown once before each block. Not frozen - it is instruction, not stimulus - so it
 * can be reworded freely without touching probe_version.
 *
 * It shows the actual layout with one target lit, because a picture of what is about
 * to happen is worth more than a description of it.
 *
 * IT SAYS WHAT THE PART IS FOR. The first version said "it is not a test of anything",
 * which is a denial rather than a purpose and invites exactly the question it deflects.
 * Being asked to do something repetitive with no stated reason is noticed by any capable
 * adult, and noticing it is a reason to stop.
 *
 * So: what it measures, and how long it takes. Both true. "How quickly you're clicking
 * today" is honest without being clinical, and the duration is stated because not knowing
 * how long something lasts is its own reason to refuse.
 */
export function instructionsHtml() {
  return `
    <div class="pane">
      <p class="lead">A circle will turn blue.</p>
      <p class="sub">Click it as soon as it does.</p>
      <p class="instruction">This part just checks how quickly you're clicking today.
        It takes about a minute.</p>
      <div class="crt crt-demo" aria-hidden="true">
        <span class="crt-target demo-socket"></span>
        <span class="crt-target demo-socket lit"><span class="crt-bullseye"></span></span>
      </div>
      <button class="big primary" id="crtGo" type="button">I'm ready</button>
    </div>`;
}

/** Shown once after each block, so the end is stated rather than inferred. */
export function doneHtml() {
  return `
    <div class="pane">
      <p class="lead">That part is finished.</p>
      <p class="sub">Nothing more to do here.</p>
    </div>`;
}

/**
 * Runs one block. Emits exactly TRIALS_PER_BLOCK rows through session.addTrial.
 *
 * `session.stage` must already be 'crt_1' or 'crt_2'; the two are identical in
 * every parameter and differ only in when they occur.
 */
export async function run(session, { screenEl, seed }) {
  const measuredStage = session.stage;              // 'crt_1' or 'crt_2'
  const practiceStage = measuredStage + '_practice';

  // Instructions, then a "ready" click, so nothing starts while it is still being
  // read. The click belongs to the user, not to a timer.
  screenEl.innerHTML = instructionsHtml();
  session.checkFits(measuredStage + '_instructions');
  await clickOnce(screenEl.querySelector('#crtGo'));

  screenEl.innerHTML = FIELD_HTML;
  const home = screenEl.querySelector('#crtHome');
  const left = screenEl.querySelector('#crtLeft');
  const right = screenEl.querySelector('#crtRight');
  const note = screenEl.querySelector('#crtNote');
  const targets = { left, right };

  // Practice first, from a separate seed so warm-up trials never reuse the measured
  // sequence. It is experienced as one continuous activity: the screens are identical
  // and the boundary is never announced, which is what makes practice painless.
  const practice = makeBlock(seed + ':practice').slice(0, PRACTICE_TRIALS);
  const block = makeBlock(seed);
  const all = practice.map(t => ({ t, stage: practiceStage }))
    .concat(block.map(t => ({ t, stage: measuredStage })));

  // One persistent tracker, so the cursor position at stimulus onset is known
  // rather than assumed to be the home pad.
  let lastPos = { x: 0, y: 0 };
  const trackPos = ev => { lastPos = { x: ev.clientX, y: ev.clientY }; };
  window.addEventListener('mousemove', trackPos, { passive: true });

  try {
    let indexInStage = 0;
    let lastStage = null;
    for (let i = 0; i < all.length; i++) {
      const { t: trial, stage } = all[i];
      if (stage !== lastStage) { indexInStage = 0; lastStage = stage; }
      session.stage = stage;
      note.textContent = '';
      setLit(targets, null);
      home.hidden = false;

      await clickOnce(home);
      home.hidden = true;
      await sleep(SETTLE_MS);

      const result = await oneTrial(session, { targets, trial, lastPosRef: () => lastPos });

      // Errors are absorbed, never marked. Nothing red, no X, no sound, no repeat.
      note.textContent = result.outcome_flag === 'error' ? 'Next one.' : '';
      setLit(targets, null);
      await sleep(FEEDBACK_MS);

      session.addTrial(Object.assign({
        probe_id: PROBE_ID,
        probe_version: PROBE_VERSION,
        stage_trial_index: indexInStage++,
        stimulus_side: trial.side,
        foreperiod_ms: trial.foreperiod_ms,
        response: result.clicked
      }, result.row));

      // Inter-trial interval: dead time, and therefore the only safe moment to let
      // an IndexedDB transaction run.
      if (i % 6 === 5) await session.flush();
      if (session.ended) return;
    }
  } finally {
    window.removeEventListener('mousemove', trackPos);
    session.stage = measuredStage;
  }

  // The end of the block is stated, not left to be inferred from a screen that
  // simply stops changing.
  screenEl.innerHTML = doneHtml();
  session.checkFits(measuredStage + '_done');
  await sleep(2200);
}

/** One trial: foreperiod, onset, response. Resolves with row fields. */
function oneTrial(session, { targets, trial, lastPosRef }) {
  return new Promise(resolve => {
    const expected = trial.side;
    let onsetTime = null;
    let start = null;
    let samples = [];
    let settled = false;
    let timeoutId = null;
    let fpId = null;

    const onMove = ev => {
      if (onsetTime === null) return;
      samples.push({ t: eventTime(ev), x: ev.clientX, y: ev.clientY });
    };

    const finish = fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(fpId);
      window.removeEventListener('mousemove', onMove);
      left_right().forEach(t => t.removeEventListener('click', onClick));
      resolve(fields);
    };

    const left_right = () => [targets.left, targets.right];

    const onClick = ev => {
      // A click on a stale screen is refused, never recorded. Between the machine
      // waking and the heartbeat noticing, this screen is still live, and accepting
      // the click would write a trial whose latency is however long the lid was shut.
      if (lifecycle.isStale()) {
        session.veil('stale-click');
        return;
      }

      const clicked = ev.currentTarget.dataset.side;

      if (onsetTime === null) {
        // Clicked during the foreperiod. Logged as an anticipation; the trial is not
        // repeated, because a repeat would mean extra practice on that sequence.
        const c = classify({ clicked, expected, responseMs: null, beforeOnset: true });
        finish({
          clicked,
          outcome_flag: c.outcome_flag,
          row: Object.assign({
            correct: c.correct,
            response_latency_ms: null,
            decision_latency_ms: null,
            travel_latency_ms: null,
            mouse_start_x: null, mouse_start_y: null,
            click_x: Math.round(ev.clientX), click_y: Math.round(ev.clientY),
            travel_path_px: null, n_mousemove_samples: 0,
            outcome_flag: c.outcome_flag
          })
        });
        return;
      }

      const clickTime = eventTime(ev);
      const responseMs = Math.round(clickTime - onsetTime);
      const c = classify({ clicked, expected, responseMs, beforeOnset: false });
      const mv = analyseMovement(samples, start, onsetTime, clickTime);
      // Tallied per session, not per row, because the trial itself is still good - only
      // its decision/travel split is unmeasurable. A rising count would mean the hand is
      // not returning to rest between trials, which changes what the split measures.
      if (mv.moving_at_onset) session.movingAtOnset = (session.movingAtOnset || 0) + 1;

      finish({
        clicked,
        outcome_flag: c.outcome_flag,
        row: Object.assign({
          correct: c.correct,
          response_latency_ms: responseMs,
          mouse_start_x: Math.round(start.x), mouse_start_y: Math.round(start.y),
          click_x: Math.round(ev.clientX), click_y: Math.round(ev.clientY),
          outcome_flag: c.outcome_flag
        }, mv)
      });
    };

    left_right().forEach(t => t.addEventListener('click', onClick));

    fpId = setTimeout(() => {
      // Onset is stamped from the rAF timestamp of the frame that paints the target,
      // not from a clock read before or after. Same time base as event.timeStamp.
      requestAnimationFrame(frameTime => {
        setLit(targets, expected);
        onsetTime = frameTime;
        start = Object.assign({}, lastPosRef());
        session.beginTrial();
        window.addEventListener('mousemove', onMove, { passive: true });

        timeoutId = setTimeout(() => {
          const c = classify({ clicked: null, expected, responseMs: null, beforeOnset: false });
          finish({
            clicked: null,
            outcome_flag: c.outcome_flag,
            row: Object.assign({
              correct: c.correct,
              response_latency_ms: null,
              mouse_start_x: Math.round(start.x), mouse_start_y: Math.round(start.y),
              click_x: null, click_y: null,
              outcome_flag: c.outcome_flag
            }, analyseMovement(samples, start, onsetTime, onsetTime))
          });
        }, RESPONSE_TIMEOUT_MS);
      });
    }, trial.foreperiod_ms);
  });
}

function setLit(targets, side) {
  targets.left.classList.toggle('lit', side === 'left');
  targets.right.classList.toggle('lit', side === 'right');
}

function clickOnce(node) {
  return new Promise(resolve => {
    const h = () => { node.removeEventListener('click', h); resolve(); };
    node.addEventListener('click', h);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
