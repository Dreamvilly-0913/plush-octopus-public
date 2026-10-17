# Plush Octopus — Material Studies / No. 072

A working recreation of the **"Claude Opus 5.5 · 15.21$"** result shown in the top half of the
Douyin comparison video <https://v.douyin.com/moV-7gpiz_Q/> (0:00–0:18; the bottom half, labelled
GPT-6.1, was not used). It is a real-time, interactive soft-body plush octopus — not a video or
a screenshot.

## Run it

Requires Node 20.19+. Check your installed version with `node --version`.

Public source repository: <https://github.com/Dreamvilly-0913/plush-octopus-public>.

```bash
git clone https://github.com/Dreamvilly-0913/plush-octopus-public.git
cd plush-octopus-public
npm install
npm run dev        # http://127.0.0.1:5193
npm run build      # production bundle in dist/
npm run preview    # serves dist/ on http://127.0.0.1:5194
```

## What you can do (as in the reference)

| Control | Behaviour |
| --- | --- |
| **Hand** | Grab the head or any arm and pull. Arms stretch (up to ~1.55× per segment) and drag/lift the body. Scroll — or put a second finger down — while holding to twist the plush about the line from your hand through its body. Drag empty table to orbit ("look around"), with a little inertia. |
| **Finger** | A fingertip hangs from above the frame over whatever is under the cursor. Nearby arm tips reach up for it; press to lower it — arms that touch it wrap round and hold on (counted in *HOLDING ON*). Release to lift: the octopus comes along and can be carried around. A sharp yank can shake an arm loose. |
| **Comb** | Camera eases in to a close-up and the fur gets more shells. Stroke the fur to lay the pile the way you brush: against the grain it turns darker, with it, it shines. Dragging off the octopus orbits. |
| **Fur** | Coral / Lilac / Lagoon swap instantly (top colour, cream underside, blush, sheen). |
| **Stuffing** | Shape-matching stiffness of the head (soft ↔ packed). |
| **Pile** | Fur length in mm. |
| **Internal damping** | How long the plush keeps wobbling (bouncy ↔ lazy). |
| Shake it / Squish / Toss / Smooth fur / Reset | Wobble in place, squash-and-rebound, throw up with spin, clear comb marks, reset pose and camera. |
| ¼ speed / Mesh / Pause | Slow motion, show the simulation particles/rods/wireframe, freeze the simulation. |
| Inside the experiment | Short notes on how the study works. |

The stats row shows the real simulation values: mass, head volume (% of rest, from the fitted
deformation), kinetic energy in mJ (480 g plush, 1 sim unit = 10 cm), and arms holding the finger.

## How it is built

* `src/sim/` — position-based soft body, fixed 600 Hz substeps:
  * head = shape-matched particle cluster (43 particles, 8-fold symmetric), Müller et al. rotation
    extraction; bottom particles get a floor footprint so the plush sits level;
  * arms = 8 Cosserat rods (Kugelstadt & Schömer 2016), 16 particles each, stretch–shear and
    bend–twist constraints with a rest curl at every tip, strain limiting, a soft "sewn-on" root;
  * arm constraints that end on the head treat it as a rigid body, so pulls lift and turn it;
  * floor friction, arm/head and arm/arm contact, finger capsule contact, reach and grip.
* `src/render/octopusView.js` — head mesh skinned to the cluster each frame, arm tubes rebuilt
  each frame from the rods (flattened two-tone cross-section, rounded curled tips), glossy bead eyes.
* `src/render/furMaterial.js` — `MeshPhysicalMaterial` (sheen) extended with instanced shell fur;
  strands come from a jittered 3-D hash in rest space (no UV seams), leaned by a paintable nap map;
  blush, stitched smile and back seam are procedural.
* `src/render/stage.js` — paper-grey backdrop, soft table shadow (light-view occlusion map blurred
  twice and mixed by occluder height) plus a contact term rendered from below; the finger.
* `src/cameraRig.js`, `src/interaction.js`, `src/ui.js`, `src/app.js` — camera presets/orbit,
  pointer handling per tool, the HTML overlay, and the frame loop.
* The overlay layout was measured from the recording (a 2560 × 1314 page) and scales with the window;
  narrow/portrait windows switch to a bottom-sheet panel.

## Open-source dependencies

The project uses open-source packages only. Three.js and Vite are MIT-licensed; Inter, Newsreader,
and IBM Plex Mono are licensed under SIL OFL 1.1. See
[`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) for versions and license locations.

## Assumptions and known differences

* The reference badge reads **"WEBGPU · LIVE"**. This build renders with WebGL2 and says so
  (**"WEBGL2 · LIVE"**) rather than claiming WebGPU.
* Buttons that are never pressed in the video (Shake it, Squish, Toss, Smooth fur, Reset, ¼ speed,
  Mesh, Pause) and the *Inside the experiment* panel (never opened) are implemented from their
  labels; their exact behaviour/content is inferred.
* Small text that is unreadable at the video's resolution — the footnote, the slider end labels
  (soft/packed, cropped/shaggy, bouncy/lazy) and the glyphs beside "THE SPECIMEN" — is approximated.
* The reference video may be sped up; physics uses real-world scale (gravity 9.81 m/s²).
* Fonts are close open substitutes (Newsreader, IBM Plex Mono, Inter), bundled locally via Fontsource.
* The narrow-screen layout is my own adaptation; the reference only shows a desktop window.
