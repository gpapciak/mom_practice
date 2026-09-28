/**
 * The screens that are not part of a probe: opening, greeting, the company question,
 * the close, and the nothing-today screen.
 *
 * They live here as pure functions of config so that the session and the ?screens=1
 * review render the same markup. They were previously duplicated in both places,
 * which meant reviewed copy could drift from shipped copy - and a review that shows
 * something other than what ships is worse than no review.
 *
 * NO NAME APPEARS IN THIS FILE, and none may.
 *
 * This repository is public. A name is not something a pattern-matching content gate
 * can catch - names cannot be enumerated, and a gate listing the one to look for
 * would itself publish it. So the protection is structural instead: the only slot for
 * a name is `display_name`, it is empty in the compiled-in defaults, its value lives
 * in the private Sheet, and a test asserts the default stays empty. The code cannot
 * leak a name because the code never holds one.
 */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * "Hello, <name>." or plain "Hello." - never "Good morning".
 *
 * The example uses a placeholder deliberately. Writing a real value here, even in
 * a comment, is how a name reaches a public repository - and it is what happened on
 * the first draft of this very file.
 *
 * There is no schedule and no expectation of one. A time-of-day greeting is wrong
 * whenever it is wrong, and being told "good morning" at four in the afternoon is
 * exactly the kind of small incoherence that makes a machine feel untrustworthy to
 * someone who cannot check the time against anything.
 */
export function hello(config) {
  const name = String((config && config.display_name) || '').trim();
  return name ? `Hello, ${esc(name)}.` : 'Hello.';
}

/** Opening: a greeting, how long it takes, one large button. Nothing else. */
export function openHtml(config) {
  return `
    <div class="pane">
      <p class="lead">${hello(config)}</p>
      <p class="sub">Some practice — about ten minutes.</p>
      <button id="start" class="big primary" type="button">Start</button>
    </div>`;
}

/** Spoken here, on the far side of the START click, because Safari drops speech
 *  before a user gesture. Text and speech say the same thing. */
export function greetingHtml(config) {
  return `
    <div class="pane">
      <p class="lead">${hello(config)}</p>
      <p class="sub">Let's begin.</p>
    </div>`;
}

export function greetingSpeech(config) {
  const name = String((config && config.display_name) || '').trim();
  return name ? `Hello, ${name}. Let's begin.` : "Hello. Let's begin.";
}

/**
 * The company question.
 *
 * THREE options, not two, and the third is the one that matters.
 *
 * The purpose is that a session done with company and one done alone are different
 * measurements. But "with company" covers three situations that affect the data
 * completely differently:
 *
 *   alone             nothing to account for
 *   someone present   a social-facilitation effect on speed and effort
 *   someone helping   the responses may not be the user's own at all
 *
 * A yes/no question collapses all three, and the one that actually threatens the
 * measure - being helped - becomes invisible. That matters most over the coming
 * months, because the amount of company is expected to fall, so the mix will shift
 * exactly while the series is being read for change.
 *
 * Worded so that being helped is plainly allowed. Nothing here should make help feel
 * like cheating; the point is only to know.
 */
export function companyHtml() {
  return `
    <div class="pane">
      <p class="lead">Is anyone with you just now?</p>
      <div class="choices three">
        <button class="big" data-value="alone" type="button">I'm on my own</button>
        <button class="big" data-value="someone_present" type="button">Someone's here</button>
        <button class="big" data-value="someone_helping" type="button">Someone's helping me</button>
      </div>
      <p class="instruction">Any answer is fine. It just helps us understand the day.</p>
    </div>`;
}

/**
 * The close. Warm, brief, and never a summary of performance.
 *
 * `closing_note` is config rather than code, so its wording can be settled without a
 * deploy. The default is a plain thank-you: praise for effort is the register used
 * with children and with patients, and the brief rules out both registers. It
 * is also the thin end of performance feedback - a comment that varies is a score,
 * and one that never varies is noise, soon skipped over.
 *
 * That is a judgement for whoever knows the user, so it is a config value and
 * not a decision made here.
 */
export function closeHtml(config) {
  const name = String((config && config.display_name) || '').trim();
  const note = String((config && config.closing_note) || '').trim();
  const line = String((config && config.message_line) || '').trim();
  /*
   * "That's everything for today" is FIXED and not configurable.
   *
   * The first version said only that the practice was finished, held that for three
   * seconds, and was then replaced by the opening screen with a Start button. Watched
   * in use, that read as "I finished and it made me start again" - and Start was
   * pressed, which began a second session.
   *
   * Two things follow. The screen now states that the day is done, not merely that
   * something ended; and it is the LAST thing shown, never replaced. See main.js.
   */
  return `
    <div class="pane">
      <p class="lead">You've finished the practice${name ? ', ' + esc(name) : ''}.</p>
      <p class="sub">That's everything for today.${note ? ' ' + esc(note) : ''}</p>
      ${line ? `<p class="instruction">${esc(line)}</p>` : ''}
    </div>`;
}

/**
 * Shown instead of the opening screen when today's practice is already done.
 *
 * Because the app is one click away in the Dock, and someone who cannot reconstruct the
 * last half hour has no way to know whether they have already done it. Offering Start
 * again asks a question they cannot answer, and answering it wrongly costs a duplicate
 * session in the record and a repeated ten minutes of their day.
 *
 * It states the fact and closes the matter. No Start button, nothing to decide.
 */
export function alreadyDoneHtml(config) {
  const note = String((config && config.message_line) || '').trim();
  return `
    <div class="pane">
      <p class="lead">${hello(config)}</p>
      <p class="sub">Today's practice is already done. Nothing more to do.</p>
      ${note ? `<p class="instruction">${esc(note)}</p>` : ''}
    </div>`;
}

/** The remote off switch: config session_active = FALSE. */
export function inactiveHtml(config) {
  return `
    <div class="pane">
      <p class="lead">${hello(config)}</p>
      <p class="sub">Nothing to do today. Have a lovely day.</p>
    </div>`;
}
