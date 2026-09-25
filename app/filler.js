/**
 * Filler: the low-demand interval between the things being measured.
 *
 * FOUR REQUIREMENTS, and the fourth is the one that was missed.
 *
 *   Low demand and pleasant.
 *   Non-verbal, and NOT a memory task - it must not interfere with what is being
 *   retained, and asking anything about it would make it one.
 *   Fixed duration, because the filler durations are what set the nominal retention
 *   delays for Probe B.
 *   SOMETHING TO ACTUALLY LOOK AT. The first version rendered a heading and then
 *   nothing for seventy-five seconds, because the fallback content was specified and
 *   never built. A blank screen for over a minute reads as a hang, and there is
 *   nobody in the room to ask.
 *
 * Photographs replace this once a family member has imported them. Until then these
 * are generated shapes: no assets, nothing to download, and deliberately
 * unmemorable - soft overlapping gradients with no edges, figures or symbols, so
 * there is nothing to encode even accidentally.
 */

/** One frame every this long. Slow enough to be restful, not slow enough to stall. */
export const FRAME_MS = 6000;

const PALETTES = [
  ['#cfe0ef', '#eaf1f6', '#b9cfe2'],
  ['#e6e2d3', '#f3efe4', '#d8d2be'],
  ['#dfe6dd', '#eff3ed', '#c9d6c6'],
  ['#e9dfe2', '#f5eef0', '#d7c7cc'],
  ['#dde3ea', '#eef2f6', '#c6d2df']
];

/**
 * A soft, edgeless composition. Radial gradients only: no shapes with outlines, no
 * repetition, nothing that resolves into an object.
 */
function artwork(rand) {
  const p = PALETTES[Math.floor(rand() * PALETTES.length)];
  const blobs = [];
  for (let i = 0; i < 5; i++) {
    const x = Math.round(rand() * 100);
    const y = Math.round(rand() * 100);
    const r = 32 + Math.round(rand() * 38);
    const c = p[Math.floor(rand() * p.length)];
    blobs.push(`radial-gradient(circle at ${x}% ${y}%, ${c} 0%, transparent ${r}%)`);
  }
  return { background: blobs.join(',') + `, ${p[1]}` };
}

/**
 * Runs the filler for exactly `ms`, then resolves.
 *
 * `photos` is reserved for imported blobs; when there are none it falls through to
 * generated art rather than to nothing.
 */
export async function run({ screenEl, ms, rand, photos }) {
  const frames = Math.max(1, Math.round(ms / FRAME_MS));

  screenEl.innerHTML = `
    <div class="pane">
      <p class="lead">Just something to look at.</p>
      <div class="filler" id="fillerStage"></div>
      <p class="instruction">Nothing to do here. It will move on by itself.</p>
    </div>`;

  const stage = screenEl.querySelector('#fillerStage');
  if (!stage) { await sleep(ms); return; }

  const useFrame = i => {
    const node = document.createElement('div');
    node.className = 'filler-art';
    if (photos && photos.length) {
      node.style.backgroundImage = `url(${photos[i % photos.length]})`;
      node.style.backgroundSize = 'cover';
      node.style.backgroundPosition = 'center';
    } else {
      Object.assign(node.style, artwork(rand));
    }
    stage.appendChild(node);
    // Next frame, so the transition has an initial state to animate from.
    requestAnimationFrame(() => node.classList.add('on'));
    // Keep the DOM small over a long filler.
    while (stage.children.length > 2) stage.removeChild(stage.firstChild);
  };

  const per = ms / frames;
  for (let i = 0; i < frames; i++) {
    useFrame(i);
    await sleep(per);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
