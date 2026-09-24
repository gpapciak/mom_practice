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
