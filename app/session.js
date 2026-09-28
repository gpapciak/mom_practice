/**
 * The session: a state machine over the nine stages, plus the screens.
 *
 * Probes A, B and C are stubbed in this version. What is real here is the part
 * most likely to force a redesign and therefore built first: the lifecycle, the
 * local writes, the outbox, and the geometry. The stubs hold the stage sequence
 * and their real durations so that timing can be exercised end to end.
 *
 * SCREEN RULES, which are requirements and not style
 * --------------------------------------------------
 * - Every screen makes sense on its own. The user cannot carry an instruction
 *   from one screen to the next, so nothing refers back to a previous screen.
 * - One thing at a time. No progress bar, no timer, no counter, no navigation, no
 *   menus, no reachable settings.
 * - No score, ever. Not a percentage, not a streak, not a trial count, not
 *   "7 of 10". A daily activity that reports how much someone cannot remember is
 *   a daily reminder that they cannot remember.
 * - Errors are absorbed, never marked. Nothing red, no X, no buzzer.
 * - Mouse only: no dragging, no double-clicks, no hover-dependent behaviour, no
 *   scrolling, no typing.
 * - Adult in tone throughout.
 */

import { APP_VERSION, DEFAULTS } from './config.js';
import * as store from './store.js';
import * as layout from './layout.js';
import * as speech from './speech.js';
import * as upload from './upload.js';
import * as lifecycle from './lifecycle.js';
import * as crt from './probe_crt.js';
import * as train from './probe_training.js';
import * as training from './training.js';
import * as filler from './filler.js';
import { localDateFor, localTimeFor } from './dates.js';
import { rng } from './rng.js';
import * as screens from './screens.js';

/**
 * THE SESSION SKELETON. Frozen from the first collected row.
 *
 * The durations, and the positions of the two reaction-time blocks, are the
 * instrument. `crt_2 - crt_1` is the fatigue measure, and it means something only
 * while the blocks sit at the same points in the same-length session every day.
 *
 * What changes between phases is only WHICH stage occupies a slot:
 *
 *   phase 1 (now)   training occupies the Probe B and C slots. The two dedicated filler
 *                   slots have NO phase-1 occupant and are skipped, and training slots
 *                   are NOT padded out - so the session is as long as the content
 *                   needs, about four to six minutes.
 *   phase 2 (later) the probes take their slots back, training moves to the fillers as
 *                   originally designed, and the slots are padded to fixed durations
 *                   again because the retention delays have to be real.
 *
 * WHY PHASE 1 IS NOT PADDED, WHICH IS NOT A CONCESSION
 * ---------------------------------------------------
 * The original design held every slot to a fixed duration so that crt_1 and crt_2 sat at
 * identical elapsed times in every session. That is the right instinct and it is what
 * makes the phase change cheap.
 *
 * But it was never supportable at this size. The non-CRT slots total 475s, which is
 * capacity for about 19 training items. Spaced retrieval cannot supply that: items settle
 * onto intervals of two to three weeks, so each one comes due roughly every 17 days, and
 * having 19 due on the same day needs a pool of something like 130 to 320 items. With a
 * realistic pool of a few dozen, two to four items come due on a typical day.
 *
 * So at 10.5 minutes the session was ALWAYS going to be mostly padding, whatever content
 * anybody wrote - and padding in phase 1 is an empty screen, because there is no retention
 * interval for it to protect. Watching a real session made that plain: roughly six of ten
 * minutes with nothing happening, twice interrupted by a screen that said as much.
 *
 * Shortening it is therefore a correction to a size that could not work, not a compromise
 * on the measurement. Read the other way round, the 10.5-minute session was the
 * compromise: it traded the willingness the whole design depends on for a fixed elapsed
 * position it could not fill.
 *
 * THE COST, STATED
 * ----------------
 * crt_2 now sits at a variable elapsed time, because the training slots are as long as
 * the content. So `crt_2 - crt_1` is no longer a fixed-interval fatigue measure: it must
 * be normalised by the actual elapsed gap between the blocks, which every row already
 * carries in `ms_since_session_start`. That is an analysis choice, not a code change -
 * see 10-analysis-plan.md.
 *
 * The phase-1 fatigue baseline therefore does not transfer to phase 2, where padding
 * returns and the gap is fixed. Compared within phase, not across it. Accepted
 * deliberately: a shape that gets abandoned in week three measures nothing at all.
 */
export const SKELETON = [
  { slot: 'opening', ms: 100000, phase1: 'training_1', phase2: 'opening_recognition' },
  { slot: 'crt_1',   ms: null,   phase1: 'crt_1',      phase2: 'crt_1' },
  { slot: 'encode',  ms: 110000, phase1: 'training_2', phase2: 'encoding' },
  // No phase-1 occupant: in phase 1 there is no retention interval to protect, so this
  // slot would be an empty screen held open for nothing. Skipped entirely.
  { slot: 'fill_1',  ms: 75000,  phase1: null,         phase2: 'training_1' },
  { slot: 'recog_s', ms: 50000,  phase1: 'training_3', phase2: 'recognition_short' },
  { slot: 'fill_2',  ms: 90000,  phase1: null,         phase2: 'training_2' },
  { slot: 'recog_m', ms: 50000,  phase1: 'training_4', phase2: 'recognition_medium' },
  { slot: 'crt_2',   ms: null,   phase1: 'crt_2',      phase2: 'crt_2' }
];

/** Frozen stage names. Filler produces no trial rows. */
export const STAGES = [
  'greeting', 'company_question',
  'opening_recognition', 'crt_1', 'encoding',
  'filler_1', 'recognition_short', 'filler_2', 'recognition_medium',
  'crt_2', 'close',
  'training_1', 'training_2', 'training_3', 'training_4',
  // Unscored warm-up. Excluded from Probe A by stage name rather than by a flag, so
  // they cannot be pooled by anyone who forgets to filter. Both blocks get them:
  // warming only the first would make crt_2 minus crt_1 a mixture of fatigue and
  // warm-up rather than fatigue alone.
  'crt_1_practice', 'crt_2_practice'
];

/** Total training time available in a phase, used to size the due-item queue. */
export function trainingBudgetMs(phase) {
  return SKELETON
    .filter(sl => String(sl[phase] || '').startsWith('training'))
    .reduce((n, sl) => n + (sl.ms || 0), 0);
}

const el = id => document.getElementById(id);
const screen = () => el('screen');

/* ---------------------------------------------------------------- helpers */

// Date handling lives in dates.js: the fixed day boundary and the three shapes a
// spreadsheet date can arrive in are the same problem everywhere they appear.
export { localDateFor, localTimeFor } from './dates.js';

/** Resolves after ms, and reports whether it was interrupted. */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits for a click on one of the given elements; resolves { value, event }.
 *
 * A click arriving while the page is STALE is refused, not recorded. Between the
 * machine waking and the heartbeat noticing, the previous screen is still on
 * display with live handlers under it - exactly what someone would try to answer -
 * and accepting that click would write a real-looking trial row whose latency is
 * however long the lid was shut. The refusal is silent to the user: the veil goes
 * up and the detector decides what happens next.
 */
function choose(nodes, opts) {
  const onStale = opts && opts.onStale;
  return new Promise(resolve => {
    const handlers = [];
    const done = (value, event) => {
      handlers.forEach(([n, h]) => n.removeEventListener('click', h));
      resolve({ value, event });
    };
    nodes.forEach(n => {
      const h = ev => {
        if (lifecycle.isStale()) {
          if (onStale) onStale();
          return;                 // refuse; the watcher will classify the gap
        }
        done(n.dataset.value, ev);
      };
      n.addEventListener('click', h);
      handlers.push([n, h]);
    });
  });
}

/* ---------------------------------------------------------------- Session */

export class Session {
  constructor({ config, debug, dry, openedAt }) {
    this.config = Object.assign({}, DEFAULTS, config || {});
    this.debug = !!debug;
    /** A dry run does everything except persist. For rehearsing on the real machine. */
    this.dry = !!dry;

    this.uid = store.uuid();
    /*
     * PAGE LOAD, not the Start click.
     *
     * Passed in, because the Session is constructed by the Start handler - so
     * `Date.now()` here was the moment Start was pressed, which made
     * `ms_open_before_start` the duration of prepare(): a few tens of milliseconds,
     * every session.
     *
     * The schema defines that column as how long the opening screen was looked at,
     * with an upward drift being a hesitation signal. A hesitation signal reading ~0
     * forever is worse than an absent one, because it looks populated and nobody goes
     * looking. Time-to-start is one of the more interesting behavioural numbers this
     * table can hold, so it is worth measuring from the right instant.
     */
    this.openedAt = openedAt || Date.now();
    this.startedAt = null;
    this.stage = 'open';
    this.trialBuffer = [];
    this.trialIndex = 0;
    this.nTrials = 0;
    this.company = 'unknown';
    this.speechOutcome = 'not_attempted';
    this.greetingFired = false;
    this.aborted = null;
    this.ended = false;

    // Interruption accounting, deliberately split in two.
    //
    // preMs/preN  accumulate between trials: an interruption there contaminates a
    //             retention INTERVAL, and lands in pre_trial_interruption_*.
    // duringMs    accumulates while a trial is open: that contaminates the
    //             RESPONSE, lands in hidden_ms, and is the only one of the two that
    //             flags the row aborted.
    //
    // Conflating them was a real bug in the first version of this file: a lid
    // closure during a retention interval flagged the following recognition
    // response as aborted, when the response was fine and only the delay was
    // contaminated.
    this.preMs = 0;
    this.preN = 0;
    this.duringMs = 0;
    this.duringN = 0;
    this.trialOpen = false;
    this.veiled = false;

    // Probes B and C are not built yet, so this is phase 1. Derived rather than
    // configured: when they exist, this flips by itself and no flag can be left
    // stale. The phase is also recoverable from the data - a session either has
    // B_recognition rows or it does not - so nothing depends on trusting it.
    this.phase = 'phase1';
    this.trainingQueue = [];
    this.trainingProgress = new Map();

    const g = layout.apply();
    this.stagePx = g.u;
    this.vp = g.vp;
  }

  /* ---------------- lifecycle wiring ---------------- */

  /**
   * An interruption shorter than the abandon threshold. The gap is carried to the
   * next trial written, so a pause lands on the trial it actually affected, and
   * nothing is discarded at collection time.
   */
  onInterruption(ms, source) {
    if (this.trialOpen) {
      this.duringMs += ms;
      this.duringN++;
    } else {
      this.preMs += ms;
      this.preN++;
    }
    const where = this.trialOpen ? 'a trial' : 'an interval';
    this.log('interruption ' + Math.round(ms) + 'ms (' + source + ') during '
             + where + ' - resuming in place');
    this.unveil();
  }

  /**
   * Makes the screen unanswerable immediately, before the interruption has been
   * classified. Cheap, idempotent, and removed again only if the session resumes.
   */
  veil(source) {
    if (this.veiled) return;
    this.veiled = true;
    const v = el('veil');
    if (v) v.hidden = false;
    this.log('veiled (' + source + ')');
  }

  unveil() {
    if (!this.veiled) return;
    this.veiled = false;
    const v = el('veil');
    if (v) v.hidden = true;
  }

  /** Over the threshold: the session is over. Keep everything, upload, reset. */
  async onAbandon(ms, source) {
    if (this.ended) return;
    this.log(`abandoned after ${Math.round(ms / 1000)}s hidden (${source})`);
    speech.cancel();
    this.aborted = { ms, source };
    this.veil('abandon');
    await this.end('abandoned_hidden');
    if (this.onReset) this.onReset();
  }

  async onHide() {
    await this.flush();
    // Best effort, outside any timed task. COLLECTING gates the actual POST.
    upload.drain().catch(() => {});
    // AND a beacon, because going hidden is often the lid closing, and a fetch in
    // flight when the page is frozen is simply dropped. The beacon survives that;
    // nothing is deleted on the strength of it, so a duplicate is the worst case and
    // the endpoint's ledger absorbs those.
    upload.beaconOutbox().catch(() => {});
  }

  /* ---------------- rows ---------------- */

  /** Session-level fields denormalised onto every trial row. */
  sessionContext() {
    return {
      schema_version: 1,
      app_version: APP_VERSION,
      device_id: this.deviceId,
      session_uid: this.uid,
      session_seq: this.seq,
      session_date_local: localDateFor(this.startedAt || this.openedAt),
      session_start_utc: this.startedAt,
      tz_offset_min: new Date().getTimezoneOffset(),
      days_since_prev_session: this.daysSincePrev,
      company_reported: this.company,
      audio_enabled: !!this.config.audio_enabled,
      speech_outcome: 'not_attempted',
      config_version: Number(this.config.config_version) || 1,
      viewport_w: this.vp.w,
      viewport_h: this.vp.h,
      dpr: this.vp.dpr,
      visual_viewport_scale: this.vp.scale,
      stage_px: this.stagePx,
      rng_seed: this.seed
    };
  }

  /**
   * Opens a trial. Everything accumulated since the previous trial closed is now
   * this trial's PRE-interval figure, and further interruptions count against the
   * trial itself.
   *
   * Probes call beginTrial() at stimulus onset and addTrial() once the response is
   * in, so the split between a contaminated interval and a contaminated response is
   * made at collection time rather than guessed at later.
   */
  beginTrial() {
    this.trialOpen = true;
    this.duringMs = 0;
    this.duringN = 0;
    return { preMs: Math.round(this.preMs), preN: this.preN };
  }

  /**
   * Buffers a trial row and closes the trial. Flushed in the inter-trial interval,
   * never mid-trial.
   *
   * Only an interruption DURING the trial flags it aborted, because only that makes
   * the latency meaningless. An interruption during the preceding interval is
   * recorded in pre_trial_interruption_ms and leaves the response alone. Nothing is
   * discarded either way: trimming is an analysis decision, made later, from raw
   * rows.
   */
  addTrial(fields) {
    const pre = { ms: Math.round(this.preMs), n: this.preN };
    const during = { ms: Math.round(this.duringMs), n: this.duringN };
    this.preMs = 0; this.preN = 0;
    this.duringMs = 0; this.duringN = 0;
    this.trialOpen = false;

    const row = Object.assign(this.sessionContext(), {
      trial_uid: store.uuid(),
      trial_index: this.trialIndex++,
      stage: this.stage,
      ms_since_session_start: Date.now() - this.startedAt,
      hidden_ms: during.ms,
      pre_trial_interruption_ms: pre.ms,
      pre_trial_interruption_n: pre.n
    }, fields);

    if (during.ms > 0 && !fields.outcome_flag) row.outcome_flag = 'aborted';
    this.trialBuffer.push(row);
    this.nTrials++;
    return row;
  }

  async flush() {
    if (!this.trialBuffer.length) return;
    const rows = this.trialBuffer;
    this.trialBuffer = [];
    if (this.dry) {
      // Held in memory so the batch builder still sees them at the end.
      this.dryTrials = (this.dryTrials || []).concat(rows);
      this.log(`dry run: holding ${rows.length} trial row(s) in memory`);
      return;
    }
    await store.putTrials(rows);
  }

  sessionRow(endReason) {
    const now = Date.now();
    return {
      session_uid: this.uid,
      schema_version: 1,
      app_version: APP_VERSION,
      device_id: this.deviceId,
      session_seq: this.seq,
      session_date_local: localDateFor(this.startedAt || this.openedAt),
      opened_at_utc: this.openedAt,
      start_pressed_at_utc: this.startedAt,
      ended_at_utc: now,
      ms_open_before_start: this.startedAt ? this.startedAt - this.openedAt : null,
      // Task duration, from Start. Deliberately NOT from page load: session length is
      // what the reaction-time bracket interprets fatigue against, and idle time on the
      // opening screen is not part of the task. The pre-Start wait is carried by
      // ms_open_before_start instead, so the two sum to the whole visit.
      total_ms: now - (this.startedAt || this.openedAt),
      hidden_total_ms: this.watcher ? this.watcher.hiddenTotalMs() : 0,
      end_reason: endReason,
      last_stage_reached: this.stage,
      n_trials: this.nTrials,
      days_since_prev_session: this.daysSincePrev,
      company_reported: this.company,
      audio_enabled: !!this.config.audio_enabled,
      greeting_speech_fired: this.greetingFired,
      speech_voices_n: speech.voiceCount(),
      speech_voice: speech.voiceName(),
      config_version: Number(this.config.config_version) || 1,
      tz_offset_min: new Date().getTimezoneOffset(),
      local_time_of_day: localTimeFor(this.startedAt || this.openedAt),
      viewport_w: this.vp.w,
      viewport_h: this.vp.h,
      dpr: this.vp.dpr,
      visual_viewport_scale: this.vp.scale,
      stage_px: this.stagePx,
      zoom_drift_flag: this.driftFlag || 'none',
      screen_w: window.screen.width,
      screen_h: window.screen.height,
      ua_string: navigator.userAgent,
      storage_persisted: !!this.persisted,
      // Which route this came from. The Dock app and a Safari tab are separate
      // storage containers, so the same machine presents as two devices; nothing
      // else on the row tells them apart.
      display_mode: layout.displayMode(),
      uploaded_at_utc: null,     // stamped by the endpoint, never by the client
      batch_id: null
    };
  }

  /* ---------------- boot ---------------- */

  async prepare() {
    this.deviceId = await store.deviceId();
    this.persisted = await store.requestPersistence();
    this.seq = (await store.peekSessionSeq()) + 1;
    this.seed = `s${this.seq}-${this.uid.slice(0, 8)}`;

    /*
     * Does Probe A run this session? Every Nth, counted in sessions.
     *
     * Decided once here rather than asked per slot, so crt_1 and crt_2 can never
     * disagree - a session with one block and not the other would give a fatigue
     * measure with nothing to subtract.
     */
    const everyN = Math.max(1, Number(this.config.crt_every_n_sessions) || 1);
    this.crtThisSession = (this.seq % everyN) === 1 % everyN;

    const prev = await store.lastSessionWithTrials();
    this.daysSincePrev = prev && prev.start_pressed_at_utc
      ? +((this.openedAt - prev.start_pressed_at_utc) / 86400000).toFixed(4)
      : null;

    const history = (await store.getMeta('stage_px_history', [])) || [];
    this.driftFlag = layout.driftFlag(this.stagePx, history);
    // A dry run must leave no trace. It previously bumped this and the session
    // counter, which meant the rehearsal path was not quite the real one - and the
    // rehearsal path is the only way anything gets tested by hand.
    if (!this.dry) {
      await store.setMeta('stage_px_history', history.concat([this.stagePx]).slice(-30));
    }

    /*
     * START WAS PRESSED. Record that here, before the snapshot below.
     *
     * prepare() only ever runs from the Start handler, so by the time this line
     * executes the button has already been clicked. `startedAt` used to be assigned
     * later, in run() - AFTER this snapshot - so the snapshot recorded
     * start_pressed_at_utc as null.
     *
     * That was not merely untidy. If the page was then closed hard, the next boot's
     * reconcile read this stale snapshot, saw a null start time, and concluded the
     * session had NEVER STARTED - so a session that was begun and abandoned was
     * indistinguishable in the record from one that was opened and never begun. The
     * first two rows ever collected were mislabelled exactly that way, and
     * `abandoned_closed` could essentially never occur.
     *
     * Those are opposite behaviours with opposite causes: one is an interruption, the
     * other is a failure to initiate, and telling them apart is the whole point of
     * watching initiation at all.
     */
    if (this.startedAt === null) this.startedAt = Date.now();

    // Written before the session proper, so a session begun and then interrupted hard
    // enough that no code of ours runs again is still on the record. The reconcile on
    // the next boot turns this into abandoned_closed, because start_pressed_at_utc is
    // now correctly set.
    if (!this.dry) await store.putSession(this.sessionRow('never_started'));
  }

  /* ---------------- the run ---------------- */

  async run() {
    // In a dry run the counter is read, not advanced: a rehearsal should not consume
    // a session number that the real series will then be missing.
    this.seq = this.dry ? (await store.peekSessionSeq()) + 1
                        : await store.nextSessionSeq();
    if (this.startedAt === null) this.startedAt = Date.now();

    // Built once per session, not per slot, so an item is never asked twice in a
    // session and a missed item's re-ask can land in a later slot. Sized by the
    // phase's total training time: training fills its slots and never overruns them.
    const cap = train.capacityFor(trainingBudgetMs(this.phase));
    this.todayLocal = localDateFor(this.startedAt);
    this.trainingQueue = training.buildQueue(
      this.trainingItems || [], Date.now(), cap, this.seed + ':training', this.todayLocal);
    this.log(`training: ${this.trainingQueue.length} due of ${(this.trainingItems || []).length}`
             + `, cap ${cap}`);

    // Expiry is only half the job. An item that silently vanishes is the same kind of
    // silent failure as one that silently goes stale, so what fired and what is about
    // to fire both get recorded where a human will see them.
    this.contentNotices = training.contentNotices(this.trainingItems || [], this.todayLocal);
    if (this.contentNotices.expired.length) {
      this.log(`content EXPIRED: ${this.contentNotices.expired.join(', ')}`);
    }
    if (this.contentNotices.expiring.length) {
      this.log('content expiring soon: '
        + this.contentNotices.expiring.map(e => `${e.item_id} in ${e.days}d`).join(', '));
    }

    this.watcher = lifecycle.watch({
      getState: () => ({ session_uid: this.uid, stage: this.stage }),
      onInterruption: (ms, src) => this.onInterruption(ms, src),
      onAbandon: (ms, src) => this.onAbandon(ms, src),
      onSuspend: src => this.veil(src),
      onHide: () => this.onHide()
    });

    try {
      await this.doGreeting();
      if (this.ended) return;
      await this.doCompanyQuestion();
      if (this.ended) return;

      for (const slot of SKELETON) {
        if (this.ended) return;
        // A slot with no occupant in this phase does not exist in this phase.
        if (!slot[this.phase]) continue;
        // Probe A only on its own sessions. Both blocks or neither.
        if (slot.slot.startsWith('crt') && !this.crtThisSession) continue;
        this.stage = slot[this.phase];
        await this.doStage(this.stage, slot);
        await this.flush();          // stage boundary: dead time, safe to write
      }

      if (this.ended) return;
      this.stage = 'close';
      await this.doClose();
      await this.end('completed');
    } catch (e) {
      this.log('error: ' + (e && e.message));
      /*
       * THE MESSAGE HAS TO LEAVE THE DEVICE.
       *
       * `end_reason: error` used to be the whole of what was recorded: the message went
       * to the debug pane, which is unreachable in a Dock web app - no address bar, so no
       * ?debug=1 - and which nobody is watching from another country anyway. A session
       * that fails with no reason attached is a bug report with the bug removed.
       *
       * Queued before end() so it travels in the same batch as the failed session's row,
       * and the first stack frame is included because the message alone rarely says which
       * of a stage's several awaits it came from.
       */
      // A prefix of the stack rather than one parsed line: no escapes to get wrong,
      // and more context for the same handful of characters.
      const frame = String((e && e.stack) || '').slice(0, 240);
      await store.queueEvent('session_error',
        `stage=${this.stage}; ${(e && e.name) || 'Error'}: ${(e && e.message) || e}`
        + `; at ${frame.trim().slice(0, 160)}`);
      await this.end('error');
      throw e;
    }
  }

  async end(reason) {
    if (this.ended) return;
    this.ended = true;
    // Kept so the caller can tell a completed session from an abandoned one without
    // re-reading the row. What is shown next depends on it: see main.js.
    this.endReason = reason;
    if (this.watcher) this.watcher.stop();
    await this.flush();

    const sessionRow = this.sessionRow(reason);

    if (this.dry) {
      // Everything a real session does, right up to persisting, so the rehearsal
      // exercises the same code: the batch is built and the notices are computed,
      // then thrown away. Doing less here would mean the rehearsal could pass while
      // the real path failed.
      const events = await this.contentEvents({ record: false });
      const batch = upload.buildBatch(this.dryTrials || [], [sessionRow], events);
      this.log(`dry run: built a batch of ${batch.trials.rows.length} trial row(s), `
               + `${events.length} event(s), and discarded it`);
      lifecycle.clearAlive();
      return;
    }

    const rows = await store.trialsForSession(this.uid);
    await store.putSession(sessionRow);
    // Only a COMPLETED session closes the day. An abandoned one must never block a
    // retry: the commonest reason to abandon is something going wrong.
    if (reason === 'completed') {
      await store.setMeta('last_completed_date',
        this.todayLocal || localDateFor(this.startedAt || this.openedAt));
    }
    // Content notices from this session, plus anything queued earlier that had no
    // batch to travel in - an eviction detected at boot, a batch quarantined on a
    // previous drain.
    const events = (await this.contentEvents()).concat(await store.takeQueuedEvents());
    await upload.enqueue(rows, [sessionRow], events);

    lifecycle.clearAlive();
    // After the closing screen is already up, so never in a timed path.
    upload.drain().catch(() => {});

    // The schedule write-back is NOT gated by COLLECTING: that flag protects the
    // canonical trial tables from placeholder data, and has nothing to do with
    // whether the practice half advances. Without this every item would stay at its
    // starting interval forever and it would stop being spaced retrieval at all.
    if (this.trainingProgress.size && !this.dry) {
      upload.postTrainingProgress([...this.trainingProgress.values()])
        .then(r => this.log('training progress: ' + JSON.stringify(r)))
        .catch(() => {});
    }
    this.log(`session ended: ${reason}, ${this.nTrials} trials`);
  }

  /* ---------------- screens ---------------- */

  /**
   * The greeting is spoken HERE, on the far side of the START click, because
   * Safari silently drops speak() before a user gesture. Spoken on page load it
   * would never be heard, while the config setting would have recorded audio as
   * working.
   */
  async doGreeting() {
    this.stage = 'greeting';
    screen().innerHTML = screens.greetingHtml(this.config);
    this.checkFits('greeting');

    if (this.config.audio_enabled) {
      const warm = await speech.warm();
      this.log(`voices ${warm.voices}, using ${warm.voice}`);
      const outcome = await speech.say(screens.greetingSpeech(this.config));
      this.speechOutcome = outcome;
      this.greetingFired = outcome === 'fired';
      this.log('greeting speech: ' + outcome);
    }
    await wait(1200);
  }

  /**
   * Asked once, here rather than on the opening screen: the first thing shown
   * should be a warm greeting and one button, not a question about company.
   * A session done with someone present and one done alone are different
   * measurements.
   */
  async doCompanyQuestion() {
    this.stage = 'company_question';
    screen().innerHTML = screens.companyHtml();
    this.checkFits('company_question');
    const picked = await choose([...screen().querySelectorAll('.choices button')],
      { onStale: () => this.veil('stale-click') });
    this.company = picked.value || 'unknown';
    this.log('company: ' + this.company);
  }

  /**
   * Probe stubs. Real durations so the lifecycle and timing paths are exercised;
   * no trial rows, because no probe ran and a placeholder row would be
   * indistinguishable from real data later.
   */
  async doStage(stage, slot) {
    // Probe A. The two blocks are identical in every parameter and differ only in
    // when they occur: their difference is the fatigue measure.
    if (stage === 'crt_1' || stage === 'crt_2') {
      await crt.run(this, { screenEl: screen(), seed: this.seed + ':' + stage });
      this.checkFits(stage);
      return;
    }

    const slotMs = this.debug ? Math.min(slot.ms || 0, 20000) : (slot.ms || 0);

    if (stage.startsWith('training')) {
      const started = Date.now();
      const n = await train.runSlot(this, { screenEl: screen(), stage, slotMs });
      this.checkFits(stage);
      this.log(`${stage}: ${n} items, ${this.trainingQueue.length} left in queue`);

      /*
       * THE SLOT MUST CONSUME ITS DURATION, and must not exceed it either.
       *
       * The floor: without padding, a day with few items due ends the slot early, every
       * later stage arrives early, and crt_2 moves - which destroys the one thing the
       * skeleton exists to guarantee. With 12 items against a 310s budget that was about
       * 94 seconds of drift, varying day to day with how many were due.
       *
       * The ceiling: a slot can also run LONG, because an item already begun cannot be
       * abandoned mid-thought. probe_training now refuses to start an item it cannot
       * finish, which bounds the overrun to one item, but does not eliminate it.
       *
       * So overrun is carried as a debt and paid out of later slots' padding. What has
       * to stay fixed is crt_2's position in the session, not each slot's individual
       * length - so as long as the training slots together fit their combined budget,
       * the fatigue measure is untouched. Residual debt at the end is logged rather
       * than hidden, because a session that genuinely ran long is a session whose
       * crt_2 means something slightly different.
       */
      const elapsed = Date.now() - started;
      this.slotDebtMs = (this.slotDebtMs || 0) + Math.max(0, elapsed - slotMs);

      /*
       * PHASE 1 DOES NOT PAD. There is no retention interval to protect, so padding would
       * hold an empty screen open for no reason - which is most of what the session used
       * to be. The slot duration still acts as a CEILING on how many items are presented,
       * via capacityFor(), so a day with many items due cannot produce a fifteen-minute
       * session. It just no longer acts as a floor.
       *
       * The cost is that crt_2's elapsed position varies with the content, so the fatigue
       * measure is normalised by the actual gap rather than assumed constant.
       */
      if (this.phase === 'phase1') return;

      let left = slotMs - elapsed;
      if (left > 0 && this.slotDebtMs > 0) {
        const paid = Math.min(left, this.slotDebtMs);
        this.slotDebtMs -= paid;
        left -= paid;
        this.log(`${stage}: absorbed ${Math.round(paid / 1000)}s of earlier overrun`);
      }
      if (left > 1500) {
        this.log(`${stage}: padding ${Math.round(left / 1000)}s to hold the slot`);
        await this.runFiller(stage, left);
      }
      if (this.slotDebtMs > 1500) {
        this.log(`${stage}: ${Math.round(this.slotDebtMs / 1000)}s of overrun still owed`);
      }
      return;
    }

    await this.runFiller(stage, slotMs);
  }

  /** Filler content. Never a bare heading: see filler.js for why. */
  async runFiller(stage, ms) {
    if (ms <= 0) return;
    await filler.run({
      screenEl: screen(),
      ms,
      rand: rng(this.seed + ':filler:' + stage),
      photos: this.photos || null
    });
    this.checkFits(stage + '_filler');
  }

  /** Warm, brief, no summary of performance. */
  async doClose() {
    screen().innerHTML = screens.closeHtml(this.config);
    this.checkFits('close');
    await wait(3000);
  }

  /**
   * Checks that whatever just rendered fits the vertical budget.
   *
   * The session must never scroll, and an overflowing screen is worse than an ugly
   * one: part of the stimulus is simply absent and nothing says so. Enforced rather
   * than assumed, which is what allows the geometry to be declared final before
   * every screen has been built by hand.
   */
  checkFits(label) {
    const pane = screen().querySelector('.pane, .crt') || screen().firstElementChild;
    const m = layout.measureScreen(pane, this.stagePx);
    if (!m.fits) {
      this.overflows = (this.overflows || []).concat([{ label, ...m }]);
      this.log(`SCREEN OVERFLOW ${label}: ${m.extentU}u, ${m.overflowPx}px over budget`);
    }
    if (m.extentU > (this.maxExtentU || 0)) this.maxExtentU = m.extentU;
    return m;
  }

  /**
   * Content notices, as rows for the _events tab.
   *
   * Written where a human already looks - the Sheet - because the point is to prompt
   * an edit, not to sit in a log nobody opens. What is needed on the 3rd is not an
   * absent row but "write: Chris is here until the 9th".
   *
   * Deduplicated per item per local date. An expiring item would otherwise report
   * itself every session for three days running, and a noisy list is one nobody
   * reads, which defeats the whole purpose of surfacing it.
   */
  async contentEvents({ record = true } = {}) {
    const n = this.contentNotices;
    if (!n) return [];
    const seen = (await store.getMeta('notice_log', {})) || {};
    const today = this.todayLocal;
    const rows = [];

    const once = (key, type, detail) => {
      if (seen[key] === today) return;
      seen[key] = today;
      rows.push([Date.now(), 'client', type, detail]);
    };

    for (const id of n.expired) {
      once(`${id}:expired`, 'training_expired',
        `${id} passed its expires_on and is no longer being practised. `
        + `Replace the row with one that is true now.`);
    }
    for (const e of n.expiring) {
      once(`${e.item_id}:expiring:${e.days}`, 'training_expiring_soon',
        `${e.item_id} expires in ${e.days} day(s). Write its replacement before then.`);
    }
    for (const id of n.notYet) {
      once(`${id}:not_yet`, 'training_not_yet_started',
        `${id} is queued and starts on its starts_on date.`);
    }

    // Keep the ledger from growing without bound; only recent keys matter.
    const keys = Object.keys(seen);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete seen[k];
    }
    if (record) await store.setMeta('notice_log', seen);
    return rows;
  }

  log(msg) {
    if (!this.debug) return;
    const box = el('debug');
    if (!box) return;
    const t = ((Date.now() - (this.startedAt || this.openedAt)) / 1000).toFixed(1);
    box.textContent = `[${t}s] ${this.stage}: ${msg}\n` + box.textContent;
  }
}


