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

import { APP_VERSION, DEFAULTS, TIMING, TIMEZONE } from './config.js';
import * as store from './store.js';
import * as layout from './layout.js';
import * as speech from './speech.js';
import * as upload from './upload.js';
import * as lifecycle from './lifecycle.js';

/** Frozen stage names. Filler produces no trial rows. */
export const STAGES = [
  'greeting', 'company_question',
  'opening_recognition', 'crt_1', 'encoding',
  'filler_1', 'recognition_short', 'filler_2', 'recognition_medium',
  'crt_2', 'close'
];

const el = id => document.getElementById(id);
const screen = () => el('screen');

/* ---------------------------------------------------------------- helpers */

/**
 * The local date, computed in a fixed timezone rather than from the device's own
 * setting, so a laptop timezone change cannot silently shift the day boundary.
 */
export function localDateFor(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ms));
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export function localTimeFor(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));
}

/** Resolves after ms, and reports whether it was interrupted. */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Waits for a click on one of the given elements; resolves with its value. */
function choose(nodes) {
  return new Promise(resolve => {
    const handlers = [];
    const done = value => {
      handlers.forEach(([n, h]) => n.removeEventListener('click', h));
      resolve(value);
    };
    nodes.forEach(n => {
      const h = () => done(n.dataset.value);
      n.addEventListener('click', h);
      handlers.push([n, h]);
    });
  });
}

/* ---------------------------------------------------------------- Session */

export class Session {
  constructor({ config, debug }) {
    this.config = Object.assign({}, DEFAULTS, config || {});
    this.debug = !!debug;

    this.uid = store.uuid();
    this.openedAt = Date.now();
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
    this.pendingHiddenMs = 0;

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
    this.pendingHiddenMs += ms;
    this.log(`interruption ${Math.round(ms)}ms (${source}) — resuming in place`);
  }

  /** Over the threshold: the session is over. Keep everything, upload, reset. */
  async onAbandon(ms, source) {
    if (this.ended) return;
    this.log(`abandoned after ${Math.round(ms / 1000)}s hidden (${source})`);
    speech.cancel();
    this.aborted = { ms, source };
    await this.end('abandoned_hidden');
    if (this.onReset) this.onReset();
  }

  async onHide() {
    await this.flush();
    // Best effort, outside any timed task. COLLECTING gates the actual POST.
    upload.drain().catch(() => {});
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
      hidden_ms: 0,
      rng_seed: this.seed
    };
  }

  /**
   * Buffers a trial row. Flushed in the inter-trial interval, never mid-trial.
   * Any interruption accumulated since the last row is attributed here, and the
   * row is flagged aborted because its latency is then meaningless — kept, not
   * discarded: trimming is an analysis decision made later from raw rows.
   */
  addTrial(fields) {
    const hidden = this.pendingHiddenMs;
    this.pendingHiddenMs = 0;
    const row = Object.assign(this.sessionContext(), {
      trial_uid: store.uuid(),
      trial_index: this.trialIndex++,
      stage: this.stage,
      ms_since_session_start: Date.now() - this.startedAt,
      hidden_ms: Math.round(hidden)
    }, fields);
    if (hidden > 0 && !row.outcome_flag) row.outcome_flag = 'aborted';
    this.trialBuffer.push(row);
    this.nTrials++;
    return row;
  }

  async flush() {
    if (!this.trialBuffer.length) return;
    const rows = this.trialBuffer;
    this.trialBuffer = [];
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
      total_ms: now - this.openedAt,
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

    const prev = await store.lastSessionWithTrials();
    this.daysSincePrev = prev && prev.start_pressed_at_utc
      ? +((this.openedAt - prev.start_pressed_at_utc) / 86400000).toFixed(4)
      : null;

    const history = (await store.getMeta('stage_px_history', [])) || [];
    this.driftFlag = layout.driftFlag(this.stagePx, history);
    await store.setMeta('stage_px_history', history.concat([this.stagePx]).slice(-30));

    // Written before anything else, so an open that goes nowhere is still on the
    // record. never_started is the single most informative value in that table.
    await store.putSession(this.sessionRow('never_started'));
  }

  /* ---------------- the run ---------------- */

  async run() {
    this.seq = await store.nextSessionSeq();
    this.startedAt = Date.now();

    this.watcher = lifecycle.watch({
      getState: () => ({ session_uid: this.uid, stage: this.stage }),
      onInterruption: (ms, src) => this.onInterruption(ms, src),
      onAbandon: (ms, src) => this.onAbandon(ms, src),
      onHide: () => this.onHide()
    });

    try {
      await this.doGreeting();
      if (this.ended) return;
      await this.doCompanyQuestion();
      if (this.ended) return;

      for (const stage of ['opening_recognition', 'crt_1', 'encoding',
                           'filler_1', 'recognition_short',
                           'filler_2', 'recognition_medium', 'crt_2']) {
        if (this.ended) return;
        this.stage = stage;
        await this.doStage(stage);
        await this.flush();          // stage boundary: dead time, safe to write
      }

      if (this.ended) return;
      this.stage = 'close';
      await this.doClose();
      await this.end('completed');
    } catch (e) {
      this.log('error: ' + (e && e.message));
      await this.end('error');
      throw e;
    }
  }

  async end(reason) {
    if (this.ended) return;
    this.ended = true;
    if (this.watcher) this.watcher.stop();
    await this.flush();

    const rows = await store.trialsForSession(this.uid);
    const sessionRow = this.sessionRow(reason);
    await store.putSession(sessionRow);
    await upload.enqueue(rows, [sessionRow]);

    lifecycle.clearAlive();
    // After the closing screen is already up, so never in a timed path.
    upload.drain().catch(() => {});
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
    screen().innerHTML = `
      <div class="pane">
        <p class="lead">Good morning.</p>
        <p class="sub">Let's begin.</p>
      </div>`;

    if (this.config.audio_enabled) {
      const warm = await speech.warm();
      this.log(`voices ${warm.voices}, using ${warm.voice}`);
      const outcome = await speech.say('Good morning. Let us begin.');
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
    screen().innerHTML = `
      <div class="pane">
        <p class="lead">Is someone with you right now?</p>
        <div class="choices">
          <button class="big" data-value="yes">Yes</button>
          <button class="big" data-value="no">No</button>
        </div>
      </div>`;
    this.company = await choose([...screen().querySelectorAll('button')]);
    this.log('company: ' + this.company);
  }

  /**
   * Probe stubs. Real durations so the lifecycle and timing paths are exercised;
   * no trial rows, because no probe ran and a placeholder row would be
   * indistinguishable from real data later.
   */
  async doStage(stage) {
    const filler = stage.startsWith('filler');
    const ms = stage === 'filler_1' ? TIMING.filler_1_ms
             : stage === 'filler_2' ? TIMING.filler_2_ms
             : this.debug ? 1200 : 6000;

    screen().innerHTML = filler
      ? `<div class="pane"><p class="lead">Take a look at these.</p>
           <p class="sub">${this.debug ? stage + ' — ' + ms + 'ms' : ''}</p></div>`
      : `<div class="pane"><p class="lead">Just a moment.</p>
           <p class="sub">${this.debug ? stage : ''}</p></div>`;

    await wait(this.debug && filler ? 1500 : ms);
  }

  /** Warm, brief, no summary of performance. */
  async doClose() {
    const line = (this.config.message_line || '').trim();
    screen().innerHTML = `
      <div class="pane">
        <p class="lead">That's everything for today. Thank you.</p>
        ${line ? `<p class="sub">${escapeHtml(line)}</p>` : ''}
      </div>`;
    await wait(2500);
  }

  log(msg) {
    if (!this.debug) return;
    const box = el('debug');
    if (!box) return;
    const t = ((Date.now() - (this.startedAt || this.openedAt)) / 1000).toFixed(1);
    box.textContent = `[${t}s] ${this.stage}: ${msg}\n` + box.textContent;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
