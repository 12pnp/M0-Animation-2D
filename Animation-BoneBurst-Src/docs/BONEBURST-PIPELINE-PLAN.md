# BoneBurst pipeline — plan

**Status:** R0 done 2026-10-05 (below), **not verified** in Unity: opening this copy in
the Editor without it importing the editor folder was not checked. R1 done 2026-10-05 on
the editor's side (below); its C# side is not started. R2 done 2026-10-05 except the bake
round trip (below). R3 done 2026-10-05 for its motion half (AD-3, below); the detection
sidecar (AD-0..2) waits for an install decision. R4 done 2026-10-06 but for the first-hand
check in the browser (below). R5 not started. Left
of R0: repointing the M2 projects' `file:` references and retiring the old folders (R0
step 7), both owner calls.

Goal: one BoneBurst, from the artist's file to the game. The editor moves into
`/Users/pnp/Project Unity/M0-Animation-2D/Animation-BoneBurst-Src`, inside the new
`M0-Animation-2D` git repository, beside the Unity packages it feeds; the two sides share
one repository, one format contract, one set of specs and one parity discipline.

Drafted 2026-10-05; updated the same day for the new repository. `M0-Animation-2D` is
a copy of `M0-Animation2D` (the same three BoneBurst packages, `Tools~/ParityHarness`,
`Doc/Format/`, the vendored spine-unity samples) with a new git repository that has no
commit yet. Decisions marked **(owner)** are open; everything else is a recommendation the
phases below assume.

```mermaid
flowchart LR
    ART["Artist / AI<br/>Spine 4.3 JSON + atlas"] -->|"File ▸ Open Spine<br/>importBoneBurst.ts"| ED
    subgraph REPO["M0-Animation-2D (one git repository)"]
        subgraph ED["Animation-BoneBurst-Src (AGPL editor)"]
            RT["core/boneburst/runtime<br/>(TS BoneBurst runtime)"]
            AG["src/app/agent + mcp/boneburst-bridge.mjs"]
        end
        subgraph PK["Packages (proprietary)"]
            IMP["ta-creator-boneburst-import<br/>SkeletonJsonReader · BoneBurstBake"]
            CORE["ta-creator-boneburst<br/>Data · Core · Unity"]
            PH["Tools~/ParityHarness (.NET 8)"]
        end
        ED -->|"Export: Spine 4.3 JSON<br/>(BoneBurst profile, R1)"| IMP
        IMP -->|".sbdata (SBDF v1)"| CORE
        PH -.->|"R2: same poses as RT"| RT
    end
    AD["AnimatedDrawings sidecar<br/>(../../AnimatedDrawings)"] --> AG
```

## The workflow it serves

| # | Step | Today | Where it runs |
|---|---|---|---|
| 1 | Artist / AI-generated **Spine 4.3 JSON** in | File ▸ Open Spine (`core/boneburst/importBoneBurst.ts`), every M0 sample round-trips | editor |
| 2 | **AI edits** the animation | MCP bridge + Ask AI (`mcp/boneburst-bridge.mjs`, `src/app/agent/`, AI-RIG phases A–C done); AnimatedDrawings sidecar planned (ANIMATED-DRAWINGS-PLAN AD-0…4) | editor + bridge + sidecar |
| 3 | **Export** for Unity | File ▸ Export writes Spine 4.3 JSON + atlas + pages | editor |
| 4 | **Bake** to the efficient form | `.sbdata` (`SBDF` v1), lossless binary, 29–65 % of the JSON; Unity Editor only (`Assets/BoneBurst/Bake Folder...`) | Unity |

Players load only `.sbdata`. Unity's readers accept only stock Spine 4.3 exports
(`skeleton.spine` "4.3.x").

## Decisions

1. **"BoneBurst JSON" is Spine 4.3 JSON.** No new dialect: the editor already writes
   it, Unity's `SkeletonJsonReader` already reads it, both sides are gated on 4.3, and
   an artist's file and an editor export stay interchangeable. What makes it
   "BoneBurst" is a documented **subset and profile**: the fields both runtimes
   implement, written down once (D1 below). A dialect would need a second reader on
   each side and would cut the editor off from stock Spine tools. If a BoneBurst-only
   field is ever needed, it goes in an extension the stock readers ignore, never in
   a renamed key.
2. **The bake stays one implementation.** `.sbdata` is written by the C# baker that
   self-checks its curve rebuild. The editor hands off JSON; the editor-side bake (R4)
   only *drives* the Unity bake, it does not write `SBDF` itself, unless the owner
   wants bakes without Unity (R4b).
3. **Share specs and data, never code** — a licence boundary, not a style choice:
   - the editor is **AGPL-3.0** (an Animo fork); the Unity packages are **proprietary**
     ("Copyright (c) 2026, Panupun Dev"). Copying code either way would put Unity code
     under the AGPL or break it. Co-locating the folders is fine; they stay separate
     programs exchanging files.
   - what *is* shared: `Doc/Format/*.md` (specs), fixtures (exports and their expected
     poses), and test harnesses that read files.
4. **Repository layout: one new repository (decided 2026-10-05).** The editor lives in
   `M0-Animation-2D`'s own git history, under `Animation-BoneBurst-Src/`, brought in with
   `git subtree add` so its 108 commits come along (a plain copy would start it from
   nothing and lose the history CLAUDE.md and the plans point into). What this means:
   - **Licences per folder.** The repository then holds AGPL code (the editor) next to
     proprietary packages. That is allowed: they are separate programs that exchange
     files. But the editor folder keeps its `LICENSE`, `LICENSE-EXCEPTION.md` and
     `THIRD-PARTY-NOTICES.md`, the root says which licence covers which folder, and
     anyone given the repository gets the AGPL's rights to the editor folder.
   - **Unity never imports it**: `Animation-BoneBurst-Src/` is outside `Assets/` and
     `Packages/`. The root `.gitignore` must ignore the editor's `node_modules/` and
     `dist/` (the Unity template's rules do not).
   - **The editor's GitHub remote** (`12pnp/Amino-Spine2D-Src`) can still be updated with
     `git subtree push --prefix=Animation-BoneBurst-Src`, or retired; its GitHub CI only
     runs where it is pushed.
   - The old `M0-Animation2D` and `Amino-Spine2D-Src` folders are retired once R0 passes;
     nothing should keep writing to them (another session currently works in both).

## Phases

### R0 — Move (half a day)

1. **First commit of the Unity project.** `M0-Animation-2D` has no commit; commit the
   Unity project as it is (after checking `.gitignore` covers `Library/`, `Temp/`,
   `Logs/`, generated `.csproj`/`.sln`, which the template does), so the move lands on
   a known base. Land or drop the old project's uncommitted work first (the
   `Samples Custom` move, the AnimoTest folders, the licence files) so the copy is the
   state wanted.
2. **Bring the editor in with its history** (the editor's own working tree committed
   first; the other session's uncommitted files in it — `docs/AI-RIG-PLAN.md`,
   `src/styles/settings.css`, three docs — committed or set aside by that session):

   ```bash
   git -C "/Users/pnp/Project Unity/M0-Animation-2D" subtree add --prefix=Animation-BoneBurst-Src "/Users/pnp/Project Unity/Amino-Spine2D-Src" main
   ```

   Then add `Animation-BoneBurst-Src/node_modules/` and `Animation-BoneBurst-Src/dist/`
   to the root `.gitignore`, and run `npm ci` in the folder.
3. **Paths that assume `Project Unity/` siblings**, each becoming relative to the new root:

   | File | Today | After |
   |---|---|---|
   | `tests/fixtures/spineSamples.ts` | `../../../M0-Animation2D/Packages/com.esotericsoftware.spine.spine-unity/Samples~/…` | `../../../Packages/…` (from `tests/fixtures/`) |
   | `tests/unityParity.test.ts` | `../../M0-Animation2D` | `../..` (until R2 replaces it) |
   | `scripts/unity-check/` README, `dump.cs` | "the M0 project next to this one" | "the Unity project around this one" |
   | `docs/*` links to `../_Discuss/…`, `../AnimatedDrawings` | one level up | two levels up (`../../_Discuss/…`) |
   | `.claude/launch.json` | ports only | unchanged |

4. **Claude's memory** for this project is keyed by its path: copy
   `~/.claude/projects/-Users-pnp-Project-Unity-Amino-Spine2D-Src/memory/` to the new
   path's folder (`-Users-pnp-Project-Unity-M0-Animation-2D…`), or it is lost.
5. **The root `CLAUDE.md`** gains a short section: what `Animation-BoneBurst-Src/` is, that
   it is AGPL and a separate program, that its own `CLAUDE.md` governs work inside it, and
   that code never moves between it and the packages (decision 3).
6. **Done when** `npm test` and `npm run build` pass in the new place with the samples
   found (no suite skipped that ran before), Unity opens `M0-Animation-2D` without
   importing anything from the folder, and `git log -- Animation-BoneBurst-Src` shows
   the editor's history.
7. **(owner) Retire the old folders.** M2-Creator-All and M2-Sample-25DL-Shader take
   `com.module.ta-creator-boneburst` (and M2 the `-import` package) by `file:` path from
   **`M0-Animation2D`** (root CLAUDE.md §1). Before the old project goes, their
   `manifest.json` entries move to `M0-Animation-2D/Packages/…`, committed in their own
   repositories; until then the two Unity copies must not drift. `Amino-Spine2D-Src` can
   go once nothing more is committed there (another session still has uncommitted work in
   it: `docs/AI-RIG-PLAN.md`, `src/styles/settings.css`, three new docs).

**Result (2026-10-05).**
- Editor commit `6f41eba` (the rename and this plan) first; then in `M0-Animation-2D`:
  `bfd1aa6` the Unity project's first commit (2,196 files, 74 through LFS with the old
  repository's `.gitattributes`; `.gitignore` adds `.DS_Store` and the editor's
  `node_modules/`, `dist/`), `ad3f6dd` the `git subtree add` (108 editor commits
  reachable), `2eccbcf` the editor folder taken out of LFS: its history stores PNGs as
  plain blobs, which LFS rules made show as modified.
- Not in the plan: the old repository ignored `Assets/Samples/`, the new `.gitignore`
  does not, so the 2D package samples are committed (kept as the owner's `.gitignore`).
- **Missed, fixed during R2**: the first commit left out every `~` folder (914 files:
  spine-unity's `Samples~`, BoneBurst's `Tests/Editor/Data~`, `Tools~/ParityHarness`). A
  global `*~` rule in `~/.gitignore_global` hides them, and the new `.gitignore` lacked the
  old repository's `!Samples~/`, `!Data~/`, `!Tools~/`; now copied and committed.
- Paths: `spineSamples.ts` is `../../../Packages/…` from `tests/fixtures/`, not
  `../../Packages/…` as first written. The samples still come from spine-unity's
  `Samples~`, which the root CLAUDE.md says nothing reads any more (the packages read
  their vendored `Tests/Editor/Data~/samples/`); switching to that copy is for R1.
- `npm ci`, `tsc`, the suite (2,166 passed, `unityParity` skipped: no Unity dump, as
  before the move) and the build pass in the new place; the sample suites run.
- `.claude/launch.json` (ignored by git) and Claude's memory copied to the new path.

### R1 — One contract (2–3 days)

- **D1 — `Doc/Format/BoneBurst-Profile.md`** in the Unity package (the spec home, beside
  `Format-Json-Atlas.md`): the Spine 4.3 JSON subset BoneBurst writes and reads —
  header (`skeleton.spine`, `hash`, which spine-csharp requires), every attachment,
  constraint and timeline kind both runtimes implement, defaults, units, and what
  either side refuses. The editor's `core/boneburst/types.ts` and Unity's
  `SkeletonJsonReader` are each checked against it.
- **D2 — the behaviours both runtimes measured**, recorded in the existing specs
  (`Timelines.md`, `Constraints.md`, `AnimationState.md`), so neither side rediscovers
  them: the two P5 fixes (mirrored local-from-world shear, unwrapped additive world
  shear), spine-core's event volume/balance reading (P4), the quad triangle order
  (P4), 32-bit key times, π as 3.1415927.
- **Done when** each runtime's test suite cites the profile, and a field outside it
  fails loudly on both sides.

**Result (2026-10-05).**
- **D1** is `Packages/com.module.ta-creator-boneburst/Doc/Format/BoneBurst-Profile.md`, an
  overlay on `Format-Json-Atlas.md` (which already specifies every key as spine-csharp reads
  it, so a second copy would only drift): rules for every file, quoting the C# reader's
  errors; rules for files BoneBurst writes (`skeleton.hash` — `fps` is nonessential, and
  Unity stores it but never plays from it); where spine-csharp and spine-core disagree and
  which side BoneBurst takes (spine-csharp's, every time); what each side does with each part.
- **The editor checks it**: `core/boneburst/profile.ts` (`profileIssues`), table-tested in
  `tests/boneburstProfile.test.ts` (15 broken files, each caught; every spine-unity sample
  passes), and spineParity and spineImport hold every export they make to it.
- **D2 changed from the plan**: the behaviours were mostly already in Unity's specs. Of the
  editor's measured fixes, the mirrored decomposition and the unwrapped additive shear are in
  `Constraints.md` §5 and §7.4, π is in `Constraints-Path-Physics.md`; the profile's §5 lists
  them, and the editor's CLAUDE.md now sends runtime work to those specs first. What was
  missing was the two stock runtimes' disagreements (`fps`, event volume and balance, hash),
  now in the profile's §3.
- **Found on the way**, both checked against spine-core: a linked mesh is linked by naming a
  `source` (not by its `type`), its source can sit in another `slot`, and the source's deform
  and sequence keys play there too; the editor runtime had all three wrong (a cross-slot
  linked mesh drew nothing). Fixed, `tests/spineRuntime.test.ts` (fails on the old code). And
  4.3's `drawOrderFolder` was dropped silently by the editor runtime: now any animation section
  it does not play is on the Preview's chip. Playing it (Timelines.md §3.7 and its mixing
  rules in AnimationState.md) is new runtime work, not done.
- **Left (C# side)**: a C# test citing the profile, and the C# reader skipping unknown timeline
  names silently (stock behaviour; the editor's check reports them before export). Both need
  a Unity run; the samples path could also move to the vendored `Tests/Editor/Data~/samples/`.

### R2 — Close the loop: editor export → BoneBurst Unity runtime (3–5 days)

Today the editor's exports are checked against spine-core (vitest) and once against
spine-unity (`scripts/unity-check/`, phase 8, needs the Unity Editor). Neither is the
runtime the game ships.

- `Tools~/ParityHarness` already builds BoneBurst's `Data`, `Core` and `Import` runtime
  under .NET 8 without Unity. Add a mode that reads a folder of editor exports and
  writes every bone's world matrix, slot colour, attachment and draw order per frame
  as JSON.
- An editor test (`tests/boneburstUnity.test.ts`, skipped without `dotnet`) exports the
  fixtures, runs the harness, and compares with the editor's own runtime frame by frame,
  at the editor suites' tolerance. It replaces `unityParity.test.ts`'s dependence on a
  hand-run Unity dump (whose folder is already gone).
- Bake round-trip in the same run: harness bakes each export to `.sbdata`, reads it
  back, and the pose must not change.
- **Done when** stickman, frog and every authored fixture play identically in the
  editor's runtime and BoneBurst's C# runtime, baked and unbaked.

**Result (2026-10-05).**
- `Tools~/ParityHarness/Dump.cs` (`run.sh --dump <in> <out>`): reads each export with
  `SkeletonJsonReader`/`AtlasReader`, plays every animation through `BoneAnimationState` +
  `ManagedPose` as the Preview steps (0 s, then a fixed step, physics updating), writes every
  bone's world matrix, slot colour, drawn attachment and the draw order per frame.
- `tests/boneburstUnity.test.ts` exports 34 files, runs the dump once, and compares frame by
  frame: the stickman and frog exports, every spine-unity sample as it is, and every sample
  opened in the editor and exported again (the pipeline's step 1 → 3). **All 34 match**:
  worst 8.4e-4 in a matrix entry (raptor-pro-and-mask, a near-straight IK chain) and 3.5e-5 of
  the rig's size in position, float32 against float64; the bounds are 1e-3 and 1e-4. Breaking
  the editor's IK by 0.1 % fails it. Skipped, not passed, without the Unity version's .NET SDK
  or the project's `Library/`. The harness's own gate stays 215 of 215 bit-exact.
- Changed from the plan:
  - **The step is 0.0337 s, not 1/30 s.** At 1/30 s, frames land on attachment keys and on
    physics substep boundaries, where float32 (C#) and float64 (editor) time fall on opposite
    sides: four of the first ten failures were that, not the runtimes.
  - **Drawn attachments are compared**: the C# pose names a slot's attachment on an inactive
    (skin-only) bone, the editor reports what is drawn; neither draws it (Hero's chain).
  - **No bake round trip in the harness**: the bake's name keys hash through
    `UnityEngine.PropertyName`, an engine call .NET cannot make. **Left**: the editor's exports
    through `BakedDataTests` in the Editor (or a managed key hash for the harness).
  - `unityParity.test.ts` (stock spine-unity on a hand-run dump, whose folder is gone) is
    superseded for the pipeline, not deleted: stock spine-unity is no longer what plays the files.
- Linked meshes agree with the C# runtime on the samples that have them (Goblins 2,
  mix-and-match 6), none with its source in another slot: R1's cross-slot fix is held to
  spine-core only; a C#-side check needs a file that has one (a synthetic one in `Data~`).

### R3 — AI step (the existing plans, sequenced)

- AnimatedDrawings sidecar, `/Users/pnp/Project Unity/AnimatedDrawings` (two levels up
  from the editor) → configured by path in the bridge
  (`BONEBURST_IMAGE_PROVIDER=animateddrawings`); AD-0…AD-4 as in
  ANIMATED-DRAWINGS-PLAN, AI-RIG D and E after.
- Every AI edit stays one labelled command; every result is checked by `get_pose` /
  `check_preview`, now playing BoneBurst's runtime (P4).
- **Done when** AD-3: one BVH becomes a clip on an imported artist rig, and R2 passes on
  the result.

**Result (2026-10-05), AD-3 only.**
- **The detection half (AD-0..2) is not started**: AnimatedDrawings' joint detection runs on
  TorchServe with mmcv-full, mmdet and mmpose (Python 3.8, Java), none installed; mmcv-full has
  no Apple Silicon wheel. Owner's choice: the motion half first, no install. Its routes when
  wanted: Docker (AnimatedDrawings' own image) or a native build.
- **BVH → clips**: `core/rig/bvh.ts` (reader, forward kinematics) and `core/rig/bvhClip.ts`
  (each frame seen from the character's facing, taken from its shoulder and hip lines; limbs and
  torso as world angles, feet, hands and head as their limb's turn plus their own bend; in place,
  the hips rising only off the take's ground), `tests/bvh.test.ts` on a take with known answers
  and on AnimatedDrawings' own takes. Mixamo-style (FAIR, Rokoko) and CMU joint names.
- `scripts/buildBvhMotions.ts` writes `src/core/rig/motions-bvh.json` from AnimatedDrawings'
  takes (their motion configs give up axis and range): `wave_hello`, `dab`, `jumping` (front),
  `zombie_walk` (side, cut to 6 s), `dance` (front); 87 KB. The CMU take is left out (not
  redistributable). `list_motions` and `apply_motion` take them with the hand-made clips;
  THIRD-PARTY-NOTICES and About credit AnimatedDrawings (MIT).
- **Checked**: each clip fitted to the stickman by `apply_motion` in one undo step, the runtime
  showing what the retarget posed, feet never below the ground, the export playing it
  (`tests/agentApi.test.ts`); and the whole pipeline in R2's test: spine-unity's **Goblins**,
  opened in the editor, given `zombie_walk` with the guessed roles (the hips mapped to `hip`, which
  the legs hang from), exported, and posed the same by BoneBurst's C# runtime frame by frame.
- **Changed from the plan**: the artist rig is Goblins, not spineboy-pro. On spineboy-pro even the
  hand-made walk does not fit: its transform constraints (aim, hoverboard) override the keyed
  limbs, and the retarget models IK only; `apply_motion`'s check says so (`matches: false`).
  Retargeting through transform constraints is open work. Spineboy's front/rear names are also not
  guessed as near/far; the AI gives a map.
- The plan doc for this work, `docs/ANIMATED-DRAWINGS-PLAN.md`, is still uncommitted in the old
  `Amino-Spine2D-Src` folder (another session's); it did not come across in R0.

### R4 — Export to Unity in one step (2–3 days)

- **File ▸ Export to Unity…**: pick (once, remembered) a folder under M0's `Assets/`
  that a SmartAddresser rule covers (today `Assets/Samples Custom/BoneBurstDemo`); write
  JSON + atlas + pages there by File System Access, overwriting the previous export.
- The bake then runs in Unity: **R4a (recommended)** a file-watcher in
  `com.module.ta-creator-boneburst-import/Editor` rebakes a folder when its JSON
  changes (an `AssetPostprocessor` on the export's `.json`), then Apply & Index as the
  bake already does. **R4b (owner, only if bakes without Unity are needed)**: a CLI
  mode of ParityHarness that bakes a folder with the same C# writer — still one
  implementation, callable from the editor's bridge.
- An agent tool `export_to_unity` (one call: export, wait for the bake, report sizes),
  so step 2's AI can finish the loop.
- **Done when** an edit in the editor shows up baked in Unity's Play mode without
  touching Unity's menus.

**Result (2026-10-06).**
- **Unity (R4a)**: `BoneBurstRebakeOnChange`, an `AssetPostprocessor` in the import package's
  Editor assembly: when an export's file (`.json`, `.skel.bytes`, `.atlas.txt`, `.png`) is
  imported, its folder is rebaked after the import, with its previous settings, as the asset's
  Rebake command does, but only a folder baked before (`BoneBurstBake.WasBaked`, new). The first
  bake stays the popup: where the asset goes, scale, shader. A broken export is a warning, a
  refused bake an error; the bake's own output starts nothing.
  `BoneBurstRebakeOnChangeTests` (4, EditMode): never-baked is left alone; a changed export is
  rebaked keeping every GUID; a broken one is said, not baked; the output starts nothing. With
  the watcher switched off, two of them fail. Import Editor suite 22 of 22 through the live
  Editor (`run_tests`).
- **Editor**: File › Export to Unity… (`App.exportToUnity`, `io/export/UnityExport.ts`) writes
  the export into the document's remembered folder (IndexedDB store `unityExport`, database
  version 3), asking for one the first time; the atlas is `.atlas.txt`, and the skeleton is
  written last (`unityWriteOrder`) so the import that triggers the rebake sees a whole export.
  The AI's `export_to_unity` does the same through the page (`UnityExporter`), and refuses
  without a folder already granted (only a click can ask the browser again).
- **Not verified**: the loop by hand — pick a folder under `Assets/` in the browser, bake it
  once, edit, export again, see the rebake in Unity. The folder picker is the user's; the parts
  are each tested. Unity also imports only when it refreshes (its window focused, or Assets ›
  Refresh), so "without touching Unity" means without its menus, not without focusing it.
- Found on the way: the new repository has no `.claude/` (the old one tracked
  `.claude/skills/`: `parity-harness`, `unity-playtest`, `assembly-tier-check`,
  `managed-reference-check`, which the root CLAUDE.md names); another gap in R0's copy.
- Between the twin-export test's runs (`FindSource_WithJsonAndItsBinaryTwin_TakesTheJson`) the
  time swung from 13 s to a 185 s timeout, with and without the watcher: stock spine-unity's own
  importer reacting to a mismatched skeleton and atlas, not this change.

### R5 — Optional: desktop shell

`docs/REWRITE-PLAN.md`'s recommendation (Tauri v2 around the existing code, not a
rewrite) stands, with one correction: since PREVIEW-RUNTIME-PLAN P5 spine-core is no
longer bundled, so "the runtime in the same process" is our own runtime now, which any
shell keeps. A desktop shell also gives R4 plain filesystem access instead of a folder
permission prompt.

## Order and size

R0 → R1 → R2 are the backbone (about 1–2 weeks); R3 and R4 can run in either order after
R2; R5 is independent. R2 is the one that makes "go the same direction" checkable: from
then on, a change on either side that breaks the other fails a test.

## Risks

- **Licence boundary** (decision 3): the easiest mistake is pasting a solver from one
  side into the other "to stay in sync". Sync through D2's specs and R2's tests instead.
- **Two licence positions to align.** Unity's `Doc/Licence.md` (case B, original work,
  recommends written confirmation from Esoteric) and the editor's
  PREVIEW-RUNTIME-PLAN ▸ Risks (author not clean-room, legal review pending) should end
  up as one statement reviewed once, covering both runtimes.
- **Spine 4.3 only.** Both readers refuse other versions; an artist on Spine 4.2 or 4.4
  needs a re-export. Version support moves on both sides together, gated by R2.
- **Two copies of the Unity project.** Until R0 is done, `M0-Animation2D` and
  `M0-Animation-2D` can drift (another session is active in the old one). Pick a moment,
  copy what changed, retire the old one.
- **Repository size.** The editor brings 108 commits and `public/vendor/pixi.js`
  (2.4 MB) into the Unity repository's history; the old vendored spine-pixi file is in
  that history too (deleted at P5). Acceptable for one owner; a history filter could drop
  it if the repository is ever shared.
- **CI**: the editor's GitHub Actions run only on its old remote. In the new repository,
  R2 and the editor suites run locally and in the project's own gate (`paritygate.py`),
  until the new repository gets CI of its own.
