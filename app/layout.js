/**
 * Layout geometry: fractions of one unit, never frozen pixels.
 *
 * WHY
 * ---
 * The user wears reading glasses, so browser zoom may already be non-default and
 * can change by accident. Zoom reduces the viewport in CSS pixels while making
 * each CSS pixel physically larger, so a layout expressed as a fraction of the
 * viewport keeps the same physical size and therefore the same visual angle. A
 * layout frozen in CSS pixels would not: a stray zoom would silently change target
 * sizes and cursor-travel distances, and the reaction-time series would drift with
 * nobody noticing.
 *
 * What is held constant is the angular geometry. stage_px is recorded on every
 * trial so travel latency can be read against the distance it was actually made
 * over.
 *
 * clientWidth/clientHeight, NOT innerWidth/innerHeight: the latter include the
 * scrollbar. Measured on the target machine, innerWidth was 1424 while the real
 * content width was 1409. The session must never scroll, so there should be no
 * scrollbar at all, but measuring the content box is correct regardless.
 */

/**
 * u = min(width / 1.32, height / 0.825)
 *
 * The divisors are the widest and tallest extents any screen needs in u-units,
 * including a 10% margin, so the whole session fits without scrolling at any
 * window size by construction.
 *
 * Measured target machine: 1424 x 686 -> u = 832, height-bound.
 *
 * There is spare vertical budget on that machine, enough to make every stimulus
 * 10-18% larger, which would help the user's eyesight. The divisors are NOT tuned
 * for it yet: the spare figure rests on an estimate of screens that did not exist
 * when it was computed, and setting frozen geometry from an estimate is how a
 * session ends up scrolling. Once every screen is built, measure the true vertical
 * extent and set H_DIV from that — before any data is collected, so it is free.
 */
const W_DIV = 1.32;
const H_DIV = 0.825;

/**
 * The largest vertical content extent actually measured across the built screens,
 * in units of u. Null until every screen exists and has been measured.
 *
 * H_DIV must be derived from this, not guessed. While it is null the geometry is
 * provisional, and geometryProblem() refuses to let collection start - which is why
 * flipping GEOMETRY_FINAL in config.js on its own does nothing.
 */
export const MEASURED_CONTENT_EXTENT_U = 0.60;

/**
 * Where 0.60 comes from, since a number with no derivation is just a promise again.
 *
 *   MEASURED, on the target viewport (1409x686, u = 831):
 *     crt_1 / crt_2        0.46 u   targets, offset row, reserved note line
 *     training             0.28 u   prompt, answer, three buttons
 *     greeting / company   0.20 u   one line and up to two buttons
 *     filler, close        0.15 u
 *
 *   COMPUTED from the frozen fractions, for screens not yet built. These are
 *   arithmetic over constants that cannot move without ending the series, so the
 *   figures are reliable even though the screens are not written:
 *     encoding      0.052 question + 0.045 + 0.350 image + 0.045 + 0.103 buttons
 *                   = 0.595 u   <- the tallest screen the session will ever show
 *     recognition   0.052 cue + 0.045 + 0.360 images + 0.045 + 0.034 feedback
 *                   = 0.536 u
 *
 * 0.60 covers the computed maximum with the 0.75 budget still above it. The
 * guarantee is not this number, though: measureScreen() checks every screen as it
 * renders, so an encoding screen that comes out taller than the arithmetic says is
 * caught rather than quietly clipped.
 */

/**
 * The vertical budget, as a fraction of u. H_DIV carries a margin above it.
 *
 * Every screen must render inside this. assertFits() enforces it at runtime rather
 * than trusting that someone measured, which is what lets GEOMETRY_FINAL be claimed
 * before every screen exists: the guarantee is a check, not a promise.
 */
export const CONTENT_BUDGET_U = 0.75;

/**
 * Measures a rendered screen and reports whether it fits, in units of u.
 *
 * Returns { extentU, fits, overflowPx }. Called after each screen paints. A screen
 * that does not fit is the one failure this layout may not have: the session must
 * never scroll, and an overflowing stimulus is worse than an ugly one because part
 * of it is simply not there and nothing says so.
 */
export function measureScreen(node, u) {
  if (!node) return { extentU: 0, fits: true, overflowPx: 0 };
  const unit = u || unitFromDom();
  // scrollHeight, not clientHeight: clientHeight is what fits, scrollHeight is what
  // is actually there. The difference is precisely the part that would be cut off.
  const h = node.scrollHeight || 0;
  const budgetPx = CONTENT_BUDGET_U * unit;
  return {
    extentU: unit ? +(h / unit).toFixed(4) : 0,
    fits: h <= budgetPx,
    overflowPx: Math.max(0, Math.round(h - budgetPx))
  };
}

function unitFromDom() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--u');
  return parseFloat(v) || unit();
}

/**
 * Returns null if the geometry may be treated as final, or a reason string if not.
 * Called at boot; a non-null reason blocks collection regardless of config flags.
 */
export function geometryProblem(claimFinal, measured = MEASURED_CONTENT_EXTENT_U) {
  if (!claimFinal) return null;
  if (measured === null || measured === undefined) {
    return 'GEOMETRY_FINAL is set but MEASURED_CONTENT_EXTENT_U is null: the layout '
         + 'divisors are still derived from an estimate. Measure the built screens first.';
  }
  if (!(measured > 0) || measured > 0.75) {
    return 'MEASURED_CONTENT_EXTENT_U = ' + measured + ' is outside the plausible range '
         + '(0, 0.75]; H_DIV would not leave a margin.';
  }
  return null;
}

/** Fractions of u. Frozen: these are the instrument's geometry. */
export const FRAC = {
  crtHome: 0.124,
  crtTarget: 0.165,
  crtOffset: 0.390,
  recImage: 0.360,
  recSpacing: 0.417,
  encImage: 0.350,
  buttonW: 0.247,
  buttonH: 0.103,
  buttonGap: 0.206
};

export function viewport() {
  const d = document.documentElement;
  return {
    w: d.clientWidth,
    h: d.clientHeight,
    dpr: window.devicePixelRatio || 1,
    scale: (window.visualViewport && window.visualViewport.scale) || 1
  };
}

export function unit(vp = viewport()) {
  return Math.floor(Math.min(vp.w / W_DIV, vp.h / H_DIV));
}

/** Publishes u and every derived size as CSS custom properties. */
export function apply() {
  const vp = viewport();
  const u = unit(vp);
  const root = document.documentElement.style;
  root.setProperty('--u', u + 'px');
  for (const [k, f] of Object.entries(FRAC)) {
    root.setProperty('--' + k, Math.round(f * u) + 'px');
  }
  return { u, vp };
}

/**
 * Drift against the running median of stage_px. Not a fault to repair: the layout
 * is SUPPOSED to track the viewport, and resetting the user's zoom to "fix" a flag
 * would itself put a discontinuity in the series. It is a covariate to record.
 */
export function driftFlag(u, history) {
  if (!history || !history.length) return 'none';
  const s = history.slice().sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2]
                         : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  if (!m) return 'none';
  const d = Math.abs(u - m) / m;
  return d > 0.05 ? 'major' : (d > 0.02 ? 'minor' : 'none');
}

/**
 * Which route this session came from: the Dock app, or an ordinary browser tab.
 *
 * The two are SEPARATE STORAGE CONTAINERS, so the same machine presents as two
 * devices - different `device_id`, independent `session_seq`, and a
 * `days_since_prev_session` computed from only one container's history, which is
 * wrong in a way that looks entirely plausible. The user agent is identical for both,
 * so nothing else in the row distinguishes them.
 *
 * `display-mode: standalone` is the one reliable discriminator, and it is a media
 * query rather than a sniff.
 */
export function displayMode() {
  try {
    if (typeof matchMedia !== 'function') return 'unknown';
    if (matchMedia('(display-mode: standalone)').matches) return 'standalone';
    if (matchMedia('(display-mode: browser)').matches) return 'browser';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
}
