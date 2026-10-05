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
- ✅ Bone `inherit` modes: Properties ▸ Bone ▸ Inherit; the runtime poses such a rig
  (ARCHITECTURE ▸ Inherit modes)
- ✅ Bone colours and icons: Properties ▸ Bone, on the stage and in the Tree
- ✅ Compensate: the stage bar's Bones / Images, for every transform tool
- ✅ Hand (H) and Zoom (Z): drag to pan; click to zoom (Alt out), drag a rectangle to frame

### Attachments

- ✅ Region
- ✅ Clipping (from masks)
- ✅ Mesh: made from the image's alpha, points added, moved, deleted, triangulated (ARCHITECTURE
  ▸ Meshes); an opened file's meshes become editable, other skins' too (the Mesh tool edits
  the one the stage shows), their UVs, vertices, per-bone offsets and names kept
- ✅ Weighted mesh: bind to bones, auto weights, weight brush
- ✅ Linked mesh: another image of the node draws a mesh, with or without its deform keys
  (Properties ▸ Mesh); an opened file's become links, in any skin, to the source's skin
- ✅ Sequence (frame-by-frame region): made from numbered library images, keyed (a Sequence row);
  an opened file's become the document's with their keys, a rotated or scaled one keeping its
  turn
- ✅ Bounding box, point and path attachments: made and edited (box and point nodes, path nodes),
  a point's offset and turn in Properties ▸ Point; an opened file's become the document's,
  weighted ones following their bones
- ✅ Creating attachments other than regions and clippings: meshes, linked meshes, bounding
  boxes, points, paths and sequences

### Skins

- ✅ Several skins: made, renamed, deleted, shown alone or combined on the stage and in the
  Preview (ARCHITECTURE ▸ Skins); an opened file's skins become editable
- ✅ Skin placeholders (skin-only displays) and a skin's own image in each slot
- ✅ Skin bones and skin constraints, every kind

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
- ✅ Constraint order: Properties ▸ Constraints moves one up or down; the stage solves and
  the export writes in it; an opened file's order is kept (ARCHITECTURE ▸ Constraint order)

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
- ✅ Path, physics and slider constraint keys: a row per constraint, keyed from Properties
  in Animate mode (ARCHITECTURE ▸ Physics, sliders and paths); an opened file's keys between
  frames written frame by frame
- ✅ Inherit keys: an Inherit row under the bone
- ✅ Graph editor: values over time as curves, with handles (ARCHITECTURE ▸ Graph editor)
- ✅ Audio: an event's sound kept in the project, exported to `audio/`, played in the
  Preview at its volume and balance
- ✅ A waveform of an event's sound on the timeline (the Events row)
- ✅ Animation mixing: crossfading two animations in the Preview (`AnimationStateData.setMix`)
- ✅ Offset keys in time across many layers at once, staggered, wrapped round a cycle
  (Offset Keys…, ARCHITECTURE ▸ Offset keys)
- ✅ Key what changed, everything, or one group from the timeline toolbar (the Key button,
  ARCHITECTURE ▸ Key buttons)

### Import and export

- ✅ Export Spine 4.3 JSON, atlas (pages, scale, padding, power of two, premultiplied)
- ✅ Open Spine 4.3 JSON with its atlas, from files, a folder or a zip
- ✅ PSD import (layers as images)
- ✅ Checked in Unity (spine-csharp), phase 8 (`scripts/unity-check/`)
- ✅ Nonessential data: Export Settings ▸ Nonessential data (on by default)
- ✅ Image sequences from numbered images (Properties ▸ Sequence ▸ Make Sequence)
- ☐ Video and sprite-sheet export (planned for the desktop build, ARCHITECTURE ▸ Future
  export formats)

### Preview and checking

- ✅ Preview panel runs spine-pixi-v8, the export's own runtime
- ✅ spine-core parity tests: the stage against the export, frame by frame
- ✅ Preview mixing (Mix from … over … s, Play Mix) and the fired events listed
- ✅ Preview animation queue of any length, each crossfaded into
- ✅ Unity check rerun after phases A to J, attachment geometry and every skin included
  (ARCHITECTURE ▸ Checked in Unity)

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

### Phase G: export formats and tools (done but video, by choice)

1. Nonessential data options in Export Settings.
2. Hand and Zoom tools; Compensate; bone colours in the tree.
3. Video and sprite-sheet export (desktop build).

### Phase H: animation tools and the rest (done, docs/PHASE-H-PLAN.md)

1. Constraint order, edited and solved in order on the stage.
2. Offset keys (Spine's Offset tool), staggered and wrapped round a cycle.
3. The timeline's Key button: what changed, everything, or one group.
4. Waveforms of event sounds on the Events row.
5. A Preview queue of any length.
6. The Unity check rerun on rigs holding every format change since phase 8.

### Phase I: carried things made editable (done, docs/PHASE-I-PLAN.md)

1. Inherit modes and inherit keys.
2. Physics, slider and path constraint keys.
3. Opened meshes editable (UVs, vertices and per-bone offsets kept); linked meshes.
4. Opened boxes, points, paths and sequences become the document's where the model holds them.
5. Skin membership of physics, sliders and paths; bone icons.
6. The Unity check rerun, with a sample re-exported through the editor.

### Phase J: the rest of the carried attachments (done, docs/PHASE-J-PLAN.md)

1. Points with an offset, edited in Properties ▸ Point.
2. Rotated or scaled sequence regions, posed by the runtime.
3. Weighted boxes and paths, edited with the Mesh tool.
4. Other skins' meshes and linked meshes, the Mesh tool on the mesh the stage shows.
5. Keys between frames: constraint channels written frame by frame, inherit keys on the next
   frame.
6. The Properties panel laid out for a narrow column.
7. The Unity check rerun, now comparing attachment geometry and every skin.

Still carried: an attachment with a field the model does not hold (a tinted mesh), a mesh
an animation deforms other than the default skin's display 0, and boxes, points and paths in
a slot that skins fill.

## Not in scope

- Spine's own file format (`.spine` projects). This editor's document is `.boneburst`; Spine
  exchanges skeletons through its JSON export, which is what this plan targets.
- Spine's binary format (`.skel`): neither written nor opened. Games load the JSON export.
- Matching Spine's UI. The checklist is about what can be authored, not how Spine lays it
  out.
- Licensing: every user still needs a Spine licence for the runtimes
  (THIRD-PARTY-NOTICES.md).
