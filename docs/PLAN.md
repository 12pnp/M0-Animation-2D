# Amino Spine2D — plan

A clean copy of Animo (the Flash-style DragonBones editor, github.com/justmorenoise/animo) retargeted at
**Spine 4.3**. It exports Spine JSON and atlas files, opens existing Spine files for editing
in the browser, and later lets an AI drive the editor. The preview stays ground truth: it
plays the exported bytes through the official `@esotericsoftware/spine-pixi-v8` 4.3 runtime,
which matches M0-Animation2D's spine-csharp 4.3.40.

```mermaid
flowchart LR
    subgraph EDITOR["Amino Spine2D (browser)"]
        DOC["core/doc<br/>Project · Node · Keyframe"]
        HIST["core/history<br/>Command · History"]
        EXP["core/export/exportSpine.ts"]
        IMP["core/import/importSpine.ts"]
        AGENT["app/AgentApi.ts<br/>ops → Commands"]
        STAGE["view/viewport<br/>SceneRenderer (Canvas2D)"]
        PREV["preview/previewClient<br/>spine-pixi-v8 4.3"]
    end
    SPINE["name.json · name.atlas · name.png"]
    AI["Claude (tool use / MCP)"]
    UNITY["M0-Animation2D<br/>spine-unity 4.3 · SpineBurst"]
    IMP --> DOC
    AGENT --> HIST --> DOC
    DOC --> STAGE
    DOC --> EXP --> SPINE
    EXP -->|"same bytes, in memory"| PREV
    SPINE --> IMP
    SPINE --> UNITY
    AI --> AGENT
```

## Starting point

Animo is about 33k lines of vanilla TypeScript (Vite, vitest, 710 tests). About 70% of it
does not depend on the output format: the document model, the Flash frame logic, undo,
panels, tools, the library and PSD import. The parts tied to DragonBones are few and clearly
separated. Each one gets a Spine replacement:

| Area | Animo (DragonBones 5.5) | Amino Spine2D (Spine 4.3) |
|---|---|---|
| Contract | `core/export/dbTypes.ts` | `spineTypes.ts`, with the field list read from spine-ts 4.3 `SkeletonJson` (not docs) |
| Transform | Flash `skX skY scX scY` | exact: `rotation = skY`, `shearX = 0`, `shearY = skX − skY`, plus a y-flip (Spine is y-up) |
| Rotation tweens | subdivided over 170° | not needed: Spine 4 interpolates raw degrees |
| Easing | port of DB's curve sampler | port of Spine's bezier sampler (10 segments per key); presets like bounce and elastic are baked into extra keys |
| IK | copy of DB's `IKConstraint` | copy of Spine's `IkConstraint.apply1/apply2` (softness, stretch, compress) |
| Atlas | DB atlas JSON | libgdx `.atlas` text; the MaxRects packer is kept |
| Symbols | child armatures | **flattened**: child bones inlined as `inst/bone`, child timelines baked into each parent animation |
| Masks | `ANIMO_masks` Pixi extension | native **clipping** attachment (polygon traced from alpha); soft edges are lost, with a warning |
| Tint offsets | not possible | exact through two-colour tint: `dark = tint·amt`, `light = 1 − amt + tint·amt` |
| Blend | 9 modes | normal, additive, multiply, screen |
| Motion blur | Pixi extension | dropped in v1 |

## Opening Spine files: meshes decide the scope

11 of the 15 sample rigs in spine-unity's `Samples~` use meshes (spineboy-pro 10, raptor 10,
goblins 21, mix-and-match 219), and celestial-circus also uses physics. Animo has no mesh
support at all, so an importer that skips meshes can open almost no real file. Import therefore
comes in two stages:

1. **Imported meshes are displayed and kept, but not editable.** The stage draws weighted and
   deformed meshes with Spine's own vertex maths (Canvas2D, textured triangles). Bone
   animation, draw order, slots, colour and keys stay fully editable. Meshes, weights, deform
   keys, path, transform, physics and slider constraints, events and extra skins are carried
   through to the export unchanged, keyed by name. If the edits break a name they rely on,
   the export refuses and names the problem.
2. **Mesh editing** (vertices, weights, deform keys) is a later project of its own.

Import reads `.json`, `.atlas` and the page PNGs. It cuts the regions back into library
images, turns `curve` values into per-property easing, and lists everything it could not
represent. The round-trip test is `export(import(x))`, loaded by spine-pixi and compared
bone by bone against `x` over the M0 sample skeletons.

## AI control

The editor's command layer is already the API: every edit is an undoable `Command`. An
`AgentApi` exposes a small JSON operation set: list bones, pose a bone at a frame, set an
ease, create an animation, add a keyframe range, and read back world positions from the
preview. Every operation goes through History, so an AI edit can be undone like a manual
one, and the AI checks its own result against the runtime. Two ways to connect:

- an **in-app prompt panel** that calls the Claude API with these ops as tools (the key is
  held by a small proxy, never in the page);
- an **MCP server** bridging to the open page, so Claude Code or Desktop can drive it.

## Phases

| # | Phase | Done when |
|---|---|---|
| 0 | **Done.** Clean copy, new git repo, DragonBones vendor, exporter and extensions removed, branding renamed | 631 tests green (79 export tests listed below), build clean |
| 1 | **Done.** `core/spine/types.ts` (contract read from spine-core 4.3.13), `core/spine/transform.ts` (mapping, relative keys, `keyTime`, `regionCentre`) | checked against the real runtime; 8 deliberate bugs each fail |
| 2 | **Done.** `core/spine/exportSpine.ts` and `core/spine/atlas.ts`; File ▸ Export writes `.json`, `.atlas`, pages | spine-core plays every fixture symbol as the stage draws it, every frame; the real packer's output loads in the browser |
| 3 | **Done.** Preview and Play mode on spine-pixi-v8 4.3.13 / PixiJS 8.21; one build per edit, per-symbol skeletons over one atlas | every stickman bone (IK included) matches the stage on every frame through the real preview, 3.5e-5 px; found and fixed the IK bend inversion |
| 4 | **Done.** Stage eases evaluated as Spine plays them, exported as native beziers (frog `body` 107 KB → 7.5 KB); IK solver replaced by a transcription of Spine's | parity on a three-segment curve, every quad ease, 7 targeted and 60 random IK rigs; the old solver failed 3 of the 7 |
| 5 | **Done.** Symbol instances flattened into one skeleton: content bones at −pivot, slots in the instance's place, the child's own looping timeline laid run by run onto the exported animation, alpha cascaded, IK inside carried | the nested rig, all 11 frog symbols and the real preview match the stage frame by frame; 8 deliberate flattening bugs each fail a test |
| 6 | Clipping, two-colour tint, blend modes, loss warnings | mask rigs match the preview |
| 7 | Import, stage 1 (meshes shown and carried through) | round trip over the M0 samples |
| 8 | Unity check: exports imported in M0 `Assets/AnimoTest/Spine` | spine-unity 4.3 plays them |
| 9 | AgentApi, then the prompt panel and MCP | an AI-made walk cycle can be undone and matches the preview |

## Licences

- **Animo's licence still applies.** Starting from a clean copy does not change this:
  Amino Spine2D is a derivative of Animo, so it stays AGPL-3.0-or-later, and `LICENSE`,
  `LICENSE-EXCEPTION.md` and the notices are kept. Hosting it publicly means publishing
  the source.
- **The Spine runtimes need a Spine Editor licence** for whoever integrates them. That
  includes the vendored spine-pixi preview.

## Tests to rebuild on the Spine exporter

Phase 0 removed 79 tests that read DragonBones output. Each rule is now a Spine test (ported or replaced), dropped with a reason, or deferred to the phase that brings the feature back. The three tests that kept everything but their export assertion have it back (phase 2).

### `export.test.ts` (whole file)

- [x] exportSkeleton > emits slots in reverse layer order, so the top layer draws in front — ported: `spineExport.test.ts`, and draw order in `spineParity.test.ts`
- [x] exportSkeleton > normalises the pivot against the untrimmed image size — ported: region centre in `spineExport.test.ts`; trimmed and half-scale atlas placement too
- [x] exportSkeleton > writes 5.5 with a matching compatible version — ported: 4.3 header in `spineExport.test.ts`
- [x] exportSkeleton > renames colliding bones rather than emitting an ambiguous rig — ported: `spineExport.test.ts`
- [x] exportSkeleton > reports symbols that contain each other instead of recursing — ported: `spineExport.test.ts` ▸ nested symbols
- [x] exportSkeleton > gives nested symbols a default action, so they are not left frozen — dropped: Spine has no child skeletons; phase 5 flattens instead
- [x] frameSplit > emits offsets from the bind pose, not absolute values — ported: `spineExport.test.ts`
- [x] frameSplit > puts the SHEAR delta in `skew`, not the raw skewX delta — ported: shearY in `spineExport.test.ts`
- [x] frameSplit > emits scale as a MULTIPLIER of the bind scale — ported: `spineExport.test.ts`
- [x] frameSplit > omits tweenEasing entirely for a hold, and writes 0 for linear — ported: stepped vs linear in `spineExport.test.ts`
- [x] frameSplit > durations accumulate to the animation length and end with a zero frame — ported: runtime duration in `spineExport.test.ts` ("animation length")
- [x] frameSplit > returns null for a track that never leaves its bind pose — ported: `spineExport.test.ts`
- [x] frameSplit > subdivides a rotation wider than half a turn — replaced: 720° in one key, `spineExport.test.ts` (Spine interpolates raw degrees)
- [x] frameSplit > exports a counter-clockwise tween as the long way round, subdivided — ported: `spineExport.test.ts` and `spineParity.test.ts`
- [x] frameSplit > never turns a held wide rotation into a slide — ported: stepped holds in `spineExport.test.ts`, and `spineParity.test.ts`
- [x] frameSplit > carries 'Rotate CW x N' through as extra whole turns — ported: `spineExport.test.ts` and `spineParity.test.ts`
- [x] colour > emits a colorFrame timeline with multipliers as 0..100 percentages — ported: rrggbbaa in `spineExport.test.ts`
- [x] colour > emits a timeline even when every authored colour is neutral — ported: `spineExport.test.ts`
- [x] colour > emits nothing when no keyframe carries a colour at all — ported: `spineExport.test.ts`
- [x] colour > tweens colour on the stage the same way the export does — ported: `spineParity.test.ts`, frame by frame
- [x] colour > holds colour across a span with no tween — ported: `spineParity.test.ts`
- [x] colour > falls back to the bind colour when the track carries none — ported: `spineParity.test.ts`
- [x] colour > writes a non-neutral bind colour as slot.color — ported: `spineExport.test.ts`
- [x] colour > warns that colour offsets are dropped by the Pixi runtime — ported: `spineExport.test.ts`; carried in phase 6 (two-colour tint)
- [x] colour > exports a blend mode on an image slot — ported: `spineExport.test.ts`, with the unsupported-mode warning
- [x] partial spans > keeps a late track's keys on their own frames, holding the bind pose before them — ported: `spineExport.test.ts`
- [x] partial spans > hides the slot before the first key and after the span ends, as the stage does — ported: `spineExport.test.ts` and `spineParity.test.ts`
- [x] partial spans > emits no display timeline for a track that covers the whole animation — ported: `spineExport.test.ts`
- [x] partial spans > agrees with the stage frame by frame on a layer that ends early — ported: `spineParity.test.ts`
- [x] library names the runtime looks things up by > refuses two images with one name, which would share one SubTexture — ported: `spineExport.test.ts`
- [x] library names the runtime looks things up by > refuses two exported symbols with one name, which would share one armature — dropped: symbols are flattened, not looked up by name; every bone name is checked for clashes instead
- [x] library names the runtime looks things up by > says nothing about a clash nothing on the stage uses — ported: `spineExport.test.ts`

### `extensions.test.ts` (whole file)

- [x] extension manifest > is null for a project that needs nothing beyond the skeleton — dropped: no extension manifest; masks become clipping in phase 6
- [x] extension manifest > marks masks REQUIRED and motion blur optional — dropped: no extension manifest; masks become clipping in phase 6
- [x] extension manifest > leaves motion blur out when disabled or with a closed shutter — dropped: no extension manifest; masks become clipping in phase 6
- [x] extension manifest > writes only multipliers other than 1, by slot name, and skips excluded layers — dropped: no extension manifest; masks become clipping in phase 6
- [x] extension manifest > documents the required and optional extensions in the README — dropped: no extension manifest; masks become clipping in phase 6
- [x] motion blur in the document > is undoable at both levels, leaving no key behind — dropped with motion blur (plan: dropped in v1); the document field is untouched
- [x] motion blur in the document > survives a round trip through migration and validation, repaired — dropped with motion blur (plan: dropped in v1); the document field is untouched
- [x] motion blur maths > affine helpers invert and compose — dropped with motion blur
- [x] motion blur maths > turns elapsed animation time into the shutter fraction of a frame — dropped with motion blur
- [x] motion blur maths > gives the same trail at 60 Hz and 120 Hz for the same motion — dropped with motion blur
- [x] motion blur maths > blurs nothing at the pivot of a pure rotation and most at the tip — dropped with motion blur
- [x] motion blur maths > re-expresses the field in filter UV space consistently — dropped with motion blur
- [x] motion blur maths > switches with hysteresis rather than at one cut-off — dropped with motion blur
- [x] installExtensions > warns about an unknown REQUIRED extension and stays quiet about an optional one — dropped: no runtime extension file
- [x] installExtensions > re-links a mask when a target swaps its display object — dropped: no runtime extension file
- [x] installExtensions > ignores something that is not a manifest — dropped: no runtime extension file

### `displays.test.ts`

- [x] export > writes every used display, each with its own pivot — ported: `spineExport.test.ts` and `spineParity.test.ts`
- [x] export > leaves out a display no key uses, remapping the ones after it — ported: `spineExport.test.ts`
- [x] export > exports a symbol reached only through an extra display — ported: flattened where the display shows it, `spineExport.test.ts` and the nested rig in `spineParity.test.ts`

### `ik.test.ts`

- [x] IK in the export > writes ik[] the way the parser reads it — ported: `spineExport.test.ts`, loaded by spine-core
- [x] IK in the export > leaves out what the parser already defaults — ported: `spineExport.test.ts`

### `layers.test.ts`

- [x] exclude from export > removes the bone, the slot, the timeline and the image — ported: `spineExport.test.ts`
- [x] exclude from export > does not export the armature or the art of a symbol only an excluded layer uses — ported: `spineExport.test.ts` ▸ nested symbols
- [x] exclude from export > still exports a symbol that a kept layer uses too — ported: `spineExport.test.ts` ▸ nested symbols
- [ ] exclude from export > drops an excluded mask, and an excluded target, from the sidecar — deferred to phase 6 (masks)
- [x] empty layers > export as nothing at all — no bone, no slot, no timeline — ported: `spineExport.test.ts`
- [x] empty layers > keeps its bone when a kept node is parented under it — ported: `spineExport.test.ts`
- [x] exclude from export > takes the whole subtree of an excluded group with it — ported: `spineExport.test.ts`
- [x] exclude from export > leaves the names of the layers it keeps alone — ported: `spineExport.test.ts`, and on the real rig in `realProject.test.ts`

### `masks.test.ts`

- [ ] mask export > writes mask links as slot names, not as anything in the skeleton — deferred to phase 6 (masks)
- [ ] mask export > warns and skips a mask layer with no artwork to clip with — deferred to phase 6 (masks)
- [ ] mask export > carries several targets under one mask — deferred to phase 6 (masks)

### `nestedSymbols.test.ts`

- [x] exporting a symbol instance's transform point > puts it on the display, where it moves the slot and not the bone — ported: a content bone at −pivot, bones on the instance untouched, `spineExport.test.ts`
- [x] exporting a symbol instance's transform point > writes no display transform when the point is where it started — ported: no offset on the content bone, `spineExport.test.ts`

### `project.test.ts`

- [x] project round trip > produces a byte-identical export after a round trip — ported: `project.test.ts`

### `realProject.test.ts`

- [x] the fixture itself > exports without errors, with the mask link the rig carries — ported: every symbol exports without errors, `realProject.test.ts`; the mask link in phase 6
- [x] empty layers and Exclude from Export on the real rig > an empty layer changes nothing about the exported file — ported: `realProject.test.ts`
- [x] empty layers and Exclude from Export on the real rig > excluding the mask layer removes its bone, slot and mask link — ported (bone, slot, image): `realProject.test.ts`; the link in phase 6
- [x] empty layers and Exclude from Export on the real rig > is undoable, byte for byte — ported: `realProject.test.ts`
- [x] empty layers and Exclude from Export on the real rig > leaves the other rows of the same symbol named exactly as they were — ported: `realProject.test.ts`
- [x] Swap Instance on a real node > swaps an image for a symbol, and the export follows — ported: `realProject.test.ts`
- [x] Replace Image on an image used by several rows > re-anchors the exported pivot, exactly as the toast warns — ported: region centre after Replace Image, `realProject.test.ts`

### `stickmanRig.test.ts`

- [x] stickman rig > exports one clean armature with both animations — ported: `stickmanRig.test.ts`

### `symbols.test.ts`

- [x] ConvertToSymbol > exports the instance as a child armature — ported (flattened): `symbols.test.ts`

### `easing.test.ts`

- [x] per-property eases > a hold holds every channel, whatever the overrides say — ported: `spineExport.test.ts`
- [x] per-property eases > the override reaches only its own timeline — ported: `spineExport.test.ts`
- [x] per-property eases > an eased turn past half a revolution is cut at every frame, on the stage's values — replaced: eased intervals are baked per frame (`spineExport.test.ts`) and checked by `spineParity.test.ts`
