# Cognitive Practice

A small static web app for daily cognitive practice and measurement, served by
GitHub Pages and used in Safari on one Mac.

This repository holds **only what the site serves**. Design documentation,
methodology, the trial schema and the server-side endpoint are kept in a separate
private repository, because they describe an individual person.

## Contents

| Path | What it is |
|---|---|
| `diagnostic/index.html` | One-page hardware check. Standalone, no dependencies. Captures screen geometry and a physical-size calibration, and verifies four browser capabilities on the target machine: the data endpoint, speech synthesis, IndexedDB, and the `mousemove` sampling rate. |
| `app/config.js` | Deployment constants — endpoint URL, API token, version, fixed timings. |

The session app itself is not built yet.

## Design notes

**No build step, no framework, no dependencies.** Plain ES modules and vanilla
JavaScript targeting current Safari. The aim is that this still runs, and is still
readable, many years from now, with no toolchain to rot.

**Layout is derived from the measured viewport, never frozen in pixels.** Geometry
is expressed as fractions of a single unit:

```
u = min(viewport_w / 1.32, viewport_h / 0.825)
```

Browser zoom reduces `innerWidth` in CSS pixels while making each CSS pixel
physically larger, so a fraction-of-viewport layout preserves physical size and
therefore visual angle. A layout frozen in CSS pixels would not: an accidental zoom
change would silently alter target sizes and travel distances. The angular geometry
is the thing held constant; the pixel constants are not.

**Timing comes from `event.timeStamp` on the DOM event**, never from
`performance.now()` read inside the handler, because handler dispatch can be delayed
by tens of milliseconds under load. Stimulus onset is stamped in the
`requestAnimationFrame` callback following the paint.

**The network is never in the path of a timed task.** Results are buffered locally
and uploaded in a single batch after timing has finished.

## The token in `app/config.js`

It is public, deliberately. A static site cannot hold a secret, so the API token is
readable by anyone viewing source. It is not authentication — it is a filter against
undirected scanners, and a way to give each page strictly the authority it needs and
no more. The endpoint enforces scope server-side, and the diagnostic page's token
cannot write anything except diagnostic rows.

Each file checks its own token prefix at startup and refuses to run if the wrong one
is pasted in, because a swap would break nothing visibly while widening what the more
public page can do.

## Licence

Application code: MIT.

Image assets added later carry their own licences (CC0, CC BY, CC BY-SA) and are
attributed per file in `pool/ATTRIBUTION.csv`.
