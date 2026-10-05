# Preview runtime — plan

Goal: replace the official Spine runtime in the Preview panel, the stage's
posing (`spinePose`, and the solvers transcribed from spine-core) and the
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

- **Ours, reusable:** `src/core/spine/` `importSpine` and its `import*`
  helpers, `exportSpine`, `atlas` (an atlas *writer* only), `transform`;
  `src/core/math/easing.ts`; `src/core/mesh/`.
- **Transcribed from spine-core, must be rewritten clean-room:**
  `src/core/math/ik.ts` (from `IkConstraint.apply1` / `apply2`) and
  `src/core/math/transformConstraint.ts` (from the transform constraint), both
  of spine-core 4.3.13 by their own headers. They are derived code under the
  Spine Runtimes License, so they cannot count as groundwork for an
  Esoteric-free build.
- **To audit:** `src/core/spine/types.ts` is modelled on spine-core 4.3.13's
  data classes; check whether it is a description of the format or a copy.

## What uses the official runtime today

- **Preview panel / Play mode**: `preview.html` loads `/vendor/spine-pixi-v8.js`
  and plays the exported files frame by frame against the stage.
- **The stage**: `src/core/spine/spinePose.ts` imports spine-core and hands it
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
  `spinePose`, `spineTransform`, `spineImport`, `unityParity`,
  `fixtures/runtimeCheck.ts`, …). They stay; see P5.
- **AI**: `render_frame` in the MCP bridge screenshots the preview.

## Architecture

- The BoneBurst preview runtime (the pipeline in `core/`, the renderer in
  `src/preview/runtime/`):
  - a Spine 4.3 JSON reader into our own model (extend `core/spine/types`);
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
- **The stage uses the same pose pipeline**: `spinePose.ts` switches from
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
  two-colour tint, events, inherit timelines. IK and transform are written
  clean-room from the format's behaviour and the oracle tests, by someone
  working from the specs rather than from `ik.ts` / `transformConstraint.ts`;
  the new solvers then replace those two files on the stage too.
- **P3 — carried features.** Physics (4.3), remaining attachment types; the
  Open-Spine path switches to our reader for everything we parse; features we
  cannot yet compute degrade **visibly** (a warning chip on the preview), never
  silently.
- **P3b — the stage.** `spinePose.ts` poses through our pipeline instead of
  spine-core, for opened files and for authored rigs with physics, slider or
  path constraints alike. Gate: `tests/spinePose.test.ts` (the stage equals the
  export) and `tests/spineParity.test.ts` stay green with spine-core as the
  oracle only. Audit `types.ts`.
- **P4 — parity gates.** Golden-file suites vs the dev oracle in CI; the
  default Preview flips to our runtime; the official runtime is reachable only
  through `--dev-oracle`.
- **P5 — removal.** Delete `public/vendor/spine-pixi-v8.js` and the bundled
  spine-core from the shipped app; no file under `src/` imports
  `@esotericsoftware/*` and none is transcribed from it. spine-core stays a
  devDependency: the 20 oracle test files keep it, and CLAUDE.md's rule ("check
  Spine behaviour against spine-core in a test") stays as written. Update
  `THIRD-PARTY-NOTICES.md` (drop the Spine rows and the seat sentence), the
  About dialog, CLAUDE.md's Licensing section, and
  `../_Discuss/2026-10-05-amino-editor-licence-audit.md` (outside this repo);
  verify `dist/` contains no Esoteric bytes.

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
  should not work from the transcribed files they replace.
- Preview fidelity becomes entirely our responsibility, per Spine version —
  the reader stays 4.3-gated exactly like the Unity side.
- Physics and mesh-deform edge cases are the hardest parity targets; schedule
  them last, with the strongest fixtures.
- Keep the dev oracle in the repo long-term (internal use is fine), or retire
  it after N green releases?
