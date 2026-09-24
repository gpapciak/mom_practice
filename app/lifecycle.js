/**
 * Interruption detection: the lid, the tab, and sleep.
 *
 * This module exists because the session must survive being left open, the lid
 * being closed, and the tab being revisited mid-session — and because getting it
 * wrong silently corrupts timing rather than visibly breaking anything.
 *
 * WHY NOT JUST visibilitychange
 * -----------------------------
 * Closing a MacBook lid suspends the machine. Timers stop, the page is frozen, and
 * `visibilitychange` may not fire at the moment the lid closes — and on wake, any
 * `setTimeout` that was pending simply fires late with no indication that hours
 * passed. Relying on visibility events alone would let a sleep of any length pass
 * as if it were nothing.
 *
 * So the primary detector is a HEARTBEAT that compares wall-clock time against the
 * last tick. A gap much larger than the tick interval means the page was frozen,
 * whatever the cause: lid, sleep, tab discard, or the browser throttling a
 * background tab. `visibilitychange` and `pagehide` are kept as additional
 * signals, not as the mechanism.
 *
 * Within-session timing uses the monotonic clock; this module is the one place
 * that deliberately watches the wall clock, because an interruption is a
 * wall-clock event.
 *
 * WHAT COUNTS AS WHAT
 * -------------------
 *   under 5 minutes  -> resume in place. The gap is added to the current trial's
 *                       hidden_ms, and the trial is flagged so its latency is
 *                       excluded from analysis rather than from collection.
 *   over 5 minutes   -> the session ends, end_reason abandoned_hidden. Everything
 *                       collected is kept and uploaded. Timing and retention
 *                       delays are no longer interpretable, and a "resume?" screen
 *                       would violate the rule that every screen must make sense
 *                       on its own to someone who cannot carry instructions
 *                       forward.
 *
 * On return after a long gap the ordinary opening screen is shown. Items encoded
 * in the abandoned session stay queued and are tested later at their true elapsed
 * delay, which delay_actual_ms records truthfully — so an abandoned session costs
 * a few trials, never the integrity of the series.
 */

/** Longer than this and the session is over rather than paused. */
export const ABANDON_AFTER_MS = 5 * 60 * 1000;

/** Heartbeat period. Short enough to localise a gap to the right trial. */
const TICK_MS = 1000;

/** A gap larger than this is a freeze, not scheduler jitter. */
const FREEZE_THRESHOLD_MS = 4000;

/**
 * localStorage, not IndexedDB, and deliberately.
 *
 * On pagehide only synchronous work is reliable, and IndexedDB is asynchronous, so
 * a final async write is a coin toss. localStorage is synchronous, so the last
 * moment of a session can always be stamped. The next boot reconciles it into the
 * session row. Trial data never goes here — this is a single timestamp.
 */
const ALIVE_KEY = 'cp_last_alive';

export function readLastAlive() {
  try {
    const v = localStorage.getItem(ALIVE_KEY);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;   // private window, blocked storage: absence is handled everywhere
  }
}

export function stampAlive(sessionUid, stage) {
  try {
    localStorage.setItem(ALIVE_KEY, JSON.stringify({
      at: Date.now(), session_uid: sessionUid || null, stage: stage || null
    }));
  } catch (e) { /* never let a storage failure end a session */ }
}

export function clearAlive() {
  try { localStorage.removeItem(ALIVE_KEY); } catch (e) { /* ignore */ }
}

/**
 * Starts watching. Returns a handle with stop() and hiddenTotalMs().
 *
 * handlers:
 *   onInterruption(ms, source)  a freeze shorter than ABANDON_AFTER_MS
 *   onAbandon(ms, source)       a freeze longer than that; the session must end
 *   onHide()                    going hidden: flush buffers, try to upload
 *   getState()                  () => ({ session_uid, stage }) for the stamp
 */
export function watch(handlers) {
  let lastTick = Date.now();
  let hiddenAt = null;
  let hiddenTotal = 0;
  let stopped = false;

  const state = () => (handlers.getState ? handlers.getState() : {});

  function report(ms, source) {
    if (ms >= ABANDON_AFTER_MS) {
      if (handlers.onAbandon) handlers.onAbandon(ms, source);
    } else if (handlers.onInterruption) {
      handlers.onInterruption(ms, source);
    }
  }

  const timer = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;

    const s = state();
    stampAlive(s.session_uid, s.stage);

    // The heartbeat missed beats: the page was frozen for `gap`. This is the
    // detector that actually catches a closed lid.
    if (gap > FREEZE_THRESHOLD_MS) {
      hiddenTotal += gap - TICK_MS;
      report(gap - TICK_MS, 'freeze');
    }
  }, TICK_MS);

  function onVisibility() {
    if (stopped) return;
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      // Flush and attempt an upload now: storage_persisted is false on the target
      // machine, so a batch left sitting in the outbox is the one thing in this
      // design that eviction could actually destroy.
      if (handlers.onHide) handlers.onHide();
      const s = state();
      stampAlive(s.session_uid, s.stage);
    } else if (hiddenAt !== null) {
      const ms = Date.now() - hiddenAt;
      hiddenAt = null;
      hiddenTotal += ms;
      lastTick = Date.now();       // do not double-count as a freeze on the next tick
      report(ms, 'visibility');
    }
  }

  function onPageHide() {
    const s = state();
    stampAlive(s.session_uid, s.stage);   // synchronous; the only reliable last act
    if (handlers.onHide) handlers.onHide();
  }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
    },
    hiddenTotalMs() { return Math.round(hiddenTotal); },
    /** Consume and reset, for attributing a gap to the trial it landed in. */
    takeHidden() { const v = Math.round(hiddenTotal); hiddenTotal = 0; return v; }
  };
}
