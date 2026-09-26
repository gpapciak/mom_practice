/**
 * The item pool: the manifest contract, and the selector that draws from it.
 *
 * The recognition probe needs 48 images per session — 16 targets and 32 foils — and
 * every one of them is single-use for life. That rule, plus a concept cooldown, plus
 * a same-source rule, plus a fully crossed design, is most of the difficulty in this
 * app, and all of it is decided here rather than inside the probe.
 *
 * STATE IS DERIVED FROM THE TRIAL RECORD, NOT MAINTAINED ALONGSIDE IT
 * ------------------------------------------------------------------
 * There is no "used images" list and no "concept exposure ledger" kept as its own
 * mutable state. Everything is recomputed from trial rows on each call.
 *
 * Two reasons, and the second is the one that matters.
 *
 * First, local storage on the target machine measured as NON-PERSISTENT, so the
 * browser may evict the database at any time. A separately maintained ledger would
 * be the one piece of state that cannot be rebuilt, and rebuilding it wrongly means
 * showing an image a second time — which quietly converts a measure of new learning
 * into a measure of rehearsal, with nothing in the data to show it happened.
 *
 * Second, a ledger and the rows it describes can disagree, and that kind of drift is
 * invisible until it has been corrupting the series for weeks. Deriving makes the
 * rows definitionally correct: if a row says an image was used, it was used.
 *
 * The cost is recomputing over the whole history on each call. At one session a day
 * that is a few thousand rows a year, so it is nothing, and it stays nothing.
 *
 * The authority order is: rows read back from the Sheet, then local rows, unioned.
 * The Sheet is the system of record once a batch lands; local rows cover the batches
 * that have not landed yet.
 *
 * FOILS ARE RESERVED AT ENCODING, SO THEY ARE RECORDED AT ENCODING
 * ---------------------------------------------------------------
 * A trial's two foils are chosen when the target is encoded, not when it is tested,
 * because a matched trial needs three unused images from one narrow category and
 * that has to be guaranteed while the image is still in hand.
 *
 * For the 1-week arm, test happens seven days after reservation. If the foil ids
 * were written only on the recognition row, then for those seven days no record
 * anywhere would say those 32 images per session were spoken for — and the recovery
 * path (`doGet?action=used_items`, which scans `item_id` and `choice_order`) would
 * hand back a used-set missing all of them. After an eviction they would be drawn
 * again as fresh items.
 *
 * So `choice_order` and `choice_sources` are written on the ENCODING row as well,
 * where they mean "reserved", and copied onto the recognition row, where they mean
 * "shown". No schema change: both columns already exist. It is the doc note saying
 * "recognition rows only" that was wrong.
 */

import { rng, shuffle } from './rng.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Frozen. Names and nominal durations are schema enum values; do not invent others. */
export const DELAY_ARMS = [
  { arm: 'A_short', nominal_ms: 120000 },
  { arm: 'B_medium', nominal_ms: 300000 },
  { arm: 'C_1day', nominal_ms: 86400000 },
  { arm: 'D_1week', nominal_ms: 604800000 },
];

export const CONDITIONS = ['supported', 'passive'];
export const FOIL_TYPES = ['matched', 'unrelated'];

/**
 * The two-tier concept cooldown. The tier is set by the role an item is being drawn
 * for NOW; the lookback counts any prior appearance in either role, because
 * familiarity does not care which role produced it.
 */
export const TARGET_COOLDOWN_DAYS = 90;
export const FOIL_COOLDOWN_DAYS = 30;

/** A queued measurement this far past due has aged out of interpretability. */
export const QUEUE_EXPIRY_DAYS = 21;

/** Opening-check cap. Overflow stays queued rather than extending the session. */
export const OPENING_CAP = 10;

export const ITEMS_PER_SESSION = 16;
export const ALTERNATIVES = 3;

/** Stage names on which a recognition trial is recorded. */
export const RECOGNITION_STAGES = [
  'opening_recognition', 'recognition_short', 'recognition_medium',
];

/* ------------------------------------------------------------------ manifest */

const REQUIRED_FIELDS = ['id', 'concept_id', 'category', 'domain', 'source', 'file'];

/**
 * Validate and index a manifest.
 *
 * Throws rather than coping. A malformed manifest is a build-time mistake in a file
 * that is version-controlled and diffable, and the failure mode of coping with it is
 * a pool that silently has fewer usable images than the arithmetic assumed.
 *
 * `item_id` must be stable for the life of the series: tranches are additive, so a
 * top-up is a new directory and a manifest append, never a rewrite.
 */
export function parseManifest(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (!raw || !Array.isArray(raw.items)) throw new Error('manifest: items[] missing');

  const seen = new Set();
  const items = raw.items.map((it, i) => {
    for (const f of REQUIRED_FIELDS) {
      if (!it[f] || typeof it[f] !== 'string') {
        throw new Error(`manifest: item ${i} missing ${f}`);
      }
    }
    if (seen.has(it.id)) throw new Error(`manifest: duplicate item id ${it.id}`);
    seen.add(it.id);
    // Training ids are namespaced `t:` and pool ids are not. A pool id in that
    // namespace would let trained content reach a probe, which is the one overlap
    // the whole design refuses.
    if (it.id.startsWith('t:')) throw new Error(`manifest: ${it.id} uses the training namespace`);
    return {
      id: it.id,
      concept_id: it.concept_id,
      category: it.category,
      domain: it.domain,
      source: it.source,
      licence: it.licence || '',
      file: it.file,
      tranche: it.tranche || '',
    };
  });

  return { version: raw.version || 1, items, byId: new Map(items.map(i => [i.id, i])) };
}

/* ------------------------------------------------------------------- history */

function splitIds(s) {
  return String(s == null ? '' : s).split('|').map(x => x.trim()).filter(Boolean);
}

function ms(utc) {
  if (utc == null || utc === '') return NaN;
  const t = typeof utc === 'number' ? utc : Date.parse(utc);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Everything the selector needs, derived from trial rows.
 *
 * An image counts as burned if it appears as `item_id` OR anywhere in
 * `choice_order`, which is why foils must be recorded at reservation time.
 *
 * The manifest is passed in because a foil's concept is on no row: a foil appears
 * only as an id inside `choice_order`, with no concept column of its own. Without the
 * manifest the used-set is still exact — that is what rule 1 needs — but concept
 * exposure would undercount by two thirds, and concept capacity is the constraint
 * that actually binds. The manifest is append-only and ids are stable for the life of
 * the series, so a consumed tranche is still resolvable long after its pixels are
 * deleted.
 *
 * Rows from any source are acceptable and duplicates are harmless: both outputs are
 * set-like, and a row appearing twice records the same appearance at the same time.
 */
export function historyFromTrials(rows, manifest = null) {
  const used = new Set();
  /** concept_id -> appearance timestamps, either role. */
  const seen = new Map();
  /** Concepts as the rows themselves reported them, for ids the manifest lacks. */
  const rowConcept = new Map();

  for (const r of rows || []) {
    if (r && r.item_id && r.item_concept_id) rowConcept.set(r.item_id, r.item_concept_id);
  }

  const conceptFor = id => {
    const it = manifest && manifest.byId.get(id);
    return (it && it.concept_id) || rowConcept.get(id) || null;
  };

  const note = (id, at) => {
    if (!id) return;
    used.add(id);
    const cid = conceptFor(id);
    if (!cid || !Number.isFinite(at)) return;
    if (!seen.has(cid)) seen.set(cid, []);
    seen.get(cid).push(at);
  };

  for (const r of rows || []) {
    if (!r) continue;
    // Any of the three is an acceptable stamp for "around when this was shown". The
    // cooldown is in units of months; an hour of slop cannot change an answer.
    const at = ms(r.presented_at_utc) || ms(r.tested_at_utc) || ms(r.session_start_utc);
    note(r.item_id, at);
    for (const id of splitIds(r.choice_order)) note(id, at);
  }

  return { used, seen, rowConcept };
}

function daysSinceConcept(history, conceptId, now) {
  const ts = history.seen.get(conceptId);
  if (!ts || !ts.length) return Infinity;
  let latest = -Infinity;
  for (const t of ts) if (t > latest) latest = t;
  return (now - latest) / DAY_MS;
}

function priorExposures(history, conceptId) {
  const ts = history.seen.get(conceptId);
  return ts ? ts.length : 0;
}

/* ------------------------------------------------------------------ selection */

function groupBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

/** Weighted draw without replacement from [{key, weight}]. */
function drawWeighted(entries, next) {
  const total = entries.reduce((s, e) => s + e.weight, 0);
  if (total <= 0) return -1;
  let r = next() * total;
  for (let i = 0; i < entries.length; i++) {
    r -= entries[i].weight;
    if (r <= 0) return i;
  }
  return entries.length - 1;
}

/**
 * Assign one session's 16 items, each with two foils.
 *
 * Returns `{ assigned, shortfall, order }`. It does NOT throw on a short pool and it
 * does NOT quietly hand back fewer than 16 crossed items pretending the design held:
 * `shortfall` names the cells it could not fill, and the caller decides. A partial
 * crossing is worse than a skipped session, because a skipped session is visible in
 * `session_seq` and an unbalanced one is not.
 *
 * Order of work matters: matched trials are drawn first, because they are the
 * constrained ones (three images from one narrow category from one source) and
 * spending a scarce category on an unrelated foil would be waste.
 */
export function assignSession({ manifest, history, now, seed }) {
  const next = rng(seed);
  const taken = new Set();

  const free = manifest.items.filter(i => !history.used.has(i.id));
  const okTarget = i => daysSinceConcept(history, i.concept_id, now) >= TARGET_COOLDOWN_DAYS;
  const okFoil = i => daysSinceConcept(history, i.concept_id, now) >= FOIL_COOLDOWN_DAYS;
  const avail = () => free.filter(i => !taken.has(i.id));

  const trials = [];
  const shortfall = [];

  /* ---- 8 matched trials: target and both foils share the narrow category ---- */
  for (let n = 0; n < 8; n++) {
    const pool = avail().filter(okFoil);
    // Keyed by source AND category, because rule 3 requires one source per array
    // and rule 5 requires three from one category. Both at once, or not at all.
    const groups = [...groupBy(pool, i => i.source + '\u0000' + i.category)]
      .map(([k, items]) => {
        const concepts = new Set(items.map(i => i.concept_id));
        return { k, items, targets: items.filter(okTarget), weight: items.length, concepts };
      })
      // Three DISTINCT concepts, not merely three images: three photographs of the
      // same spatula are not a recognition test, they are a duplicate detection test.
      .filter(g => g.concepts.size >= ALTERNATIVES && g.targets.length >= 1);

    if (!groups.length) { shortfall.push({ foil_type: 'matched', reason: 'no category with 3 distinct concepts from one source' }); continue; }

    const g = groups[drawWeighted(groups, next)];
    const target = shuffle(g.targets, next)[0];
    const foils = [];
    for (const cand of shuffle(g.items, next)) {
      if (foils.length === ALTERNATIVES - 1) break;
      if (cand.id === target.id) continue;
      if (cand.concept_id === target.concept_id) continue;
      if (foils.some(f => f.concept_id === cand.concept_id)) continue;
      foils.push(cand);
    }
    if (foils.length < ALTERNATIVES - 1) { shortfall.push({ foil_type: 'matched', reason: 'foils' }); continue; }

    [target, ...foils].forEach(i => taken.add(i.id));
    trials.push({ target, foils, foil_type: 'matched' });
  }

  /* ---- 8 unrelated trials: foils from two other domains, same source ---- */
  for (let n = 0; n < 8; n++) {
    const pool = avail();
    const bySource = groupBy(pool, i => i.source);
    let made = null;

    for (const src of shuffle([...bySource.keys()], next)) {
      const items = bySource.get(src);
      const targets = shuffle(items.filter(okTarget), next);
      for (const target of targets) {
        // Two foils, two domains, both different from each other and from the
        // target's domain. Familiarity alone answers these, which is the point:
        // the arm is floor-protected so the delay design keeps information even if
        // the matched arm bottoms out.
        const byDomain = groupBy(items.filter(i => okFoil(i) && i.domain !== target.domain), i => i.domain);
        const domains = shuffle([...byDomain.keys()], next);
        if (domains.length < ALTERNATIVES - 1) continue;
        const foils = domains.slice(0, ALTERNATIVES - 1)
          .map(d => shuffle(byDomain.get(d), next)[0]);
        made = { target, foils, foil_type: 'unrelated' };
        break;
      }
      if (made) break;
    }

    if (!made) { shortfall.push({ foil_type: 'unrelated', reason: 'no target with two other domains in its source' }); continue; }
    [made.target, ...made.foils].forEach(i => taken.add(i.id));
    trials.push(made);
  }

  /* ---- cross onto cells: 4 arms x 2 conditions x 2 foil types = 16 ---- */
  const assigned = [];
  for (const ft of FOIL_TYPES) {
    const group = shuffle(trials.filter(t => t.foil_type === ft), next);
    let k = 0;
    for (const cond of CONDITIONS) {
      for (const { arm, nominal_ms } of DELAY_ARMS) {
        const t = group[k++];
        if (!t) { shortfall.push({ foil_type: ft, condition: cond, delay_arm: arm, reason: 'cell unfilled' }); continue; }
        const display = shuffle([t.target, ...t.foils], next);
        assigned.push({
          item: t.target,
          foils: t.foils,
          foil_type: ft,
          condition: cond,
          delay_arm: arm,
          delay_nominal_ms: nominal_ms,
          choice_order: display.map(i => i.id).join('|'),
          choice_sources: display.map(i => i.source).join('|'),
          target_position: display.findIndex(i => i.id === t.target.id) + 1,
          concept_prior_exposures: priorExposures(history, t.target.concept_id),
          concept_days_since_last: finiteDays(daysSinceConcept(history, t.target.concept_id, now)),
        });
      }
    }
  }

  return { assigned, shortfall, order: encodingOrder(assigned, next) };
}

/** `concept_days_since_last` is an int column; never-seen is null, not Infinity. */
function finiteDays(d) {
  return Number.isFinite(d) ? Math.floor(d) : null;
}

/**
 * Encoding order: seeded, with no more than two consecutive items in the same
 * encoding condition, so supported and passive interleave rather than block.
 *
 * Blocked conditions would let the user settle into "this is the one where I answer a
 * question", which makes the manipulation partly a set-switching manipulation.
 */
export function encodingOrder(assigned, next, maxRun = 2) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const order = shuffle(assigned, next);
    let run = 1, ok = true;
    for (let i = 1; i < order.length; i++) {
      run = order[i].condition === order[i - 1].condition ? run + 1 : 1;
      if (run > maxRun) { ok = false; break; }
    }
    if (ok) return order;
  }
  // Deterministic fallback: strict alternation. Reachable only if the conditions are
  // wildly unbalanced, which means the crossing already failed and shortfall says so.
  const sup = assigned.filter(a => a.condition === 'supported');
  const pas = assigned.filter(a => a.condition === 'passive');
  const out = [];
  while (sup.length || pas.length) {
    if (sup.length) out.push(sup.shift());
    if (pas.length) out.push(pas.shift());
  }
  return out;
}

/* ---------------------------------------------------------------- the queue */

/**
 * What is owed, derived from the trial record.
 *
 * Scheduled by wall-clock `due_at`, never by session index, because days get
 * skipped. Three days off means the 1-day items come back as 72-hour data points and
 * `delay_actual_ms` records that truthfully — which is the whole reason the nominal
 * label is bookkeeping and only the actual delay is the delay.
 *
 * `expired` here is MEASUREMENT staleness: the delay has aged past interpretability.
 * It has nothing to do with the training half's content expiry, where an answer has
 * stopped being true. Probe content cannot expire in that sense at all — the pool is
 * novel objects with no truth-value.
 */
export function queueDue(rows, now, cap = OPENING_CAP) {
  const tested = new Set();
  const encoded = new Map();

  for (const r of rows || []) {
    if (!r || !r.item_id) continue;
    if (RECOGNITION_STAGES.includes(r.stage)) { tested.add(r.item_id); continue; }
    if (r.stage !== 'encoding') continue;
    const at = ms(r.presented_at_utc);
    if (!Number.isFinite(at)) continue;
    const nominal = Number(r.delay_nominal_ms) || 0;
    encoded.set(r.item_id, {
      item_id: r.item_id,
      due_at: at + nominal,
      presented_at_utc: r.presented_at_utc,
      delay_arm: r.delay_arm,
      delay_nominal_ms: nominal,
      condition: r.condition,
      foil_type: r.foil_type,
      choice_order: r.choice_order,
      choice_sources: r.choice_sources,
      item_concept_id: r.item_concept_id,
      item_category: r.item_category,
      item_domain: r.item_domain,
      item_source: r.item_source,
    });
  }

  const pending = [...encoded.values()]
    .filter(e => !tested.has(e.item_id))
    .sort((a, b) => a.due_at - b.due_at); // most overdue first

  // Expiry is applied BEFORE the cap. An item 40 days past due must not occupy one
  // of ten slots that a genuinely due item needs, and it must not be tested either:
  // a 40-day "one day" trial would poison the curve.
  const expired = pending.filter(e => now - e.due_at > QUEUE_EXPIRY_DAYS * DAY_MS);
  const expiredIds = new Set(expired.map(e => e.item_id));
  const ready = pending.filter(e => !expiredIds.has(e.item_id) && now >= e.due_at);

  /*
   * Four counts, and they are easy to confuse - so, explicitly:
   *
   *   due       what the opening check presents, most overdue first, capped
   *   overflow  due as well, but past the cap; stays queued, session stays its length
   *   pending   encoded and untested, INCLUDING items not yet due (a 1-week item on
   *             day two is pending and not owed)
   *   expired   aged past QUEUE_EXPIRY_DAYS; retired with an `expired` row, never tested
   */
  return {
    expired,
    due: ready.slice(0, cap),
    overflow: ready.slice(cap),
    pending: pending.filter(e => !expiredIds.has(e.item_id)),
  };
}

/**
 * Remaining capacity, for the check that has to run before a tranche burns out.
 *
 * `sessions` is the honest number: not images/48, but how many more sessions can
 * actually be crossed. A pool can have thousands of images left and still be unable
 * to fill a matched cell, because concept capacity binds before image capacity does.
 */
export function capacity({ manifest, history, now }) {
  const free = manifest.items.filter(i => !history.used.has(i.id));
  const targetable = free.filter(
    i => daysSinceConcept(history, i.concept_id, now) >= TARGET_COOLDOWN_DAYS);
  const matchedGroups = [...groupBy(free, i => i.source + '\u0000' + i.category)]
    .filter(g => new Set(g[1].map(i => i.concept_id)).size >= ALTERNATIVES);

  return {
    images_free: free.length,
    images_targetable: targetable.length,
    matched_groups_usable: matchedGroups.length,
    // 48 images per session, of which 8 matched trials need 8 viable categories.
    sessions_by_images: Math.floor(free.length / (ITEMS_PER_SESSION * ALTERNATIVES)),
  };
}
