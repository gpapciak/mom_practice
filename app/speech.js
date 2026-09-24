/**
 * Speech, used in exactly two places: the opening greeting, and the gentle
 * correction after a miss, where tone carries an intent that text on a screen
 * cannot. No per-trial audio — the user reads fluently, and a synthetic voice
 * repeating the same instruction hundreds of times is its own irritation.
 *
 * Never recorded human voices. A familiar voice speaking from a laptop to someone
 * with impaired memory and no context risks them believing that person is present
 * or has just called.
 *
 * THREE THINGS THIS MODULE EXISTS TO HANDLE
 * -----------------------------------------
 * 1. Safari silently drops speak() before any user gesture. So nothing is spoken
 *    on page load; the greeting fires on the START click, which is the gesture.
 *
 * 2. The voice list loads asynchronously, and the FIRST utterance of a page is the
 *    one most likely to be dropped. warm() is called on that same gesture and
 *    awaits voiceschanged before the first speak().
 *
 * 3. speechSynthesis fails quietly in several ways. Recording the config setting
 *    would leave a variable in the analysis that had been silently off for weeks,
 *    so every utterance reports an OUTCOME taken from its onstart/onerror events.
 *
 * The honest limit: we can prove the browser started speaking, never that a sound
 * left the laptop. OS-level mute is undetectable here, which is why a person
 * confirmed audibility once by hand.
 */

/**
 * The target machine has 223 voices installed, so "the system default" is not a
 * stable choice — if it ever changed, the tone of the miss correction would change
 * with it, and tone is the entire reason that line is spoken rather than printed.
 * So a voice is pinned by name, with fallbacks, and whichever was used is recorded
 * in the session row.
 */
const PREFERRED = ['Samantha', 'Ava', 'Allison', 'Susan', 'Karen', 'Moira'];

let voices = [];
let chosen = null;
let warmed = false;

export function available() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Call on the START gesture, before the first utterance. */
export function warm(timeoutMs = 1500) {
  if (!available()) return Promise.resolve({ voices: 0, voice: null });
  if (warmed) return Promise.resolve({ voices: voices.length, voice: nameOf(chosen) });

  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      warmed = true;
      voices = window.speechSynthesis.getVoices() || [];
      chosen = pick(voices);
      resolve({ voices: voices.length, voice: nameOf(chosen) });
    };

    voices = window.speechSynthesis.getVoices() || [];
    if (voices.length) { finish(); return; }

    // Fires once the list is populated. The timeout is the fallback for the case
    // where it never fires at all, which does happen.
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

function pick(list) {
  if (!list || !list.length) return null;
  for (const want of PREFERRED) {
    const v = list.find(x => x.name === want);
    if (v) return v;
  }
  // Fall back to an en-US local voice, then anything English, then the default.
  return list.find(v => v.lang === 'en-US' && v.localService)
      || list.find(v => v.lang === 'en-US')
      || list.find(v => (v.lang || '').startsWith('en'))
      || list.find(v => v.default)
      || list[0];
}

function nameOf(v) { return v ? v.name : null; }

export function voiceName() { return nameOf(chosen); }
export function voiceCount() { return voices.length; }

/**
 * Speaks, and resolves with the outcome. Never rejects and never blocks the
 * session: a failed utterance is logged, not recovered from.
 *
 * Resolves 'not_attempted' | 'fired' | 'failed' | 'unsupported'.
 */
export function say(text, { rate = 0.95, timeoutMs = 3000 } = {}) {
  if (!available()) return Promise.resolve('unsupported');

  return new Promise(resolve => {
    let done = false;
    const settle = outcome => { if (!done) { done = true; resolve(outcome); } };

    let u;
    try {
      u = new SpeechSynthesisUtterance(text);
    } catch (e) {
      settle('failed');
      return;
    }
    u.rate = rate;
    if (chosen) { u.voice = chosen; u.lang = chosen.lang; }

    u.onstart = () => settle('fired');
    u.onerror = () => settle('failed');

    try {
      window.speechSynthesis.speak(u);
    } catch (e) {
      settle('failed');
      return;
    }

    // An utterance that neither starts nor errors is the quiet failure this
    // whole outcome field exists to catch. Without a timeout it would look like
    // a pending success forever.
    setTimeout(() => settle('failed'), timeoutMs);
  });
}

/** Stop anything in flight, e.g. when a session is abandoned mid-correction. */
export function cancel() {
  try { if (available()) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
}
