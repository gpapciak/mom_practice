/**
 * Seeded pseudorandom numbers.
 *
 * Every randomised decision in a session comes from here, seeded from a string that
 * is written to `rng_seed` on every trial row. That makes the exact stimulus
 * sequence reconstructable years later from the data alone — which matters because
 * "was that item assigned to the supported condition?" must be answerable in 2029
 * without the original device.
 *
 * mulberry32: small, fast, well-distributed enough for shuffling stimuli, and short
 * enough to be read and verified by whoever maintains this next. Not for anything
 * cryptographic, and nothing here is.
 */

/** FNV-1a. Turns the seed string into the 32-bit state mulberry32 wants. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Returns a function producing floats in [0, 1). */
export function rng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed));
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, out of place. Deterministic for a given generator. */
export function shuffle(items, next) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
