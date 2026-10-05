# Spine parity: checklist and plan

What the Spine 4.3 editor can author that this editor cannot yet, in the order to build it.
The checklist is the state on 2026-10-05. Tick an item when it is built, tested and has its
ARCHITECTURE section.

Legend:
- ✅ **built**: authored here, exported, played the same by spine-core.
- ◐ **carried**: an opened Spine file keeps it, the stage plays it through spine-core and the
  export writes it back, but nothing here creates or edits it.
- ☐ **missing**.

## Checklist

### Skeleton

- ✅ Bones: create (Bone tool), parent, length, setup pose, Setup / Animate modes
- ✅ Slots and region attachments (image layers, several displays per slot, attachment keys)
- ✅ Draw order, and draw order keys
- ✅ Blend modes, colour and two-colour tint (colour offsets)
- ✅ Clipping attachments (mask layers)
- ✅ Nested symbols, flattened into one skeleton on export
- ◐ Bone `inherit` modes: imported and exported (`Node.inherit`), not editable in Properties
- ✅ Bone colours: Properties ▸ Bone, on the stage and in the Tree (icons not built)
- ✅ Compensate: the stage bar's Bones / Images, for every transform tool
- ✅ Hand (H) and Zoom (Z): drag to pan; click to zoom (Alt out), drag a rectangle to frame

### Attachments

- ✅ Region
- ✅ Clipping (from masks)
- ✅ Mesh: made from the image's alpha, points added, moved, deleted, triangulated (ARCHITECTURE
  ▸ Meshes); an opened file's meshes are still carried, not editable
- ✅ Weighted mesh: bind to bones, auto weights, weight brush
- ◐ Linked mesh: carried
- ✅ Sequence (frame-by-frame region): made from numbered library images, keyed (a Sequence row);
  an opened file's sequences carried
- ✅ Bounding box, point and path attachments: made and edited (box and point nodes, path nodes);
  an opened file's carried
- ☐ Creating any attachment but a region or a clipping

### Skins

- ✅ Several skins: made, renamed, deleted, shown alone or combined on the stage and in the
  Preview (ARCHITECTURE ▸ Skins); an opened file's skins become editable
- ✅ Skin placeholders (skin-only displays) and a skin's own image in each slot
- ✅ Skin bones and skin constraints (IK and transform; path and physics ones carried)

### Constraints

- ✅ IK: one- and two-bone, bend, mix, softness; target dragging; the path of a chain bone
  drags through its target
- ✅ IK stretch, compress and scale y (4.3's `scaleY`, was uniform): solved on the stage, set in
  Properties ▸ IK
- ✅ Transform constraint: created, edited, keyed, solved on the stage (ARCHITECTURE ▸ Transform
  constraints); a remapped property table is kept but not edited
- ✅ Path constraint: made from bones (Make Path), edited; posed by the runtime
- ✅ Physics constraint: added and edited per bone; the stage simulates while it plays
- ✅ Slider constraint: an animation played by a bone value or a time
- ✅ Creating and editing path, physics and slider constraints (opened files' physics and
  sliders become editable; paths stay carried)
- ☐ Constraint order (Spine's order list); opened rigs keep the file's order
  (`constraintOrder`)

### Animation

- ✅ Keys per bone with per-channel eases: rotate, translate, scale, shear; property rows
  that key one property (Rotate, X, Y, Scale, Shear), like Spine's dopesheet
- ✅ Attachment keys, colour keys, draw order keys
- ✅ IK keys: mix, bend, softness (an IK row on the timeline; drag up or down for the mix)
- ✅ Eases: presets, custom cubic (Ease dialog), stepped; played as Spine samples them
- ✅ Onion skin (Spine's ghosting), cycles, bone paths (drag, bend with handles, bake)
- ✅ Auto key (`ui.autoKey`)
- ✅ Deform (mesh) keys: keyed with the Mesh tool, a Deform row (opened files' deforms carried)
- ✅ Event keys and the event list (an Events row and panel; ARCHITECTURE ▸ Events)
- ✅ Transform constraint keys (a row per constraint)
- ◐ Path, physics and slider constraint keys: carried; the editor sets their setup values only
- ◐ Inherit keys: carried
- ✅ Graph editor: values over time as curves, with handles (ARCHITECTURE ▸ Graph editor)
- ✅ Audio: an event's sound kept in the project, exported to `audio/`, played in the
  Preview at its volume and balance
- ☐ A waveform of an event's sound on the timeline
- ✅ Animation mixing: crossfading two animations in the Preview (`AnimationStateData.setMix`)
- ☐ Offset keys in time across many bones at once (Spine's Offset tool); the frame drag moves
  whole selections only
- ☐ Key everything, or key only what changed, from the timeline toolbar (Spine's key
  buttons per channel group)

### Import and export

- ✅ Export Spine 4.3 JSON, atlas (pages, scale, padding, power of two, premultiplied)
- ✅ Open Spine 4.3 JSON with its atlas, from files, a folder or a zip
- ✅ PSD import (layers as images)
- ✅ Checked in Unity (spine-csharp), phase 8 (`scripts/unity-check/`)
- ☐ Binary `.skel` export (smaller and faster to load; what most shipping games use)
- ☐ Opening a binary `.skel`
- ✅ Nonessential data: Export Settings ▸ Nonessential data (on by default)
- ✅ Image sequences from numbered images (Properties ▸ Sequence ▸ Make Sequence)
- ☐ Video and sprite-sheet export (planned for the desktop build, ARCHITECTURE ▸ Future
  export formats)

### Preview and checking

- ✅ Preview panel runs spine-pixi-v8, the export's own runtime
- ✅ spine-core parity tests: the stage against the export, frame by frame
- ✅ Preview mixing (Mix from … over … s, Play Mix) and the fired events listed
- ☐ Preview animation queue of more than two
- ☐ Unity check run after each format change in this plan (it has not been rerun since IK
  keys and softness)

## Plan

Each phase is one plan file when it starts (like docs/DRAW-ORDER-PLAN.md), and follows the
project's rules: the decision in a pure function with a table test, the command replacing
values, a spine-core parity case for anything exported, real mouse checks in the app, the
Unity check after a format change, and the AI bridge getting a tool for each new ability.
The order puts what animators use every day first, and what later phases build on before
them.

### Phase A: events and animation mixing (done, docs/EVENTS-PLAN.md)

Why first: every game uses events (footsteps, hits, sounds), and they are small. Mixing lets
an animator see transitions, which today needs the game.

1. **Model.** `SymbolItem.events: EventDef[]` (name, int, float, string, audio, volume,
   balance) and `Animation.events: EventKey[]` (frame, event, overrides). Schema bump. An
   opened file's carried events convert, the way IK keys did (`ikKeysOf`).
2. **Timeline.** An Events row under Draw order: a flag per key, drag to move, Delete,
   right-click to add an event and set its values. An Events panel or a Properties section
   for the list.
3. **Export / import.** `events` in the skeleton and an `events` timeline per animation;
   parity checks that spine-core fires each event on its frame.
4. **Preview.** Events listed as they fire; audio played when the event names a file.
5. **Mixing.** The Preview gets "from" and "to" animations and a mix duration
   (`AnimationState.setMix`); the stage stays one animation.
6. **AI.** `key_event`, `define_event`; `get_animation` lists events.

### Phase B: graph editor (done, docs/GRAPH-PLAN.md)

Why: the property rows already key one value at a time; a graph view is how Spine animators
shape those values, and it reuses the easing code.

1. A Graph panel showing the selected rows' values over time (rotation, x, y, scale, shear,
   IK mix), each key a point with its ease drawn as the curve spine-core plays.
2. Dragging a point moves the key (time and value); dragging a handle edits that interval's
   ease (`withEases` per channel, `withSpline` for x/y). The decisions are pure:
   `graphPoints`, `easeFromHandles`.
3. Tested against `applyTween` and spine-core's curve sampling; real mouse checks in the app.

### Phase C: transform constraint (done, docs/TRANSFORM-CONSTRAINT-PLAN.md)

Why: the most used constraint after IK (a bone copying another's rotation, scale or
position, or following it with an offset). It is a pure solve, like IK.

1. Port `TransformConstraint` from spine-core 4.3 into `core/math/transform.ts`, checked
   against spine-core in a test.
2. Model `TransformConstraint` (bones, target, the mix per channel, offsets, local/relative)
   next to `IkConstraint`, solved in `pose.ts` after IK in the constraint order.
3. A tool or a Properties section to add one, the timeline keys for its mixes (an IK-row
   style row), export and import (opened rigs' transform constraints become editable).
4. Parity: random rigs, as `IK: 60 random rigs` does.
5. AI: `add_transform_constraint`.

### Phase D: meshes (done but linked meshes and opened meshes, docs/MESH-PLAN.md)

Why: deformation (squash and stretch, faces, cloth) is what moves a Spine rig past cut-out
animation. It is the largest phase, so it comes after the cheaper wins.

1. **Mesh editing.** A Mesh mode for an image: hull from the image's alpha (the contour code
   in `core/atlas/contour.ts`), add and move vertices, edges, triangulation (a pure
   constrained Delaunay in `core/mesh/`). Opened meshes become editable.
2. **Weights.** Bind a mesh to bones, auto weights (by distance, as Spine's Auto), a weight
   painting tool, a weights view. Weighted vertices already export (`carry.ts`).
3. **Deform keys.** In Animate mode, moving vertices keys a deform (offsets from the setup
   vertices, or from the weighted pose); the timeline gets a deform row per mesh; export and
   import the `deform` timeline. Parity on vertices, as `spinePose.test.ts` already compares
   them.
4. **Linked meshes** (one mesh's shape for another image), after weights.

### Phase E: skins (done, docs/SKINS-PLAN.md)

Why: one skeleton for many characters or outfits. Needs attachments to be editable, so after
meshes.

1. Create, rename and delete skins; skin placeholders on slots; each attachment belongs to a
   skin. The default skin is today's displays.
2. Skin bones and constraints (a bone only some skins have).
3. Export and import skins fully (today the non-default skins are carried whole).

### Phase F: other attachments and constraints (done, docs/PHASE-F-PLAN.md)

1. Bounding box (hit areas), point (spawn points) and sequence (frame-by-frame) attachments:
   create and edit; sequence import from numbered images.
2. Path attachment and path constraint (bones following a curve).
3. Physics constraint (spine-core 4.2+ physics, posed with `Physics.update` in the Preview).
4. Slider constraint (4.3).
5. IK stretch, compress and uniform: port the rest of `apply1`/`apply2`.

### Phase G: export formats and tools (done but binary and video, by choice)

1. Binary `.skel` export, checked by reading it with spine-core's `SkeletonBinary` and
   comparing with the JSON export frame by frame; opening `.skel` files.
2. Nonessential data options in Export Settings.
3. Hand and Zoom tools; Compensate; bone colours in the tree.
4. Video and sprite-sheet export (desktop build).

## Not in scope

- Spine's own file format (`.spine` projects). This editor's document is `.animo`; Spine
  exchanges skeletons through the JSON or binary export, which is what this plan targets.
- Matching Spine's UI. The checklist is about what can be authored, not how Spine lays it
  out.
- Licensing: every user still needs a Spine licence for the runtimes
  (THIRD-PARTY-NOTICES.md).
