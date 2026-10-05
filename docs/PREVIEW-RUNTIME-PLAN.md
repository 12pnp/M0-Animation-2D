# Preview runtime — plan

Goal: replace the official Spine runtime in the Preview panel, the stage's
posing (`boneburstPose`, and the solvers transcribed from spine-core) and the
Open-Spine path with our own code, so the shipped app contains **zero Esoteric
runtime code**. That removes the Spine Runtimes License from the product, and with it
the condition in `THIRD-PARTY-NOTICES.md` that *every user of the product must
hold their own Spine Editor licence*. The requirement is "anything but
spine-pixi-v8"; of the options, only one is actually clean, so the plan is
built on it.

## Options considered

1. **A community Spine runtime** (pixi-spine, etc.) — these are ports of the
   official spine-csharp and carry the Spine Runtimes License themselves
   (pixijs-userland/spine ships `SPINE-LICENSE`). Swapping one official-derived
   runtime for another changes nothing.
2. **DragonBonesJS (MIT)** — reads DragonBones data, not Spine JSON. A
   conversion layer loses meshes, constraints and physics, and parity becomes
   impossible. No.
3. **Our own preview runtime on PixiJS** (MIT, already vendored), fed by our
   own reader — the only route that removes Esoteric code from the build. This
   is the approach the Unity side already proved: the BoneBurst runtime plays
   Spine 4.3 data from scratch, held to bit-level parity against stock. **This
   plan.**

Some groundwork exists in this repo already, but not all of it is clean:

- **Ours, reusable:** `src/core/boneburst/` `importBoneBurst` and its `import*`
  helpers, `exportBoneBurst`, `atlas` (an atlas *writer* only), `transform`;
  `src/core/math/easing.ts`; `src/core/mesh/`.
- **Transcribed from spine-core, must be rewritten clean-room:**
  `src/core/math/ik.ts` (from `IkConstraint.apply1` / `apply2`) and
  `src/core/math/transformConstraint.ts` (from the transform constraint), both
  of spine-core 4.3.13 by their own headers. They are derived code under the
  Spine Runtimes License, so they cannot count as groundwork for an
  Esoteric-free build.
- **To audit:** `src/core/boneburst/types.ts` is modelled on spine-core 4.3.13's
  data classes; check whether it is a description of the format or a copy.

## What uses the official runtime today

As the plan started; each phase's status below says what it moved off it.

- **Preview panel / Play mode**: `preview.html` loads `/vendor/spine-pixi-v8.js`
  and plays the exported files frame by frame against the stage.
- **The stage**: `src/core/boneburst/boneburstPose.ts` imports spine-core and hands it
  the document's pose for any symbol that needs what the editor's own pose does
  not do: meshes and their weights and deform keys, inherit modes, transform,
  path, physics and slider constraints, clipping, draw order keys. This is not
  only opened files: rigs authored in BoneBurst with physics, slider or path
  constraints are posed this way too.
- **The stage's own solvers**: `src/core/math/ik.ts` and
  `transformConstraint.ts` are transcriptions of spine-core (see above). They
  import nothing at runtime but are derived code.
- **Open Spine file**: `src/io/import/spineFiles.ts` reads the atlas with
  spine-core's `TextureAtlas`; we have no atlas reader of our own.
- **Tests**: 20 test files import spine-core as the oracle (`spineParity`,
  `boneburstPose`, `spineTransform`, `spineImport`, `unityParity`,
  `fixtures/runtimeCheck.ts`, …). They stay; see P5.
- **AI**: `render_frame` in the MCP bridge screenshots the preview.

## Architecture

- The BoneBurst preview runtime (the pipeline in `core/`, the renderer in
  `src/preview/runtime/`):
  - a Spine 4.3 JSON reader into our own model (extend `core/boneburst/types`);
  - a pose pipeline: bones → world transforms → slots → attachments (region,
    mesh, linked mesh, bounding box, point, clipping) → skins → draw order;
  - an AnimationState equivalent: all timeline types (rotate/translate/scale/
    shear, inherit, attachment, color, deform, sequence, draw order, event, and
    the IK, transform, path, physics and slider constraint timelines) with
    mixing and crossfading — the Preview chains animations with
    `setMixDuration` (`src/preview/previewClient.ts`);
  - constraints: IK, transform, path, physics, slider — semantics from our own Unity
    specs (M0-Animation2D `Doc/Format`) and the public format documentation.
    **Never copy spine-core source**; behavioural parity only.
  - a PixiJS renderer adapter: sprites/meshes, clipping via masks, the
    two-colour tint shader the stage already uses;
  - an atlas reader (libgdx `.atlas` text) to replace `TextureAtlas` in
    `spineFiles.ts`.
- **The stage uses the same pose pipeline**: `boneburstPose.ts` switches from
  spine-core to the same pose. The DOM-free part of the pipeline (reader,
  pose, timelines, constraints) belongs in `core/`, so the stage and the
  Preview both import it; only the Pixi renderer adapter sits in
  `src/preview/runtime/`.
- **Dev-only oracle**: spine-pixi-v8 + spine-core stay in the repo but load
  only behind a dev flag / test setup, never in the shipped build. New vitest
  suites compare our runtime against the official one on golden exports — bone
  world transforms, vertex positions, slot colours, draw order — with the same
  tolerance scheme the Unity editor suites use (`max(1e-5, 1e-5·|v|)`),
  targeting exact match outside rounding.

## Phases

- **P0 — spike.** Reader + skeleton + region attachments + rotate/translate/
  scale timelines rendered in Pixi inside the Preview panel, behind a flag.
  Atlas reader, so `spineFiles.ts` drops `TextureAtlas`.
  **Done** (ARCHITECTURE ▸ The BoneBurst runtime): also shear, attachment,
  colour and draw order timelines and skins; `tests/spineRuntime.test.ts`
  matches spine-core on our exports and all 16 spine-unity samples, and
  `tests/atlasRead.test.ts` on every sample atlas. Not yet: crossfades (queued
  animations cut), events, debug draw beyond bones.
- **P1 — surfaces.** Meshes and deform timelines, linked meshes, skins, draw
  order, sequence sprites.
  **Done**: meshes weighted or not, linked meshes (their source's deform and
  sequence keys), deform keys, sequences and their keys in every mode, the
  bones a skin enables. `tests/spineRuntime.test.ts` also runs each sample
  under each skin, and fails on a check that compared nothing (P0's test had
  skipped every region). Seen in the Preview against spine-pixi: Goblins
  (linked meshes, deform, a skin) to 5e-7, the Dragon's sequence wings.
- **P2 — behaviour.** IK / transform / path / slider constraints, clipping,
  two-colour tint, events, inherit timelines.
  **Done.** Inherit modes and keys, IK, transform, path and slider
  constraints (with their keys, skin-only ones, the file's order), events,
  two-colour tint, clipping, crossfades. `tests/runtimeConstraints.test.ts`
  sweeps each solver's options on built rigs y up and y down;
  `tests/runtimeTrack.test.ts` steps the track beside `AnimationState`, plain,
  queued, crossfaded and interrupted; the samples run with every constraint
  but physics. Where 4.3 differs from what its author knew of 4.2 (crossfade
  modes, interrupted mixes, sliders) the behaviour was measured. IK and transform are written
  clean-room from the format's behaviour and the oracle tests, by someone
  working from the specs rather than from `ik.ts` / `transformConstraint.ts`;
  the new solvers then replace those two files on the stage too.
- **P3 — carried features.** Physics (4.3), remaining attachment types; the
  Open-Spine path switches to our reader for everything we parse; features we
  cannot yet compute degrade **visibly** (a warning chip on the preview), never
  silently.
  **Done.** Physics (`tests/runtimePhysics.test.ts`: the sample with physics
  and built rigs, stepped beside spine-core), bounding boxes and points. Open
  Spine already reads atlases with ours (P0); what is left of spine-core in
  `src/` is the stage's posing, P3b. The oracle tests now run every sample
  whole: nothing is taken out of the files.
- **P3b — the stage.** `boneburstPose.ts` poses through our pipeline instead of
  spine-core, for opened files and for authored rigs with physics, slider or
  path constraints alike. Gate: `tests/spinePose.test.ts` (the stage equals the
  export) and `tests/spineParity.test.ts` stay green with spine-core as the
  oracle only. Audit `types.ts`.
  **Done.** `boneburstPose.ts` builds our `Rig` from the same exported skeleton;
  both gates pass, and nothing in `src/` imports spine-core (the production
  editor bundle holds none of it). In the app, Stretchyman opened through
  File ▸ Open Spine matches spine-pixi in the Preview on every bone. The stage
  no longer draws a slot on a bone no shown skin enables (Spine's renderers
  skip it). `types.ts` is a description of the format, its fields named after
  what spine-core reads: no code of spine-core's. Left of spine-core's: the
  transcribed `core/math/ik.ts` and `transformConstraint.ts` the editor's own
  pose uses for authored rigs — to be replaced by `runtime/ik.ts` and
  `runtime/transform.ts` (P2's note), before P5.
- **P4 — parity gates.** Golden-file suites vs the dev oracle in CI; the
  default Preview flips to our runtime; the official runtime is reachable only
  through `--dev-oracle`.
  **Done.** What the Preview draws is decided in `core/boneburst/runtime/draw.ts`
  (`drawList`) and the Pixi adapter only applies it; `tests/runtimeDraw.test.ts`
  holds every triangle of it, every frame, to spine-core's `SkeletonRendererCore`
  (positions, UVs, colours, blend, page; clips by what they cover). It found the
  quad's triangles in the other order from Spine's. In CI the golden files are
  our exports (stickman, frog with its clipped eyelids) — spine-unity's samples
  are not in the repository and run where the folder exists — beside the oracle
  suites (`spineRuntime`, `runtimeConstraints`, `runtimeTrack`,
  `runtimePhysics`, `boneburstPose`, `spineParity`). The Preview plays ours by
  default; spine-pixi-v8 loads only in `npm run dev:oracle` (`vite --mode
  oracle`), and a build drops `dist/vendor/spine-pixi-v8.js`. In the app the
  frog's Preview is pixel-identical between the two. Left for P5: the file in
  the repository, the notices, and the transcribed `ik.ts` /
  `transformConstraint.ts`.
- **P5 — removal.** Delete `public/vendor/spine-pixi-v8.js` and the bundled
  spine-core from the shipped app; no file under `src/` imports
  `@esotericsoftware/*` and none is transcribed from it. spine-core stays a
  devDependency: the 20 oracle test files keep it, and CLAUDE.md's rule ("check
  Spine behaviour against spine-core in a test") stays as written. Update
  `THIRD-PARTY-NOTICES.md` (drop the Spine rows and the seat sentence), the
  About dialog, CLAUDE.md's Licensing section, and
  `../_Discuss/2026-10-05-amino-editor-licence-audit.md` (outside this repo);
  verify `dist/` contains no Esoteric bytes.
  **Done, but for the legal review (Risks).** The stage's IK and transform
  constraints are the runtime's solvers (`oneBone`, `twoBones`,
  `solveTransform`) on a `LooseBones` (`core/boneburst/runtime/bones.ts`); the
  transcribed `core/math/ik.ts` and `transformConstraint.ts` are deleted, their
  channel types moved to `core/doc/types.ts`. The switch found two runtime
  bugs, both measured and now in `tests/runtimeConstraints.test.ts`: a local
  pose derived from a mirrored world had its shear y 180° out, and an additive
  world shear y was wrapped before its mix. `public/vendor/spine-pixi-v8.js` and
  its licence are deleted; spine-core and spine-pixi-v8 4.3.13 (byte-identical
  to the vendored file) are devDependencies, the oracle served from
  `node_modules` under `npm run dev:oracle`. THIRD-PARTY-NOTICES.md, the About
  dialog, CLAUDE.md and the `_Discuss` audit are updated, and none of them says
  users need no Spine Editor licence. `grep -rn '@esotericsoftware' src/` prints
  nothing; no file in `src/` says it is transcribed; `dist/` holds no
  spine-core identifier, its only Esoteric mention the trademark line.

## Acceptance

- Preview still frame-matches the stage for everything the stage authors
  (existing check), and frame-matches the official runtime within tolerance on
  the golden files (new gate).
- `File ▸ Open Spine` works for 4.3 JSON + atlas (+ zip), unknown features are
  flagged, and the export round-trips byte-comparable to today.
- `dist/` ships zero Esoteric code; the notices file has no Spine Runtimes
  rows.
- `grep -rn '@esotericsoftware' src/` prints nothing, and no file in `src/`
  says it is transcribed from spine-core.

## Licence effect

**To confirm with someone qualified before relying on it:** that a clean-room
runtime for the Spine format lifts the Spine Runtimes License, that nothing in
the licence restricts writing one, and that users then need no Spine Editor
licence. The paragraph below is the intended outcome, not a settled reading.

After P5 the app is AGPL-3.0-or-later (Animo fork, unchanged) plus MIT/OFL
dependencies — no Spine Runtimes License text to ship, and the editor's users
no longer need Spine Editor licences. Two things do **not** change: artists who
author in the real Spine Editor still need their own seats, and the exports
remain the user's own content.

## Risks / open questions

- The claim that the Unity-side runtime holds bit-level parity, and the specs
  it rests on (M0-Animation2D `Doc/Format`), live outside this repo; link them
  before P2 depends on them.
- Clean-room discipline for IK and transform: whoever writes the new solvers
  should not work from the transcribed files they replace. (P5 replaced them by
  the runtime's, written without opening them; P5 itself read only their
  interfaces to swap the callers.)
- `src/core/boneburst/types.ts`, the JSON contract, says its field names and
  defaults were read out of spine-core's JSON parser: facts about the format,
  no code, but provenance the legal review should see.
- **The runtime's author is not clean-room (decided 2026-10-05).** P0–P2 are
  written by Claude, whose training includes the open-source Spine runtimes;
  it worked from the format's behaviour and spine-core as a black-box oracle,
  without opening spine-core's source, but it knows those algorithms, and the
  inherit modes and constraint solvers follow spine-core's structure closely
  (exact parity hardly allows otherwise). Get legal review of this before P5
  claims the app ships no Esoteric code; a human clean-room rewrite of the
  solvers from a written spec is the fallback.
- Preview fidelity becomes entirely our responsibility, per Spine version —
  the reader stays 4.3-gated exactly like the Unity side.
- Physics and mesh-deform edge cases are the hardest parity targets; schedule
  them last, with the strongest fixtures.
- Keep the dev oracle in the repo long-term (internal use is fine), or retire
  it after N green releases?
