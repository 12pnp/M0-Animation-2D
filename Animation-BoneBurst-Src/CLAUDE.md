# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

BoneBurst is Animo (github.com/justmorenoise/animo) retargeted from
DragonBones 5.5 to **Spine 4.3**. [docs/PLAN.md](docs/PLAN.md) is the plan: the
phases, the DragonBones→Spine mapping, and the checklist of export tests to
rebuild. Phases 0–9 are done: DragonBones is gone, `src/core/boneburst/` holds the
Spine 4.3 contract, the transform mapping and the exporter (ARCHITECTURE ▸ The
Spine 4.3 contract, The Spine exporter), File ▸ Export writes Spine files, and
the Preview panel runs our own Spine runtime (ARCHITECTURE ▸ The preview is
ground truth, The BoneBurst runtime; spine-pixi-v8 only under `npm run dev:oracle`), and the stage's eases and IK are Spine's own
(ARCHITECTURE ▸ Easing, Bones and IK). Nested symbols are flattened into the one
skeleton (ARCHITECTURE ▸ The Spine exporter ▸ Nested symbols are flattened), masks
are clipping attachments and colour offsets two-colour tint (ARCHITECTURE ▸ Mask
layers, Colour, alpha and blend mode). File ▸ Open Spine opens existing Spine
JSON for editing, and the stage poses such a rig through our own Spine runtime
(ARCHITECTURE ▸ Opening Spine files, The BoneBurst runtime). Any animation can be a cycle whose
last frame is frame 0 again, and each selected bone draws its path, which can be
dragged, bent with handles or baked to edit the animation (ARCHITECTURE ▸ Cycles, Bone
paths; the decisions are pure in `core/doc/cycle.ts`, `bonePath.ts`, `pathEdit.ts`,
`pathSpline.ts`). Draw order is keyable per animation (ARCHITECTURE ▸ Draw order keys,
`core/doc/drawOrder.ts`), and so are IK mix, bend and softness (ARCHITECTURE ▸ IK keys,
`core/doc/ikKeys.ts`). Animations fire events, with sounds (ARCHITECTURE ▸ Events,
`core/doc/events.ts`), and a Graph panel edits property curves and their eases
(ARCHITECTURE ▸ Graph editor, `core/doc/graphEdit.ts`). Transform constraints are
Spine 4.3's, solved on the stage by our runtime's solver (ARCHITECTURE ▸
Transform constraints, `core/boneburst/runtime/transform.ts`). An image can be a mesh,
made from its alpha, bound to bones by weights and keyed by deform (ARCHITECTURE ▸
Meshes, `core/mesh/`). Skins put their own images in slots and have bones and
constraints of their own, by spine-core's rules (ARCHITECTURE ▸ Skins, `core/doc/skins.ts`).
Bounding boxes, points, paths and sequences are made and edited (ARCHITECTURE ▸ Boxes and
points, Sequences); physics, slider and path constraints are solved by our runtime, which
poses any symbol that has one (ARCHITECTURE ▸ Physics, sliders and paths).
Constraints apply in the symbol's order (ARCHITECTURE ▸ Constraint order), keys can be offset
and keyed by group from the timeline (ARCHITECTURE ▸ Offset keys, Key buttons). Inherit modes
and physics, slider and path constraints are keyed (ARCHITECTURE ▸ Inherit modes, Physics,
sliders and paths); an opened file's meshes and linked meshes in every skin, weighted boxes
and paths, points with an offset and turned sequences become editable (ARCHITECTURE ▸ Meshes,
Boxes and points, Sequences); path constraints, attachment tints, deform keys in any skin, skins'
own boxes, points and paths, skin colours and a transform constraint's property map are the
model's too, keys between frames are written frame by frame, and the Unity check, which compares
attachment geometry and every skin, was rerun after phase L (ARCHITECTURE ▸ Checked in Unity).
An exporter change must keep
`tests/spineParity.test.ts` passing: it plays every fixture through spine-core
and compares it with the stage frame by frame. An importer or exporter change
must keep `tests/spineImport.test.ts` (every M0 sample round-trips) and
`tests/spinePose.test.ts` (the stage equals the export) passing. A change to our own runtime
(`core/boneburst/runtime/`, ARCHITECTURE ▸ The BoneBurst runtime) must keep
`tests/spineRuntime.test.ts`, `tests/runtimeDraw.test.ts` (what the Preview draws) and
`tests/atlasRead.test.ts` passing. The format both BoneBurst sides agree on is the profile in
`../Packages/com.module.ta-creator-boneburst/Doc/Format/BoneBurst-Profile.md`, and the runtime
behaviour is that folder's specs (`Timelines.md`, `Constraints.md`, …): read them before
changing the runtime, and keep `tests/boneburstProfile.test.ts` passing (every export the
parity and import suites make is held to the profile) and `tests/boneburstUnity.test.ts`
(the exports, every sample and every re-exported sample posed by the Unity package's C#
runtime through its parity harness, frame by frame; it skips without the harness's .NET). Phase 8 checked the
exports in Unity (ARCHITECTURE ▸ Checked in Unity, `scripts/unity-check/`): spine-csharp
is stricter than spine-core (it requires `skeleton.hash`), so a header or format change
should be rerun there. An AI edits the document through `src/app/agent/`
(ARCHITECTURE ▸ The AI bridge): a new editing ability becomes a tool there,
declared in `tools.json`, applied as one labelled command. Check Spine behaviour against
`@esotericsoftware/spine-core` in a test, the way `tests/spineTransform.test.ts`
does, rather than against documentation.

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing anything.**
It is the real project documentation: what Animo is, how it is layered, and —
mostly — the things that fail *silently* when you get them wrong. The DragonBones
5.5 contract, the Flash transform model, the undo rules, the preview as ground
truth, the DOM trap that has bitten twice. Find the section covering what you
are about to touch and read it first.

## Prose

Remove all mannered prose. Comment only non-obvious logic or non-trivial
decisions.

## Commands

```bash
npm run dev        # Vite on :5181 — open in Chrome or Edge
npm test           # vitest run
npm run build      # tsc --noEmit && vite build
scripts/check.sh   # build, test, and the two checks below (no spine-pixi in dist/, core/ imports)
npx tsc --noEmit   # typecheck alone; faster than a build while iterating
```

## The three rules a change must not break

1. `core/` imports nothing from `view/`, `app/` or `io/`, and touches no DOM:

   ```bash
   grep -rn 'from "@/\(view\|app\|io\)' src/core/    # must print nothing
   ```

2. A command **replaces** values, it never mutates them (`core/doc/freeze.ts`
   enforces it under vitest; `localStorage["animo.freezeValues"] = "1"` turns it
   on in a dev build).

3. Verify interactive fixes with **real mouse input**. A synthetic
   `element.click()` bypasses pointerdown/pointerup and passes even when the
   thing is broken.

## How a fix is written

- **Decisions go in pure functions.** A rule that decides something (which
  nodes a command takes, where a span ends, whether a paste nests a symbol)
  lives in a function with no store and no DOM, in `core/` or exported next to
  its caller, and gets a table test. The command, tool or panel only applies
  the result. Examples: `convertPlan`, `groupPlan`, `endAfterResize`,
  `resizedEmptyLength`, `emptyRange`, `pastedParent`, `rowsNestHost`,
  `pointInParent`, `uniformFactor`, `atlasKey`, `validEditDepth`.
- **Check it in the app too**, not only in vitest: `npm run dev` (port 5181),
  `window.animo.project.autosaver.stop()` first, load a fixture with
  `fetch('/tests/fixtures/projects/frog.boneburst')` +
  `animo.project.loadFrom(buf, { name }, false)`, then real clicks and drags
  (rule 3 above). The pane's console keeps errors across reloads: an error
  logged while Vite hot-reloads a half-edited pair of files stays listed.
- **A regression test must fail on the old code.** Check with
  `git stash push src/<file>`, run the test, `git stash pop` — never a
  command that reads stdin in between.

## Invariants the last bug hunt exposed

- **Structural commands act on the TOPMOST selected nodes** (`topmostSelected`,
  `groupPlan`). A node whose ancestor is selected moves with it; re-parenting
  it too flattened the rig.
- **`mergeWith` carries `before` as well as `after`** (`adoptBefore` in
  `core/history/Command.ts`): a node only a later step touched must still go
  back on undo.
- **Dirty tracking**: `History.push` drops `savedAt` once the saved step can no
  longer be reached (`>=`, not `>`). An async save compares
  `History.revision` before and after writing.
- **Every way into a symbol calls `wouldCreateCycle`**: library drop, paste,
  Paste Layers, Paste/drag Frames (`rowsNestHost`), convert, swap.
- **Partial spans stay partial**: Set Duration moves only the tracks that
  reached the old end; a frame drag keeps the frames after the range.
- **Bounds invalidation is transitive**: `invalidateBounds([id])` also drops
  every symbol measured through `id` (image or symbol). Any command that
  changes what a symbol shows, keys included, must invalidate it.
- **Placing at a pointer goes through the parent's space** (`pointInParent`,
  `reexpress`): a node's x/y are in its parent's frame.
- **The preview rebuild reuses the atlas** while `atlasKey` and the asset
  objects are unchanged; anything new the pages depend on must go in the key.
- **Export settings live in the document** (`Project.exportSettings`, see
  ARCHITECTURE ▸ Export settings). Absent = defaults = the old output; a new
  option needs a default that reproduces what was written before it.
- **A gesture that re-parents goes through `mayReparent`**, which refuses bones
  the IK solves unless the user turned the refusal off.
- **A transaction notifies once**, when it closes (`History.transaction`).
  Code inside one must not wait for a `doc` event to see its own changes.
- **No browser `prompt`/`confirm`/`alert`**: `view/widgets/dialogs.ts`
  (promises; re-check the target after the await). A step that can take over
  half a second runs under `busy(label, report => …)` and reports progress
  (ARCHITECTURE ▸ Dialogs and the progress card).
- **Library keys belong to the focused list** (ARCHITECTURE ▸ Folders and
  keys): it stops the keys it handles, so the stage never sees them. Folders
  are organisation only; names stay unique across the library.
- **Heavy pixel work runs on a worker** (`io/workers/`, see ARCHITECTURE ▸ Off
  the main thread) and falls back to the page on `WorkerCrashed`. The logic
  stays in a DOM-free module the worker imports (`resampleRgba`, `parsePsd`), so
  vitest tests it directly.

## Licensing

AGPL-3.0-or-later, inherited from Animo; keep `LICENSE`, `LICENSE-EXCEPTION.md`
and `THIRD-PARTY-NOTICES.md`. What the exporter writes is the user's (the
exception's second clause). No file or package of the Spine Runtimes ships: the Preview and the
stage pose Spine files with our own runtime (`core/boneburst/runtime/`,
docs/PREVIEW-RUNTIME-PLAN.md). `@esotericsoftware/spine-core` (the test oracle) and
`spine-pixi-v8` (the Preview's oracle under `npm run dev:oracle`) are dev
dependencies under the Spine Runtimes License: nothing in `src/` imports them, a
build holds none of them, and `scripts/check.sh` checks `dist/`. Whether users then need no Spine
Editor licence is the plan's open legal question (▸ Licence effect, Risks): do
not state it as settled.
