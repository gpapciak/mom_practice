/**
 * ?screens=1 — every screen the user will see, in order, for human review.
 *
 * WHY THIS EXISTS
 * ---------------
 * Probe A shipped incomprehensible with 262 automated checks passing. The suite tests
 * invariants: column order, interval arithmetic, boundary days, whether a guard
 * blocks. None of that can notice that a blue circle does not read as something to
 * click, or that an instruction shown once has been forgotten by trial three.
 *
 * Comprehensibility can only be judged by a person. What a tool can do is make that
 * judgement cheap: reviewing every screen should take a minute, not a ten-minute
 * session in which half the screens flash past and the rest have to be waited out.
 *
 * It renders the SAME builders the session uses, so reviewed copy cannot drift from
 * shipped copy. A reviewer seeing something other than what ships would be worse
 * than no review at all.
 *
 * THE RULE TO REVIEW AGAINST, for each screen, one at a time:
 *
 *   Does this screen make sense on its own, to someone who cannot carry an
 *   instruction forward from the previous screen, and who has nobody to ask?
 *
 * And three corollaries: is it obvious what to do; is it obvious what is being asked;
 * and if nothing is to be done, does it say so?
 */

import * as crt from './probe_crt.js';
import * as train from './probe_training.js';
import * as filler from './filler.js';
import * as layout from './layout.js';
import { rng } from './rng.js';
import { DEFAULTS } from './config.js';

/** Stand-in content, clearly marked so it is never mistaken for real rows. */
const SAMPLE = {
  item_id: 't:sample',
  prompt: 'Who is coming to visit?',
  answer: 'Chris, then Kathy the week after.'
};

function screens(config) {
  const line = (config.message_line || '').trim();
  return [
    {
      id: 'open',
      note: 'First thing seen. A greeting, how long it takes, one button.',
      html: `
        <div class="pane">
          <p class="lead">Good morning.</p>
          <p class="sub">Some practice — about ten minutes.</p>
          <button class="big primary" type="button">Start</button>
        </div>`
    },
    {
      id: 'greeting',
      note: 'Spoken here, because Safari drops speech before a user gesture.',
      html: `<div class="pane"><p class="lead">Good morning.</p><p class="sub">Let's begin.</p></div>`
    },
    {
      id: 'company_question',
      note: 'Asked once. Off the opening screen so the first thing seen is warm.',
      html: `
        <div class="pane">
          <p class="lead">Is someone with you right now?</p>
          <div class="choices">
            <button class="big" type="button">Yes</button>
            <button class="big" type="button">No</button>
          </div>
        </div>`
    },
    { id: 'training_prompt', note: 'Q: label, question, instruction smaller. Reveal button appears after 5s.',
      html: train.promptHtml(SAMPLE) },
    { id: 'training_prompt_revealed', note: 'The same screen once the button has faded in.',
      html: train.promptHtml(SAMPLE).replace(' hidden>', '>') },
    { id: 'training_answer', note: 'Answer supplied BEFORE the self-report. Three tiers.',
      html: train.answerHtml(SAMPLE) },
    { id: 'training_close_got', note: 'After a success.', html: train.closeHtml(SAMPLE, false) },
    { id: 'training_close_missed', note: 'After a miss: answered warmly, never marked.',
      html: train.closeHtml(SAMPLE, true) },
    { id: 'crt_instructions', note: 'Shows the layout with one lit, rather than only describing it.',
      html: crt.instructionsHtml() },
    { id: 'crt_field_waiting', note: 'Between trials. Home pad returns the cursor to centre.',
      html: crt.FIELD_HTML },
    { id: 'crt_field_lit', note: 'Onset. Solid, raised, ringed — and the reminder stays visible.',
      html: crt.FIELD_HTML.replace('id="crtLeft" data-side="left"',
        'id="crtLeft" data-side="left" class="crt-target lit"')
        .replace('<button class="crt-target" id="crtLeft"', '<button id="crtLeft"')
        .replace('<button class="crt-home"', '<button hidden class="crt-home"') },
    { id: 'crt_done', note: 'The end of the block is stated, not inferred.', html: crt.doneHtml() },
    { id: 'filler', note: 'Something to look at, and it says there is nothing to do.', html: '' },
    {
      id: 'close',
      note: 'Warm, brief, no summary of performance. Never a score.',
      html: `
        <div class="pane">
          <p class="lead">That's everything for today. Thank you.</p>
          ${line ? `<p class="sub">${line}</p>` : '<p class="sub">(message_line, if set)</p>'}
        </div>`
    },
    {
      id: 'session_inactive',
      note: 'config session_active = FALSE. The remote off switch.',
      html: `<div class="pane"><p class="lead">Nothing to do today.</p><p class="sub">Have a lovely day.</p></div>`
    }
  ];
}

export async function run(config) {
  layout.apply();
  const list = screens(Object.assign({}, DEFAULTS, config || {}));
  let i = 0;

  const host = document.getElementById('screen');
  const bar = document.createElement('div');
  bar.id = 'reviewBar';
  document.body.appendChild(bar);

  async function show() {
    const s = list[i];
    host.innerHTML = s.html;
    if (s.id === 'filler') {
      // Rendered live, so what is reviewed is the real thing rather than a mock-up.
      filler.run({ screenEl: host, ms: 9000, rand: rng('review'), photos: null });
    }
    const m = layout.measureScreen(host.querySelector('.pane, .crt') || host.firstElementChild,
      layout.unit());
    bar.innerHTML = `
      <span class="rv-n">${i + 1}/${list.length}</span>
      <strong>${s.id}</strong>
      <span class="rv-note">${s.note}</span>
      <span class="rv-fit ${m.fits ? 'ok' : 'bad'}">${m.extentU}u ${m.fits ? 'fits' : 'OVERFLOWS'}</span>
      <button id="rvPrev" type="button">&larr;</button>
      <button id="rvNext" type="button">&rarr;</button>`;
    document.getElementById('rvPrev').onclick = () => { i = (i + list.length - 1) % list.length; show(); };
    document.getElementById('rvNext').onclick = () => { i = (i + 1) % list.length; show(); };
  }

  document.addEventListener('keydown', ev => {
    if (ev.key === 'ArrowRight' || ev.key === ' ') { i = (i + 1) % list.length; show(); }
    if (ev.key === 'ArrowLeft') { i = (i + list.length - 1) % list.length; show(); }
  });

  await show();
}

export function screenIds(config) { return screens(Object.assign({}, DEFAULTS, config || {})).map(s => s.id); }
