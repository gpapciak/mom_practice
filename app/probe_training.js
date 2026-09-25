/**
 * The training screen: spaced retrieval, three screens per item.
 *
 *   1. PROMPT      the question, alone, with one button. The retrieval attempt
 *                  happens here, out loud or silently. Time to this click is
 *                  recorded: a fast click means retrieval did not happen.
 *   2. ANSWER      the answer, supplied regardless of how it went, then three
 *                  buttons. The answer comes BEFORE the self-report, which is what
 *                  makes this errorless: nobody is asked to admit a failure before
 *                  being told the thing.
 *   3. CLOSE       a warm line. After a miss the answer stays up a moment longer and
 *                  is spoken, because tone carries what text cannot.
 *
 * Nothing is marked wrong. Nothing is red. There is no score, no count, no streak
 * shown, and no indication of how many items remain.
 *
 * Three buttons rather than two, because partial recall is a real tier and
 * collapsing it into "got it" is what drives intervals up fastest — and with
 * self-report driving the schedule, that is the failure mode to design against.
 */

import * as lifecycle from './lifecycle.js';
import * as speech from './speech.js';
import { RECALL, nextInterval, capFor, insertRetest, daysToExpiry } from './training.js';

export const PROBE_ID = 'T_training';
export const TRAINING_VERSION = 1;

/** Budget per item, used to decide how many fit a slot. Generous on purpose. */
export const MS_PER_ITEM = 24000;

/**
 * The reveal button is withheld for this long.
 *
 * Without it the button can be clicked straight through without attempting retrieval,
 * and the attempt is the entire mechanism - reading the answer is not practice. The
 * delay is what makes the retrieval happen rather than merely being invited.
 *
 * Consequence for the measure: training_reveal_latency_ms is timed from the moment
 * the button BECOMES AVAILABLE, not from the prompt appearing, because otherwise
 * every value would carry a constant floor and the informative part would be the
 * excess over it. training_reveal_gate_ms records this value so the zero point stays
 * recoverable.
 */
export const REVEAL_GATE_MS = 5000;

/**
 * Nothing waits forever. Without a cap, a session left open on a prompt hangs until
 * the lifecycle watcher notices a freeze - and if the page stays visible there is no
 * freeze to notice, so it would hang indefinitely with nobody in the room.
 */
export const NO_RESPONSE_MS = 120000;

const ANSWER_DWELL_MS = 2000;
const MISS_DWELL_MS = 3400;

const el = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** How many items a slot of this length can hold. */
export function capacityFor(slotMs) {
  return Math.max(0, Math.floor(slotMs / MS_PER_ITEM));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------------------------------------------------- screens */
/**
 * Each screen is a pure function of its item, exported so that the review mode
 * renders exactly what a session renders. Duplicating this markup for review would
 * let the reviewed copy drift from the shipped copy, which would make the review
 * worse than none.
 *
 * Three tiers on every screen: a Q:/A: label, the content, then the instruction in a
 * smaller size. The screen has to explain itself, because it is arrived at with no
 * memory of the one before and there is nobody to ask.
 */
export function promptHtml(item) {
  return `
    <div class="pane train">
      <p class="train-label">Q:</p>
      <p class="lead question">${esc(item.prompt)}</p>
      <p class="instruction">Say the answer out loud to yourself.</p>
      <button class="big" data-value="reveal" id="trReveal" hidden>See if you were right</button>
    </div>`;
}

export function answerHtml(item) {
  return `
    <div class="pane train">
      <p class="train-label">Q:</p>
      <p class="sub question-small">${esc(item.prompt)}</p>
      <p class="train-label">A:</p>
      <p class="lead answer">${esc(item.answer)}</p>
      <p class="instruction">Did you get it right?</p>
      <div class="choices three">
        <button class="big" data-value="${RECALL.GOT}">Got it</button>
        <button class="big" data-value="${RECALL.PARTLY}">Partly</button>
        <button class="big" data-value="${RECALL.MISSED}">Not quite</button>
      </div>
    </div>`;
}

export function closeHtml(item, missed) {
  return `
    <div class="pane train">
      <p class="train-label">A:</p>
      <p class="lead answer">${esc(item.answer)}</p>
      <p class="instruction warm">${missed ? "That's all right. Let's remember that one."
                                           : 'Good.'}</p>
    </div>`;
}

/**
 * Waits for a click, refusing one that arrives on a stale screen, and never waiting
 * forever. Resolves { value: null } on timeout so the caller records an omission and
 * moves on rather than stalling.
 */
function awaitClick(nodes, { onStale, timeoutMs = NO_RESPONSE_MS } = {}) {
  return new Promise(resolve => {
    const hs = [];
    let timer = null;
    const done = (value, ev) => {
      if (timer) clearTimeout(timer);
      hs.forEach(([n, h]) => n.removeEventListener('click', h));
      resolve({ value, at: ev && ev.timeStamp });
    };
    nodes.forEach(n => {
      const h = ev => {
        if (lifecycle.isStale()) { if (onStale) onStale(); return; }
        done(n.dataset.value, ev);
      };
      n.addEventListener('click', h);
      hs.push([n, h]);
    });
    timer = setTimeout(() => done(null, null), timeoutMs);
  });
}

/**
 * Runs training for one slot, consuming from the session's shared queue.
 *
 * The queue is session-level rather than slot-level so an item is never asked
 * twice in one session and a missed item's re-ask can land in a later slot.
 *
 * Stops when the slot's time budget is spent, never mid-item: training fills its
 * slot and never overruns it, because session length is what the reaction-time
 * bracket measures fatigue against.
 */
export async function runSlot(session, { screenEl, stage, slotMs }) {
  const budget = capacityFor(slotMs);
  let done = 0;

  while (done < budget && session.trainingQueue.length && !session.ended) {
    const entry = session.trainingQueue.shift();
    await runOne(session, { screenEl, stage, entry, index: done });
    done++;
    if (done % 3 === 0) await session.flush();
  }
  return done;
}

async function runOne(session, { screenEl, stage, entry, index }) {
  const item = entry.item;
  const audio = !!session.config.audio_enabled;

  /* ---- 1. the question, alone, with the retrieval instruction ---- */
  //
  // Q: and A: prefixes throughout, so which is which is never in doubt on a screen
  // arrived at with no memory of the previous one. Instruction text is smaller than
  // the content it is about, so the question is what the eye lands on.
  screenEl.innerHTML = promptHtml(item);

  session.beginTrial();
  // Onset from the frame that paints the prompt, the same time base as the click.
  const promptOnset = await new Promise(r => requestAnimationFrame(t => r(t)));

  // The button appears after the gate, so there is nothing to click through. The
  // latency clock starts when it becomes available, not when the prompt appeared.
  await sleep(REVEAL_GATE_MS);
  const btn = el('trReveal');
  let revealAvailableAt = null;
  if (btn) {
    btn.hidden = false;
    btn.classList.add('fade-in');
    revealAvailableAt = await new Promise(r => requestAnimationFrame(t => r(t)));
  }
  const reveal = await awaitClick([btn].filter(Boolean),
    { onStale: () => session.veil('stale-click') });
  const revealMs = (reveal.at != null && revealAvailableAt != null)
    ? Math.max(0, Math.round(reveal.at - revealAvailableAt)) : null;

  /* ---- 2. the answer, then the self-report ---- */
  screenEl.innerHTML = answerHtml(item);

  const picked = await awaitClick(
    [...screenEl.querySelectorAll('.choices button')],
    { onStale: () => session.veil('stale-click') });
  const recall = picked.value || RECALL.OMITTED;

  /* ---- 3. close warmly. A miss is answered, never marked ---- */
  const missed = recall === RECALL.MISSED || recall === RECALL.OMITTED;
  screenEl.innerHTML = closeHtml(item, missed);

  let speechOutcome = 'not_attempted';
  if (missed && audio) {
    // Spoken only on a miss, and only the answer: the tone is the correction.
    speechOutcome = await speech.say(item.answer);
  }
  await sleep(missed ? MISS_DWELL_MS : ANSWER_DWELL_MS);

  /* ---- schedule ---- */
  const ceiling = capFor(item.max_interval_days);
  const before = Math.min(Number(item.interval_days) || 1, ceiling);
  const sched = nextInterval(before, recall, { streak: item.streak, maxDays: ceiling });

  // A re-ask never advances the schedule: it is not an independent retrieval, and
  // treating it as one would let an item climb on the strength of an echo.
  if (!entry.isRetest) {
    item.interval_days = sched.interval_days;
    item.streak = sched.streak;
    item.last_tested_ms = Date.now();
    item.exposures = (item.exposures || 0) + 1;
    session.trainingProgress.set(item.item_id, {
      item_id: item.item_id,
      interval_days: item.interval_days,
      last_tested_ms: item.last_tested_ms,
      exposures: item.exposures,
      streak: item.streak
    });
  }

  session.addTrial({
    probe_id: PROBE_ID,
    probe_version: TRAINING_VERSION,
    stage_trial_index: index,
    item_id: item.item_id,
    response: recall,
    correct: null,                     // self-report is not an objective match
    outcome_flag: recall === RECALL.OMITTED ? 'omission' : 'ok',
    speech_outcome: speechOutcome,
    response_latency_ms: picked.at != null ? Math.round(picked.at - onset) : null,
    training_recall: recall,
    training_reveal_latency_ms: revealMs,
    training_reveal_gate_ms: REVEAL_GATE_MS,
    training_interval_days: before,
    training_next_interval_days: entry.isRetest ? before : sched.interval_days,
    training_exposures: item.exposures || 0,
    training_is_retest: entry.isRetest ? 1 : 0,
    training_max_interval_days: ceiling,
    training_days_to_expiry: daysToExpiry(item, session.todayLocal)
  });

  // Errorless: bring a missed item back later so the session ends on a success.
  if (missed && !entry.isRetest) {
    session.trainingQueue = insertRetest(session.trainingQueue, 0, entry);
  }
}
