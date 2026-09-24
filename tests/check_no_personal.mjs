/**
 * Blocking check: nothing in this repository may describe the individual who uses
 * the app.
 *
 *   node tests/check_no_personal.mjs
 *
 * Exit code 1 on any hit, so it can gate a commit. This exists because a
 * non-blocking version of this scan already failed once: it printed three
 * third-person pronouns in code comments and the commit went ahead anyway,
 * because nobody read the output. A check that does not fail is not a check.
 *
 * Design documentation, clinical detail and anything locating a person live in a
 * separate private repository. Code here describes what the code does, in terms of
 * "the user" and "the target machine".
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'pool', 'filler']);

/**
 * This file is exempt from itself: it has to contain the words it searches for.
 * It is the ONLY exemption, and adding another should be treated as suspicious -
 * the usual correct fix is to rewrite the line or move the file to the private
 * repository.
 */
const SKIP_FILES = new Set(['tests/check_no_personal.mjs']);

/** Each pattern says why it matters, so a hit is actionable rather than cryptic. */
const PATTERNS = [
  [/\b(she|her|hers|himself|herself)\b/i, 'third-person pronoun: say "the user"'],
  [/\b(tigard|oregon)\b/i, 'location'],
  [/\b(stroke|infarct|ischemic|watershed|lesion|MRI)\b/i, 'clinical detail'],
  [/\b(dementia|amnesia|amnestic|apathy|cognitive impairment)\b/i, 'clinical detail'],
  [/\b(eyedrop|eye drops|medication|prescription)\b/i, 'medication'],
  [/\bspeech.?patholog|\bSLP\b/i, 'clinician'],
  [/\blives alone\b/i, 'living situation'],
  [/\b8[0-9][- ]year[- ]old\b/i, 'age'],
  [/\b(mum|mom|mother|grandmother|grandma)\b/i, 'relationship'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|html|css|json|md|txt|csv|yml|yaml)$/i.test(name)) out.push(p);
  }
  return out;
}

let hits = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split('\\').join('/');
  if (SKIP_FILES.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, why] of PATTERNS) {
      if (re.test(line)) {
        console.log(`  ${rel}:${i + 1}  [${why}]`);
        console.log(`      ${line.trim().slice(0, 100)}`);
        hits++;
        break;
      }
    }
  });
}

if (hits) {
  console.log(`\n${hits} line(s) must not be published. Rewrite generically, or move to the private repo.`);
  process.exit(1);
}
console.log('no personal, clinical or locating content in the public repo');
