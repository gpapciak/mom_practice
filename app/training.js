/**
 * Spaced retrieval of functional content.
 *
 * This is the practice half, as distinct from the measurement half. Its content is
 * things that make a day easier to hold on to: who is in the house and when, where
 * things are kept, the shape of the day, and anything that has been asked twice.
 *
 * FOUR RULES THAT ARE NOT NEGOTIABLE
 * ----------------------------------
 * 1. ERRORLESS. The point of spaced retrieval is to be right almost every time.
 *    A miss is answered by supplying the answer warmly and shortening the interval,
 *    never by marking anything wrong. Nothing red, no X, no score. An item that
 *    fails is re-asked later in the same session so the session ends on a success.
 *
 * 2. CONTENT LIVES IN A SHEET, NOT IN CODE. One row per item: prompt, answer,
 *    interval. When clinical goals arrive, re-pointing this at them is editing rows,
 *    not a rebuild. Nothing here hardcodes a single fact.
 *
 * 3. TRAINING AND PROBE CONTENT NEVER OVERLAP. Training item ids are namespaced
 *    `t:` and pool item ids are not; assertTrainingId() refuses anything else. A
 *    trained item appearing as a probe item would make a measure of new learning
 *    into a measure of how well the training worked, which is a different question
 *    and would be unrecoverable after the fact.
 *
 * 4. PROBE POSITIONS AND SESSION LENGTH DO NOT MOVE. Training fills slots of fixed
 *    duration. It never extends a session: the reaction-time blocks bracket the
 *    session to measure fatigue, and a longer session would silently change what
 *    that measure means.
 */

import { rng, shuffle } from './rng.js';

export const PROBE_ID = 'T_training';
export const TRAINING_VERSION = 1;

/**
 * Expanding interval schedule, in days.
 *
 * Success moves one step up, a miss moves two steps DOWN rather than back to the
 * start. Resetting to zero after a single lapse is punishing in practice: it
 * produces long runs of the same item, which is boring and makes the errorless
 * property harder to hold, and a single miss is usually noise rather than loss.
 */
export const STEPS = [1, 2, 4, 7, 14, 30, 60];

/** A miss drops this many steps. */
export const MISS_DROP = 2;

/** Re-ask a missed item this many trials later, within the same session. */
export const RETEST_GAP = 3;

export function assertTrainingId(id) {
  if (typeof id !== 'string' || !id.startsWith('t:')) {
    throw new Error('training item id must be namespaced "t:" — got ' + JSON.stringify(id)
      + '. Pool items and training items must never share a namespace.');
  }
  return id;
}

/** Index into STEPS for a given interval, or -1 if it is not a step. */
export function stepOf(days) {
  return STEPS.indexOf(days);
}

/**
 * The next interval after a trial. Pure, so the schedule can be tested without a
 * session, a Sheet or a clock.
 */
export function nextInterval(currentDays, wasCorrect) {
  let i = stepOf(currentDays);
  if (i < 0) {
    // An interval a human typed that is not one of the steps. Snap to the nearest
    // step at or below it rather than rejecting the row: the Sheet is edited by
    // hand and a typo must not drop an item out of the rotation silently.
    i = 0;
    for (let k = 0; k < STEPS.length; k++) if (STEPS[k] <= currentDays) i = k;
  }
  const next = wasCorrect ? Math.min(i + 1, STEPS.length - 1)
                          : Math.max(i - MISS_DROP, 0);
  return STEPS[next];
}

/**
 * Which items are due, most overdue first.
 *
 * An item with no last_tested is due immediately: a newly added row should be
 * introduced, not wait for an interval it has never had.
 *
 * `cap` is set by how many trials fit the slot durations, never by how many are
 * due. Training expands to fill its slots and never beyond them.
 */
export function selectDue(items, nowMs, cap, seed) {
  const DAY = 86400000;
  const due = items
    .filter(it => it.active !== false)
    .map(it => {
      const last = it.last_tested_ms || null;
      const interval = Number(it.interval_days) || STEPS[0];
      const overdueDays = last === null
        ? Infinity
        : ((nowMs - last) / DAY) - interval;
      return { item: it, overdueDays };
    })
    .filter(d => d.overdueDays >= 0);

  // Most overdue first. Ties broken by a seeded shuffle rather than by Sheet row
  // order, so the same few items do not always lead.
  const next = rng(seed);
  const shuffled = shuffle(due, next);
  shuffled.sort((a, b) => b.overdueDays - a.overdueDays);
  return shuffled.slice(0, cap).map(d => d.item);
}

/**
 * Builds the running order for one session, including the errorless re-ask.
 *
 * Returns a queue the runner consumes. Misses are re-inserted RETEST_GAP trials
 * later by the runner rather than here, because whether an item was missed is not
 * known until it is asked.
 */
export function buildQueue(items, nowMs, cap, seed) {
  return selectDue(items, nowMs, cap, seed).map(it => ({
    item: it,
    isRetest: false
  }));
}

/**
 * Where a missed item goes back into the queue.
 *
 * Far enough that it is a retrieval rather than an echo, near enough that the
 * session still ends on a success.
 */
export function insertRetest(queue, position, entry) {
  const at = Math.min(position + RETEST_GAP, queue.length);
  const copy = queue.slice();
  copy.splice(at, 0, { item: entry.item, isRetest: true });
  return copy;
}

/**
 * Parses the Sheet's content rows into items.
 *
 * Tolerant by design: this tab is edited by a person, at speed, possibly on a
 * phone. A malformed row is skipped with a reason rather than breaking a session,
 * because a session that refuses to run is worse than one with fewer items.
 */
export function parseItems(rows) {
  const items = [];
  const skipped = [];
  for (const r of rows || []) {
    const id = String(r.item_id || '').trim();
    const prompt = String(r.prompt || '').trim();
    const answer = String(r.answer || '').trim();
    if (!id || !prompt || !answer) {
      skipped.push({ row: r, why: 'missing item_id, prompt or answer' });
      continue;
    }
    if (!id.startsWith('t:')) {
      skipped.push({ row: r, why: 'item_id must start with "t:"' });
      continue;
    }
    items.push({
      item_id: id,
      prompt,
      answer,
      interval_days: Number(r.interval_days) || STEPS[0],
      last_tested_ms: Number(r.last_tested_ms) || null,
      exposures: Number(r.exposures) || 0,
      streak: Number(r.streak) || 0,
      active: String(r.active || 'TRUE').toUpperCase() !== 'FALSE'
    });
  }
  return { items, skipped };
}
