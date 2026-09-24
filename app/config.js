/**
 * Deployment configuration for the session app.
 *
 * This is the one file whose contents are a capability rather than a constant.
 * It is also, unavoidably, readable by anyone who views the page source — a
 * static site cannot hold a secret. Everything here is public by construction.
 *
 * The token below is deliberately narrow in scope, and the endpoint enforces
 * that server-side. Scope definitions are documented privately.
 *
 * Nothing else in the app may hardcode an endpoint or a token.
 */

export const ENDPOINT =
  'https://script.google.com/macros/s/AKfycbyHjrEQxeQLbyL34nmy6dGmRh__q6Jzu4aFeWYR0NdRs-aszuK3sQTPCoRjxZXTlsDaDg/exec';

/**
 * The APP token — scopes: batch, event, read.
 *
 * Printed by setup() in the Apps Script editor log. Paste it here before the
 * first deploy. To rotate, run rotateTokens_() in the Apps Script editor, then
 * update this file and diagnostic/index.html and redeploy.
 *
 * While the token is wrong or missing the endpoint returns 'unauthorized' and
 * the client queues sessions in its outbox. Nothing is lost; it drains once the
 * token is fixed. That is the intended failure mode and it is why the endpoint
 * fails closed rather than open.
 */
export const TOKEN = 'app_f3394ddaae9b448a8f49faa9301f8c3d';

/* Guard against the one mistake that matters: pasting the diagnostic token here,
 * or this one into diagnostic/index.html. A swap would hand trial-write authority
 * to the page that ships most publicly, and nothing would visibly break - the
 * diagnostic would keep working and the app would keep queueing in its outbox. */
if (!TOKEN.startsWith('app_')) {
  throw new Error(
    'app/config.js needs the app_ token (scopes: batch, event, read), not ' +
    TOKEN.split('_')[0] + '_.');
}

/**
 * Collection is gated by TWO conditions, and COLLECTING is derived from them.
 *
 * Deliberately not a single editable line. It must not be possible to record the
 * first real row before the geometry is final, because the layout constants are
 * part of the instrument: a session collected at one stimulus size is not
 * comparable to one collected at another, and the divisors are still provisional
 * until measured against real screens rather than an estimate of them.
 *
 * PROBES_REAL     the probes emit real trials rather than stubs. While false, one
 *                 placeholder row in the canonical trial table would be
 *                 indistinguishable from real data later.
 *
 * GEOMETRY_FINAL  the layout divisors have been set from the measured vertical
 *                 extent of the built screens. Setting this true while
 *                 MEASURED_CONTENT_EXTENT_U is still null is refused at boot by
 *                 layout.geometryProblem(), so the flag alone achieves nothing.
 *
 * Flipping either one by itself changes nothing. Both, plus a recorded measurement,
 * are required.
 */
export const PROBES_REAL = false;
export const GEOMETRY_FINAL = false;
export const COLLECTING = PROBES_REAL && GEOMETRY_FINAL;

/**
 * Compiled-in config defaults. The Sheet's config tab can override these, but the
 * app must run correctly having never reached the network — a first session on a
 * fresh device runs entirely on these values.
 */
export const DEFAULTS = {
  config_version: 1,
  audio_enabled: true,
  session_active: true,
  message_line: ''
};

/**
 * Baked in at deploy and logged on every trial row. Bump it for any change that
 * could affect what the data means — including the filler durations below, which
 * live here rather than in the Sheet precisely so that changing one leaves a
 * trace in the data.
 */
export const APP_VERSION = '0.2.0-shell+2026-09-23';

/**
 * Filler durations set the nominal retention delays. Deliberately NOT remotely
 * editable: a knob marked "do not touch once collecting" is worse than no knob.
 */
export const TIMING = {
  filler_1_ms: 75000,
  filler_2_ms: 90000
};

/** The local day boundary is fixed, not taken from the device's guess. */
export const TIMEZONE = 'America/Los_Angeles';

/**
 * Longer than this hidden or frozen and the session ends rather than resumes.
 * Mirrors ABANDON_AFTER_MS in lifecycle.js, which owns the behaviour.
 */
export const ABANDON_AFTER_MS = 5 * 60 * 1000;
