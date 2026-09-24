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
import { RECALL, nextInterval, capFor, insertRetest } from './training.js';

export const PROBE_ID = 'T_training';
export const TRAINING_VERSION = 1;

/** Budget per item, used to decide how many fit a slot. Generous on purpose. */
export const MS_PER_ITEM = 18000;

const ANSWER_DWELL_MS = 1800;
const MISS_DWELL_MS = 3200;

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

/** Waits for a click, refusing one that arrives on a stale screen. */
function awaitClick(nodes, onStale) {
  return new Promise(resolve => {
    const hs = [];
    const done = (value, ev) => {
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

  /* ---- 1. the prompt, alone ---- */
  screenEl.innerHTML = `
    <div class="pane train">
      <p class="lead">${esc(item.prompt)}</p>
      <button class="big" data-value="reveal" id="trReveal">Show me</button>
    </div>`;

  session.beginTrial();
  // Onset from the frame that paints the prompt, the same time base as the click.
  const onset = await new Promise(r => requestAnimationFrame(t => r(t)));
  const reveal = await awaitClick([el('trReveal')], () => session.veil('stale-click'));
  const revealMs = reveal.at != null ? Math.round(reveal.at - onset) : null;

  /* ---- 2. the answer, then the self-report ---- */
  screenEl.innerHTML = `
    <div class="pane train">
      <p class="sub">${esc(item.prompt)}</p>
      <p class="lead answer">${esc(item.answer)}</p>
      <div class="choices three">
        <button class="big" data-value="${RECALL.GOT}">Got it</button>
        <button class="big" data-value="${RECALL.PARTLY}">Partly</button>
        <button class="big" data-value="${RECALL.MISSED}">Not quite</button>
      </div>
    </div>`;

  const picked = await awaitClick(
    [...screenEl.querySelectorAll('.choices button')],
    () => session.veil('stale-click'));
  const recall = picked.value || RECALL.OMITTED;

  /* ---- 3. close warmly. A miss is answered, never marked ---- */
  const missed = recall === RECALL.MISSED || recall === RECALL.OMITTED;
  screenEl.innerHTML = `
    <div class="pane train">
      <p class="sub">${esc(item.prompt)}</p>
      <p class="lead answer">${esc(item.answer)}</p>
      <p class="sub warm">${missed ? "That's all right. Let's remember that one."
                                   : 'Good.'}</p>
    </div>`;

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
    training_interval_days: before,
    training_next_interval_days: entry.isRetest ? before : sched.interval_days,
    training_exposures: item.exposures || 0,
    training_is_retest: entry.isRetest ? 1 : 0,
    training_max_interval_days: ceiling
  });

  // Errorless: bring a missed item back later so the session ends on a success.
  if (missed && !entry.isRetest) {
    session.trainingQueue = insertRetest(session.trainingQueue, 0, entry);
  }
}
