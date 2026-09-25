/**
 * Dates. One place, because every one of these has bitten something already.
 *
 * Two rules:
 *
 *   The local day boundary is FIXED, not taken from the device. A laptop timezone
 *   change must not silently shift which day a session belongs to.
 *
 *   A date read from a spreadsheet may arrive in any of three shapes, and guessing
 *   which is how an off-by-one-day bug gets shipped. parseSheetDate handles all
 *   three rather than trusting the cell's formatting.
 */

/** The day boundary for this project. Deliberately not the device's guess. */
export const TIMEZONE = 'America/Los_Angeles';

/** 'YYYY-MM-DD' for an instant, in the fixed timezone. */
export function localDateFor(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ms));
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** 'HH:MM' for an instant, in the fixed timezone. */
export function localTimeFor(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

/**
 * A date from a spreadsheet cell -> 'YYYY-MM-DD', or null if it is not a date.
 *
 * THREE SHAPES, because a Sheet is edited by a person and the cell's type depends on
 * how it was typed and formatted:
 *
 *   1. 'YYYY-MM-DD'   a plain-text cell. Used as-is.
 *
 *   2. an ISO instant, e.g. '2026-10-02T07:00:00.000Z'. Sheets stored the cell as a
 *      real date value, so getValues() returned a Date and JSON turned it into UTC.
 *      Slicing the first ten characters LOOKS right and is wrong for half the
 *      world: a typed date becomes midnight in the SHEET's timezone, so for any
 *      positive UTC offset the instant lands on the previous day. Paris would read
 *      2026-10-02 as 2026-10-01.
 *
 *      So the instant is rounded to the NEAREST UTC midnight instead. A typed date
 *      is always within twelve hours of it either way, which recovers the intended
 *      day for every real timezone without needing to know which one the Sheet uses.
 *      This matters here specifically: the Sheet may be administered from one
 *      timezone and read on a machine in another, so the sheet's offset is neither
 *      known to this code nor safe to assume.
 *
 *   3. a serial number, e.g. 46297. The spreadsheet epoch, days since 1899-12-30.
 *
 * Anything else returns null, and the caller decides whether that is a warning or a
 * reason to ignore the column.
 */
export function parseSheetDate(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 1 || value > 100000) return null;          // not a plausible serial
    const ms = Date.UTC(1899, 11, 30) + Math.round(value) * DAY_MS;
    return new Date(ms).toISOString().slice(0, 10);
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return nearestUtcMidnight(value.getTime());
  }

  const text = String(value).trim();
  if (text === '') return null;

  if (ISO_DATE.test(text)) return text;

  // An ISO instant, or anything else Date can read. Rounded, never sliced.
  const t = Date.parse(text);
  if (Number.isNaN(t)) return null;
  return nearestUtcMidnight(t);
}

function nearestUtcMidnight(ms) {
  return new Date(Math.round(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whole days from one 'YYYY-MM-DD' to another. Positive if `to` is later.
 *
 * Arithmetic on UTC midnights, so a DST transition between the two dates cannot
 * turn a whole number of days into 23 or 25 hours and round the wrong way.
 */
export function daysBetween(fromDate, toDate) {
  const a = ISO_DATE.exec(fromDate);
  const b = ISO_DATE.exec(toDate);
  if (!a || !b) return null;
  const ms = Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3]);
  return Math.round(ms / DAY_MS);
}

/**
 * ISO date strings compare correctly as strings, which is why everything here
 * passes them around rather than Date objects. Stated explicitly because it is the
 * kind of thing someone later rewrites into something worse.
 */
export function onOrBefore(a, b) { return a <= b; }
export function onOrAfter(a, b) { return a >= b; }
