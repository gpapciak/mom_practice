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
export const APP_VERSION = '0.1.0+2026-09-20';

/**
 * Filler durations set the nominal retention delays. Deliberately NOT remotely
 * editable: a knob marked "do not touch once collecting" is worse than no knob.
 */
export const TIMING = {
  filler_1_ms: 75000,
  filler_2_ms: 90000
};
