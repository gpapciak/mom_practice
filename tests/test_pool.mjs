/**
 * Tests for the item pool: the manifest contract, the selector, and the queue.
 *
 *   node tests/test_pool.mjs
 *
 * Separate from test_shell.mjs because it tests a different kind of thing. The shell
 * tests ask "does this code do what it says". Most of these ask "does the DESIGN
 * survive contact with a real pool", and the last section answers a question no unit
 * test can: how many sessions a given pool can actually supply before it starves.
 *
 * WHY A SIMULATION AND NOT JUST ASSERTIONS
 * ---------------------------------------
 * The selector obeys four rules that interact: images are single-use for life, a
 * concept is cooled for 90 days as target and 30 as foil, all three images in an
 * array share one source, and a matched trial needs three distinct concepts from one
 * narrow category. Each is simple. Together they can starve a pool that looks
 * enormous, because the binding constraint is concept capacity, not image count.
 *
 * Finding that out by running the app for a month is the expensive way. So section 9
 * runs the real selector forward over hundreds of simulated sessions and reports the
 * session on which it first fails to fill a cell.
 *
 * The invariants are also tested for their ability to FAIL. Section 5 plants
 * violations into a known-good assignment and asserts every check catches its own —
 * a check that cannot fail is not a check, and these particular checks are the only
 * thing standing between the design and a silently reused image.
 */

import {
  parseManifest, historyFromTrials, assignSession, queueDue, capacity,
  encodingOrder, DELAY_ARMS, CONDITIONS, FOIL_TYPES,
  TARGET_COOLDOWN_DAYS, FOIL_COOLDOWN_DAYS, QUEUE_EXPIRY_DAYS, OPENING_CAP,
} from '../app/pool.js';

let pass = 0, fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

const DAY = 86400000;
const T0 = Date.parse('2026-10-01T09:00:00Z');

/* ------------------------------------------------------------------ fixtures */

/**
 * A manifest shaped like a real single-source tranche.
 *
 * The shape matters more than the size. BOSS is studio photographs of household
 * objects: a few hundred narrow categories at most, and crucially MORE THAN ONE
 * EXEMPLAR PER CONCEPT — two photographs of different spatulas are two images and
 * one concept. That ratio is what drives the cooldown, so it is a parameter here
 * rather than an assumption.
 */
function makeManifest({
  n = 1400, concepts = 900, categories = 60, domains = 12, source = 'boss', prefix = 'b',
} = {}) {
  const items = [];
  for (let i = 0; i < n; i++) {
    const c = i % concepts;                       // concepts cycle, so exemplars repeat
    const cat = c % categories;                   // a concept sits in exactly one category
    const dom = cat % domains;                    // a category sits in exactly one domain
    items.push({
      id: `${prefix}${String(i).padStart(5, '0')}`,
      concept_id: `c${c}`,
      category: `cat${cat}`,
      domain: `dom${dom}`,
      source,
      licence: 'CC BY-SA 4.0',
      file: `${source}/${prefix}${i}.webp`,
      tranche: 't1',
    });
  }
  return parseManifest({ version: 1, items });
}

/** The trial rows one assigned session would write. */
function rowsFor(assigned, at) {
  const iso = new Date(at).toISOString();
  const out = [];
  for (const a of assigned) {
    out.push({
      stage: 'encoding', probe_id: 'C_encoding', item_id: a.item.id,
      item_concept_id: a.item.concept_id, item_category: a.item.category,
      item_domain: a.item.domain, item_source: a.item.source,
      condition: a.condition, foil_type: a.foil_type, delay_arm: a.delay_arm,
      delay_nominal_ms: a.delay_nominal_ms,
      choice_order: a.choice_order, choice_sources: a.choice_sources,
      presented_at_utc: iso, session_start_utc: iso,
    });
  }
  return out;
}

/** Every pool rule, as a checkable predicate over one session's assignment. */
function invariants(assigned, manifest, history, now) {
  const bad = [];
  const seenThisSession = new Set();

  for (const a of assigned) {
    const three = [a.item, ...a.foils];

    for (const it of three) {
      if (history.used.has(it.id)) bad.push(`reuse:${it.id}`);        // rule 1
      if (seenThisSession.has(it.id)) bad.push(`dup-in-session:${it.id}`);
      seenThisSession.add(it.id);
    }

    if (new Set(three.map(i => i.source)).size !== 1) bad.push(`source:${a.item.id}`); // rule 3
    if (new Set(three.map(i => i.concept_id)).size !== 3) bad.push(`concept-dup:${a.item.id}`);

    const dTarget = daysSince(history, a.item.concept_id, now);
    if (dTarget < TARGET_COOLDOWN_DAYS) bad.push(`target-cooldown:${a.item.id}`);     // rule 2
    for (const f of a.foils) {
      if (daysSince(history, f.concept_id, now) < FOIL_COOLDOWN_DAYS) bad.push(`foil-cooldown:${f.id}`);
    }

    if (a.foil_type === 'matched') {                                  // rule 5
      if (new Set(three.map(i => i.category)).size !== 1) bad.push(`matched-category:${a.item.id}`);
    } else {                                                          // rule 6
      const doms = a.foils.map(f => f.domain);
      if (doms.includes(a.item.domain)) bad.push(`unrelated-target-domain:${a.item.id}`);
      if (doms[0] === doms[1]) bad.push(`unrelated-foil-domains:${a.item.id}`);
    }

    const order = a.choice_order.split('|');
    if (order.length !== 3) bad.push(`choice_order-len:${a.item.id}`);
    if (order[a.target_position - 1] !== a.item.id) bad.push(`target_position:${a.item.id}`);
    if (a.choice_sources.split('|').length !== 3) bad.push(`choice_sources-len:${a.item.id}`);
  }
  return bad;
}

function daysSince(history, cid, now) {
  const ts = history.seen.get(cid);
  if (!ts || !ts.length) return Infinity;
  return (now - Math.max(...ts)) / DAY;
}

/* ========================= 1. the manifest contract */

section('1. the manifest contract');
{
  const m = makeManifest({ n: 30, concepts: 30 });
  check('parses and indexes', m.items.length === 30 && m.byId.size === 30);

  const missing = () => parseManifest({ items: [{ id: 'x', concept_id: 'c' }] });
  check('refuses an item missing required fields', throws(missing));

  const dup = () => parseManifest({
    items: [okItem('a'), okItem('a')],
  });
  check('refuses a duplicate item id', throws(dup),
    'ids must be stable and unique for the life of the series');

  // Training ids are `t:`-namespaced. A pool image in that namespace is how a trained
  // fact could end up measured as novel learning, which is unrecoverable after the fact.
  const ns = () => parseManifest({ items: [okItem('t:visitors')] });
  check('refuses a pool id in the training namespace', throws(ns));

  check('no items[] at all is refused', throws(() => parseManifest({})));
}

function okItem(id) {
  return { id, concept_id: 'c1', category: 'cat1', domain: 'dom1', source: 's', file: 'f.webp' };
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

/* ========================= 2. history derives from rows, including foils */

section('2. history derives from the trial record, foils included');
{
  const m = makeManifest({ n: 100, concepts: 100 });
  const ids = m.items.map(i => i.id);
  const rows = [{
    stage: 'encoding', item_id: ids[0], item_concept_id: 'c0',
    choice_order: `${ids[0]}|${ids[1]}|${ids[2]}`,
    presented_at_utc: new Date(T0).toISOString(),
  }];

  const h = historyFromTrials(rows, m);
  check('the target is burned', h.used.has(ids[0]));
  check('BOTH FOILS are burned too', h.used.has(ids[1]) && h.used.has(ids[2]),
    'a foil is only ever an id inside choice_order; miss it and it is drawn again');
  check('three concepts are counted, not one', h.seen.size === 3, String(h.seen.size));

  // Without the manifest the used-set must still be exact - that is what rule 1
  // needs - but concept exposure can only cover what the rows themselves carried.
  const h2 = historyFromTrials(rows, null);
  check('used-set is exact with no manifest', h2.used.size === 3);
  check('and concept counting degrades rather than lying', h2.seen.size === 1, String(h2.seen.size));

  check('an empty history is fine', historyFromTrials([], m).used.size === 0);
  check('a null row list is fine', historyFromTrials(null, m).used.size === 0);
  check('a row with no timestamp still burns the image',
    historyFromTrials([{ stage: 'encoding', item_id: ids[5] }], m).used.has(ids[5]),
    'burning is about identity, not about when');
}

/* ========================= 3. the crossing is structural */

section('3. the crossing is structural, not achieved in expectation');
{
  const m = makeManifest();
  const h = historyFromTrials([], m);
  const { assigned, shortfall } = assignSession({ manifest: m, history: h, now: T0, seed: 's1' });

  check('16 items', assigned.length === 16, String(assigned.length));
  check('no shortfall on a fresh pool', shortfall.length === 0, JSON.stringify(shortfall.slice(0, 2)));

  // 4 arms x 2 conditions x 2 foil types, exactly one item in each of the 16 cells.
  // Four items per arm IS a 2x2, so balance cannot be lost to chance.
  const cells = new Map();
  for (const a of assigned) {
    const k = `${a.delay_arm}|${a.condition}|${a.foil_type}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  check('16 distinct cells', cells.size === 16, String(cells.size));
  check('exactly one item per cell', [...cells.values()].every(v => v === 1));

  for (const { arm } of DELAY_ARMS) {
    const inArm = assigned.filter(a => a.delay_arm === arm);
    check(`${arm} carries both foil types`,
      new Set(inArm.map(a => a.foil_type)).size === 2,
      'matched on short arms and unrelated on long ones would make the curve uninterpretable');
  }
  check('8 supported, 8 passive',
    assigned.filter(a => a.condition === 'supported').length === 8);
  check('8 matched, 8 unrelated',
    assigned.filter(a => a.foil_type === 'matched').length === 8);
  check('nominal ms matches the arm',
    assigned.every(a => a.delay_nominal_ms ===
      DELAY_ARMS.find(d => d.arm === a.delay_arm).nominal_ms));
}

/* ========================= 4. the pool rules hold */

section('4. the pool rules hold on an assignment');
{
  const m = makeManifest();
  const h = historyFromTrials([], m);
  const { assigned } = assignSession({ manifest: m, history: h, now: T0, seed: 's2' });
  const bad = invariants(assigned, m, h, T0);
  check('every rule holds on a fresh pool', bad.length === 0, bad.slice(0, 5).join(', '));
  check('48 distinct images consumed', new Set(
    assigned.flatMap(a => [a.item.id, ...a.foils.map(f => f.id)])).size === 48);

  // Rule 2 with real history: burn a concept, then assert it cannot come back as a
  // target for 90 days or as a foil for 30.
  const hot = m.items[0].concept_id;
  const rows = [{
    stage: 'encoding', item_id: m.items[0].id, item_concept_id: hot,
    presented_at_utc: new Date(T0).toISOString(),
  }];
  const h2 = historyFromTrials(rows, m);

  const at40 = assignSession({ manifest: m, history: h2, now: T0 + 40 * DAY, seed: 's3' });
  check('at 40 days the cooled concept is not a target',
    !at40.assigned.some(a => a.item.concept_id === hot),
    'target cooldown is 90 days');
  check('but it may be a foil, because the foil tier is 30 days',
    invariants(at40.assigned, m, h2, T0 + 40 * DAY).length === 0);

  const at10 = assignSession({ manifest: m, history: h2, now: T0 + 10 * DAY, seed: 's4' });
  check('at 10 days it is neither target nor foil',
    !at10.assigned.some(a => [a.item, ...a.foils].some(i => i.concept_id === hot)));
}

/* ========================= 5. the invariant checks can fail */

section('5. the invariant checks are proven able to fail');
{
  // Standing rule: every gate is tested with a deliberate violation before it is
  // trusted. These checks ARE the gate on the pool rules, so each one gets attacked.
  const m = makeManifest();
  const h = historyFromTrials([], m);
  const good = assignSession({ manifest: m, history: h, now: T0, seed: 's5' }).assigned;
  check('the baseline assignment is clean', invariants(good, m, h, T0).length === 0);

  const plant = (mutate, expect) => {
    const copy = good.map(a => ({ ...a, foils: a.foils.slice() }));
    mutate(copy);
    const bad = invariants(copy, m, h, T0);
    check(`caught: ${expect}`, bad.some(b => b.startsWith(expect)), bad.join(', ') || 'NOTHING CAUGHT');
  };

  plant(c => { c[0].foils[0] = { ...c[0].foils[0], source: 'other' }; }, 'source');
  plant(c => { c[0].foils[0] = { ...c[0].foils[0], concept_id: c[0].item.concept_id }; }, 'concept-dup');
  plant(c => { c[0].target_position = c[0].target_position === 1 ? 2 : 1; }, 'target_position');
  plant(c => { c[0].choice_order = 'only|two'; }, 'choice_order-len');
  plant(c => { c[1].item = c[0].item; }, 'dup-in-session');

  const mt = good.findIndex(a => a.foil_type === 'matched');
  plant(c => { c[mt].foils[0] = { ...c[mt].foils[0], category: 'catXX' }; }, 'matched-category');

  const un = good.findIndex(a => a.foil_type === 'unrelated');
  plant(c => { c[un].foils[0] = { ...c[un].foils[0], domain: c[un].item.domain }; }, 'unrelated-target-domain');
  plant(c => { c[un].foils[1] = { ...c[un].foils[1], domain: c[un].foils[0].domain }; }, 'unrelated-foil-domains');

  // Reuse: burn one of the images the assignment uses, then re-check.
  const reuseHistory = historyFromTrials([{
    stage: 'encoding', item_id: good[0].item.id, item_concept_id: 'zz',
    presented_at_utc: new Date(T0).toISOString(),
  }], m);
  check('caught: reuse', invariants(good, m, reuseHistory, T0).some(b => b.startsWith('reuse')));
}

/* ========================= 6. encoding order interleaves */

section('6. encoding order interleaves the conditions');
{
  const m = makeManifest();
  const h = historyFromTrials([], m);
  const { assigned, order } = assignSession({ manifest: m, history: h, now: T0, seed: 's6' });
  check('order holds every item once', order.length === 16 &&
    new Set(order.map(a => a.item.id)).size === 16);

  const longestRun = seq => {
    let best = 1, run = 1;
    for (let i = 1; i < seq.length; i++) {
      run = seq[i].condition === seq[i - 1].condition ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  };
  check('never more than two of the same condition in a row', longestRun(order) <= 2,
    String(longestRun(order)));

  // Over many seeds, because a single seed passing says nothing about the constraint.
  let worst = 0;
  for (let s = 0; s < 60; s++) {
    const o = assignSession({ manifest: m, history: h, now: T0, seed: 'seed' + s }).order;
    worst = Math.max(worst, longestRun(o));
  }
  check('holds across 60 seeds', worst <= 2, 'worst run ' + worst);

  // The fallback path, reached only when the crossing has already failed.
  const lopsided = Array.from({ length: 6 }, () => ({ condition: 'supported' }))
    .concat(Array.from({ length: 6 }, () => ({ condition: 'passive' })));
  check('the alternating fallback also respects the run limit',
    longestRun(encodingOrder(lopsided, () => 0.5)) <= 2);
}

/* ========================= 7. the queue */

section('7. the queue is wall-clock, skip-tolerant, and expires stale measurements');
{
  const m = makeManifest();
  const h = historyFromTrials([], m);
  const { assigned } = assignSession({ manifest: m, history: h, now: T0, seed: 's7' });
  const rows = rowsFor(assigned, T0);

  // Immediately after encoding, nothing is due: the shortest arm is two minutes.
  check('nothing due at encoding time', queueDue(rows, T0).due.length === 0);

  const q3 = queueDue(rows, T0 + 3 * 60000);
  check('the 2-minute arm is due at 3 minutes',
    q3.due.length === 4 && q3.due.every(e => e.delay_arm === 'A_short'),
    JSON.stringify(q3.due.map(e => e.delay_arm)));

  // Three similar-sounding counts, and they mean different things: `due` is what gets
  // presented (capped), `overflow` is due-but-deferred, `pending` is everything
  // encoded and untested INCLUDING what is not yet due. Asserted together so the
  // distinction cannot quietly rot.
  const qNext = queueDue(rows, T0 + 1.2 * DAY);
  check('a day later the short, medium and 1-day arms are owed - 12 of them',
    qNext.due.length + qNext.overflow.length === 12,
    `${qNext.due.length} + ${qNext.overflow.length}`);
  check('the 1-week arm is pending but not yet owed',
    qNext.pending.length === 16, String(qNext.pending.length));
  check('only the cap is presented', qNext.due.length === OPENING_CAP);
  check('most overdue first',
    qNext.due.every((e, i) => i === 0 || qNext.due[i - 1].due_at <= e.due_at));

  // The cap protects session length; overflow stays queued rather than extending it.
  const qWeek = queueDue(rows, T0 + 8 * DAY);
  check('all 16 are owed after a week', qWeek.pending.length === 16);
  check(`the cap holds at ${OPENING_CAP}`, qWeek.due.length === OPENING_CAP);
  check('the rest stays queued rather than lengthening the session',
    qWeek.overflow.length === 6, String(qWeek.overflow.length));

  // Skipped days are the normal case, not the exception.
  const skipped = queueDue(rows, T0 + 3 * DAY);
  check('three days off returns the 1-day items rather than losing them',
    skipped.due.some(e => e.delay_arm === 'C_1day'),
    'they come back as 72-hour data points and delay_actual_ms says so');

  // Expiry: past 21 days the delay has aged out of interpretability.
  const late = queueDue(rows, T0 + 40 * DAY);
  check('past 21 days items expire instead of being tested',
    late.expired.length > 0 && late.due.length === 0,
    'a 40-day "one day" trial would poison the curve');
  check('expired items are not also pending', late.pending.length === 0);

  // Expiry BEFORE the cap. Otherwise ten dead items block ten live ones forever.
  const mixed = rowsFor(assigned, T0 - 30 * DAY).concat(rowsFor(
    assignSession({ manifest: m, history: historyFromTrials(rowsFor(assigned, T0 - 30 * DAY), m), now: T0, seed: 's8' }).assigned, T0 - 2 * DAY));
  const qm = queueDue(mixed, T0);
  check('stale items do not occupy cap slots',
    qm.due.length > 0 && qm.due.every(e => T0 - e.due_at <= QUEUE_EXPIRY_DAYS * DAY),
    JSON.stringify(qm.due.map(e => Math.round((T0 - e.due_at) / DAY))));
  check('and the stale ones are reported as expired', qm.expired.length === 16);

  // Tested items leave the queue.
  const tested = rows.concat(qWeek.due.map(e => ({
    stage: 'opening_recognition', item_id: e.item_id,
    tested_at_utc: new Date(T0 + 8 * DAY).toISOString(),
  })));
  check('a tested item leaves the queue',
    queueDue(tested, T0 + 8 * DAY).pending.length === 6,
    'one delay per item, for life');

  // A session abandoned after encoding needs no special case.
  const abandoned = rows.filter(r => r.delay_arm === 'A_short' || r.delay_arm === 'B_medium');
  check('an abandoned session leaves its short arms already due next time',
    queueDue(abandoned, T0 + DAY).due.length === 8);
}

/* ========================= 8. determinism */

section('8. the assignment is reconstructable from rng_seed alone');
{
  const m = makeManifest();
  const h = historyFromTrials([], m);
  const a = assignSession({ manifest: m, history: h, now: T0, seed: 'fixed' });
  const b = assignSession({ manifest: m, history: h, now: T0, seed: 'fixed' });
  const key = r => r.assigned.map(x =>
    `${x.item.id}:${x.delay_arm}:${x.condition}:${x.foil_type}:${x.choice_order}`).join(';');
  check('same seed, same assignment', key(a) === key(b),
    'the question "was that item supported?" must be answerable in 2029');
  const c = assignSession({ manifest: m, history: h, now: T0, seed: 'other' });
  check('a different seed gives a different assignment', key(a) !== key(c));
}

/* ========================= 9. does the pool actually last? */

section('9. forward simulation: how many sessions a pool really supplies');
{
  /**
   * Runs the real selector forward, one session per day, until it cannot fill a cell.
   * This is the number that matters operationally, and it is not images/48: concept
   * capacity binds first, and the matched arm binds before the unrelated one.
   */
  function simulate({ manifest, days = 400 }) {
    let rows = [];
    for (let d = 0; d < days; d++) {
      const now = T0 + d * DAY;
      const history = historyFromTrials(rows, manifest);
      const r = assignSession({ manifest, history, now, seed: 'sim' + d });
      const bad = invariants(r.assigned, manifest, history, now);
      if (bad.length) return { sessions: d, reason: 'INVARIANT ' + bad[0] };
      if (r.shortfall.length) return { sessions: d, reason: r.shortfall[0].reason };
      rows = rows.concat(rowsFor(r.assigned, now));
      // Items are tested, which is what frees nothing but keeps the record honest.
      const q = queueDue(rows, now + DAY);
      rows = rows.concat(q.due.map(e => ({
        stage: 'opening_recognition', item_id: e.item_id,
        tested_at_utc: new Date(now + DAY).toISOString(),
      })));
    }
    return { sessions: days, reason: 'still going' };
  }

  const boss = makeManifest({ n: 1400, concepts: 900, categories: 60, domains: 12 });
  const cap0 = capacity({ manifest: boss, history: historyFromTrials([], boss), now: T0 });
  console.log(`      BOSS-shaped: ${cap0.images_free} images, ` +
    `${cap0.matched_groups_usable} usable matched groups, ` +
    `${cap0.sessions_by_images} sessions by image count alone`);

  const rBoss = simulate({ manifest: boss });
  console.log(`      -> starves after ${rBoss.sessions} sessions (${rBoss.reason})`);
  check('a BOSS-sized tranche covers at least a two-week baseline',
    rBoss.sessions >= 14, `${rBoss.sessions} sessions`);
  check('and it does NOT silently last forever, so the top-up trigger is real',
    rBoss.sessions < 400, 'if this fails the arithmetic is wrong somewhere');

  // The steady-state pool. Four thousand images is the documented tranche size.
  const steady = makeManifest({ n: 4000, concepts: 2600, categories: 150, domains: 27 });
  const rSteady = simulate({ manifest: steady });
  console.log(`      4,000-image tranche -> ${rSteady.sessions} sessions (${rSteady.reason})`);
  /*
   * MEASURED, NOT ASSUMED. The design docs said ~83 sessions from 4,000 images, which
   * is 4000/48 - image capacity. The real number is about a fifth lower, because the
   * matched arm needs three DISTINCT CONCEPTS left in one narrow category from one
   * source, and the concept cooldown keeps retiring candidates that are still
   * physically present. Image capacity was never the binding constraint.
   *
   * This bound is deliberately below the measured figure but well above the naive
   * image-count figure, so it fails if either the selector regresses or someone
   * re-derives the estimate from division again.
   */
  check('a 4,000-image tranche covers at least 60 sessions', rSteady.sessions >= 60,
    `${rSteady.sessions} sessions`);
  check('and fewer than the 83 that image count alone suggests', rSteady.sessions < 83,
    'if this passes silently the arithmetic has drifted back to images/48');

  // Sensitivity: the exemplars-per-concept ratio is the parameter most likely to be
  // wrong about a real source, so it is measured rather than assumed.
  for (const concepts of [1400, 900, 500, 300]) {
    const m = makeManifest({ n: 1400, concepts, categories: 60, domains: 12 });
    const r = simulate({ manifest: m });
    console.log(`      1400 images / ${concepts} concepts ` +
      `(${(1400 / concepts).toFixed(2)} per concept) -> ${r.sessions} sessions`);
  }

  /*
   * BREADTH BEATS DEPTH, AND BY A LOT. This is the least obvious result here and the
   * one with a direct instruction for the pipeline.
   *
   * Extra exemplars of a concept are nearly worthless. Burning one image cools its
   * concept for 90 days as target and 30 as foil, which makes every sibling exemplar
   * unusable for that window - so a second photograph of a spatula is not a second
   * item, it is dead weight that still costs bytes. The table above shows 1,400
   * images lasting 28 sessions at one image per concept and 7 at 4.67, a four-fold
   * difference at identical image count and identical served size.
   *
   * So the pipeline harvests ONE image per concept across as many concepts as
   * possible. Taking every exemplar a source offers is the intuitive move and it is
   * the wrong one.
   */
  const broad = makeManifest({ n: 1400, concepts: 1400, categories: 60, domains: 12 });
  const deep = makeManifest({ n: 1400, concepts: 300, categories: 60, domains: 12 });
  const rBroad = simulate({ manifest: broad }).sessions;
  const rDeep = simulate({ manifest: deep }).sessions;
  check('one image per concept lasts at least 3x longer than 4-5 per concept',
    rBroad >= rDeep * 3, `${rBroad} vs ${rDeep} sessions at the same image count`);

  // Too few narrow categories is the failure the matched arm dies of first.
  for (const categories of [60, 20, 6]) {
    const m = makeManifest({ n: 1400, concepts: 900, categories, domains: Math.min(12, categories) });
    const r = simulate({ manifest: m });
    console.log(`      1400 images / ${categories} categories -> ${r.sessions} sessions (${r.reason})`);
  }

  // Two sources must never be mixed inside one array, so a two-source pool is really
  // two pools. Worth measuring, because the naive reading is that it is one big pool.
  const twoSource = parseManifest({
    version: 1,
    items: makeManifest({ n: 700, concepts: 450, categories: 60, domains: 12, source: 'boss', prefix: 'b' }).items
      .concat(makeManifest({ n: 700, concepts: 450, categories: 60, domains: 12, source: 'oi', prefix: 'o' })
        .items.map(i => ({ ...i, concept_id: i.concept_id + '_oi' }))),
  });
  const rTwo = simulate({ manifest: twoSource });
  console.log(`      700+700 across two sources -> ${rTwo.sessions} sessions (${rTwo.reason})`);
  check('a split pool still works, because arrays are drawn within a source',
    rTwo.sessions >= 10, `${rTwo.sessions} sessions`);
}

/* ------------------------------------------------------------------- summary */

console.log();
if (fail) { console.log(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`ALL ${pass} CHECKS PASSED`);
