# Changelog — project work (Assets/Docs-Plan)

What changed in M0's project assets (scenes, the demo, the benchmark), newest first. Package changes have their own
changelogs (`Packages/<pkg>/Doc/CHANGELOG.md`). Each entry leads with the change, says why and what guards it.

```mermaid
flowchart LR
    DEMO["BoneBurstDemo.unity"] --> MM["mix-and-match-pro_BoneBurst<br/>+ _Lit2D variant"]
    TL["BoneBurstDemo.playable"] --> MM
    BEN["BoneBenchmark.unity<br/>stock · BoneBurst"] --> MM
    BEN --> MS["mix-and-match-pro_SkeletonData<br/>(stock side)"]
```

## 2026-10-06

- **Pipeline plan R5 (a desktop shell for the BoneBurst editor) skipped**, owner's decision (docs only): the editor stays a browser app. Plan: [BONEBURST-PIPELINE-PLAN.md](../../Animation-BoneBurst-Src/docs/BONEBURST-PIPELINE-PLAN.md).

- **The BoneBurst editor exports straight into Unity: File › Export to Unity…** (`Animation-BoneBurst-Src/`, editor). The document's folder is remembered (IndexedDB `unityExport`, database version 3); the atlas is `.atlas.txt`; the skeleton is written last so the import package's new `BoneBurstRebakeOnChange` rebakes a whole export. The AI's `export_to_unity` does the same once a folder is granted. Plan: [BONEBURST-PIPELINE-PLAN.md](../../Animation-BoneBurst-Src/docs/BONEBURST-PIPELINE-PLAN.md) R4. Guard: `tests/unityExport.test.ts`, the menu item seen in the app; editor suite 2,245 passed. **Not verified:** the loop by hand (the folder picker is the user's).

## 2026-10-05

- **The BoneBurst editor fits mocap: five AnimatedDrawings takes as motion clips** (`Animation-BoneBurst-Src/`, editor only). `core/rig/bvh.ts` reads BVH and poses its joints, `bvhClip.ts` reads each frame from the character's facing into the library's clip format, and `scripts/buildBvhMotions.ts` writes `wave_hello`, `dab`, `jumping`, `zombie_walk` and `dance` from AnimatedDrawings' MIT example takes (not the CMU one) for `apply_motion`. Why: step 2 of the pipeline, the AI animating a rig from real motion. Plan: [BONEBURST-PIPELINE-PLAN.md](../../Animation-BoneBurst-Src/docs/BONEBURST-PIPELINE-PLAN.md) R3 (AD-3). Guard: every clip fits the stickman in one undo step with the feet on or above the ground; spine-unity's Goblins, opened, given `zombie_walk` and exported, is posed the same by this project's BoneBurst C# runtime (editor suite 2,239 passed). **Not verified:** AnimatedDrawings' joint detection (AD-0..2, not installed); spineboy-pro, whose transform constraints the retarget does not model.

- **The `~` folders are in git: `Samples~`, `Data~`, `Tools~` (914 files).** The first commit left them out: a global `*~` rule in `~/.gitignore_global` hides them, and the new `.gitignore` lacked M0-Animation2D's re-includes (`!Samples~/`, `!Data~/`, `!Tools~/`), now copied. Why: BoneBurst's tests read `Data~` and spine-unity's `Samples~`, and the parity harness is `Tools~/ParityHarness`; a clone had none of them. Found by R2 of [BONEBURST-PIPELINE-PLAN.md](../../Animation-BoneBurst-Src/docs/BONEBURST-PIPELINE-PLAN.md). Guard: `git check-ignore` on the harness and the test data prints nothing.
- **M0-Animation-2D starts as a new repository, with the BoneBurst editor in `Animation-BoneBurst-Src/`.** The Unity project is committed as copied from M0-Animation2D (binaries through LFS with its `.gitattributes`), then the editor (AGPL, a separate program) is added with its 108 commits by `git subtree`, kept out of LFS, its `node_modules/` and `dist/` ignored, and its paths to the Unity project made relative to this root. Why: the editor writes the Spine 4.3 JSON the import package bakes; one repository keeps both moving together. Plan: [BONEBURST-PIPELINE-PLAN.md](../../Animation-BoneBurst-Src/docs/BONEBURST-PIPELINE-PLAN.md) (R0). Guard: the editor's suite (2,166 tests, the spine-unity samples found) and build pass in place. **Not verified:** Unity opening this copy; the M2 projects still take BoneBurst from M0-Animation2D (R0 step 7).

- **`manifest.json` takes `com.editor-tools.texturepacker`** (M1-Plugins-Custom, by `file:` path; `packages-lock.json` follows). Why: the editor tool the rim masks are painted from (the demo's `mix-and-match-pro_rim.png`, BoneBurst changelog 2026-10-02). Guard: the Editor resolves and compiles it, 0 errors; the BoneBurst suites above pass with it present.
- **Project assets renamed with the packages: `Assets/BoneBurstDemo`, `Assets/BoneBenchmark` (`-boneBench`), `Scenes/BoneBurstDemo.unity`, `Scenes/BoneBenchmark.unity`, `mix-and-match-pro_BoneBurst(_Lit2D).asset`, `BoneBurstDemo.playable`.** Moved with their metas (GUIDs kept); GameObject, timeline-clip, asset and material names changed through a `run_script` builder, then reserialized. Plan: [BoneBurst-Rename-Plan.md](../../Packages/com.module.ta-creator-boneburst/Doc/Review/BoneBurst-Rename-Plan.md). Every BoneBurst behaviour in the scenes resolves; the timeline loads 8 objects, 0 null. **Not verified:** Apply & Index and a player run (see the plan).

## 2026-10-02

- **Demo, timeline and benchmark on mix-and-match-pro; the spineboy-pro demo assets are gone.** The demo scene's four spineboys
  are mix-and-match-pro in `full-skins/girl` (CPU idle, CPU run with the timeline, GPU skinning, Lit2D + tint black
  through a new `mix-and-match-pro_BoneBurst_Lit2D.asset`), spaced 6 apart, with the camera fitted. The timeline's
  3 clips, both benchmark sides (a new `Skin` field; switch set idle, walk, run, pickaxe-action, shovel-run), and the
  stock material follow. `Assets/BoneBurstDemo/spineboy-pro*` deleted (owner); SmartAddresser Apply + Index (no
  row left, no duplicate index). Plan: [Demo-MixAndMatch-Plan.md](Demo-MixAndMatch-Plan.md). Why: owner, "remove
  spineboy-pro … convert to mix-and-match-pro_BoneBurst". Guard: Editor 433 + 1 skipped of 434, SpineUnity 24, play
  37, timeline 14 / 13, harness 215 of 215; a Scene-view capture of the five skeletons. New benchmark baseline at
  2000 (IL2CPP release): BurstCpu 3.95 / 3.85 / 5.46 ms against Stock 38.3 / 39.0 / 42.6 (idle / walk / switch),
  9.7× / 10.1× / 7.8×. The test-data sample `Tests/Editor/Data~/samples/spineboy-pro` stays, as the stock-parity corpus.
