# Cycles and bone paths — plan

Two features that go together:

1. **Every animation can be a cycle.** Mark it as a cycle and the editor keeps its
   last frame the same pose as frame 0, shows where the loop joins, and plays and
   onion-skins across that join.
2. **Bone paths.** Each selected bone draws the path it follows on the stage,
   frame by frame, so you can see how it moves. On a cycle the path is a closed loop.
   The path can be dragged to edit the animation, with spline handles between keys.

Read first: ARCHITECTURE ▸ Animation length, Onion skin, Bones and IK, The preview is
ground truth, and the `endsAtLastFrame` note on `Animation` in `core/doc/types.ts`.

## What exists

| Piece | Where | State |
|---|---|---|
| Loop flag | `Animation.playTimes` (0 = forever) | Stored and exported. Nothing in the UI sets it. |
| Spine timing | `Animation.endsAtLastFrame` | The last frame is the loop's join, so it must repeat frame 0's pose. Opened files and `create_animation` set it; animations made in the editor do not. |
| Playback loop | `view/timeline/Playback.ts:87`, `ui.loop` | Wraps at `duration − 1` with `endsAtLastFrame`, otherwise at `duration`. |
| Clips that loop | `core/rig/motion.ts` (`MotionClip.loop`) | `apply_motion` writes frame `frames` = frame 0. |
| Onion skin | `core/doc/onion.ts` | Clamped to the animation, so it never wraps. |
| Pose at any frame | `posedSymbol` (`core/spine/spinePose.ts`) | Includes the IK solve, the same pose the stage draws. |
| Bone drawing | `Overlay.drawBones` | Draws only the current frame. |

Nothing shows whether frame 0 and the last frame match. Nothing draws movement over
time apart from onion ghosts, and ghosts show artwork, not bones.

## Part A — cycles

### A1. The model

- A cycle is `playTimes === 0 && endsAtLastFrame === true`. No new field. Old
  documents keep their output (CLAUDE.md ▸ Export settings: absent means the old output).
- `isCycle(anim)` in `core/doc/cycle.ts`: pure, no store, gets a table test.

### A2. The seam check (done, step 1)

`core/doc/cycle.ts`, tested in `tests/cycle.test.ts`:

- `seamFrame(anim)`: the join, `duration − 1` in a cycle, else null.
- `seamGap(start, end, tol, own)`: every node whose pose at the join differs from frame
  0: distance, turn, scale, colour, image. It compares posed results, so a bone the IK
  solves shows a gap when its target does not close. With `own` each node is compared
  in its parent's frame, so the gap is reported on the node where it starts, not on
  everything under it.
- `seamKeys(anim, nodes, ids)`: Close Loop's tracks. Frame 0's transform, colour and
  display keyed at the join; a key already there is replaced; a track that ends early is
  carried out to the join; angles keep the whole turns made by the join (a bone that
  spins once ends at +360, not back the way it came).
- Not done: `seamVelocity` (the tangent into the join against the one out of frame 0).

### A3. Commands and UI (done, step 2)

- **Cycle** (`timeline.cycle`, a toggle) and **Close Loop** (`timeline.closeLoop`), in the
  animation options menu (☰ beside the animation picker) and the ruler's context menu,
  bindable in Keyboard Shortcuts.
- **Cycle on** (`cyclePlan`, `SetCycle`, one undo step): `playTimes = 0`,
  `endsAtLastFrame = true`. An animation on Flash's timing grows by one frame and the new
  last frame is the join, so the loop plays as before and the exported length in seconds
  is unchanged. Every track that reaches the end and has no key at the join gets frame
  0's pose there. A key already at the join stays, and a track that stops earlier is left
  alone; the seam check shows either.
- **Cycle off**: `playTimes = 1` (play once). Keys and timing stay, so the export does
  not change. `playTimes` is not written to the Spine file; it only drives the editor's
  playback.
- **Close Loop**: `seamKeys` on the selected layers, or every layer when none is
  selected (`insertTargets`). It replaces a key at the join without asking: it is the
  explicit command, and one undo step.
- **Timeline** (`FrameGrid.drawSeam`): a ↻ over the join's column in the ruler, a line
  down the rows, and an orange dot in the join cell of each row that does not close. The
  tooltip on a dot gives the gap. Measured once per document revision, not per playhead
  move.
- **Animation picker**: a cycle is listed as `name ↻`.
- **Export**: no change. `spineParity` turns the stickman's animations into cycles and
  checks the stage against spine-core, the length in seconds, and that the join plays
  as frame 0.

### A4. Onion skin across the join (done, step 3)

`core/doc/onion.ts`, tested in `tests/stageState.test.ts`:

- `onionSpan(…, period)`: in a cycle, following markers are not clamped to the
  animation. The span is unwrapped (start below 0, end past the join), at most
  `period − 1` frames each side so it never comes round to the playhead.
- `onionFrames({ …, period })`: each frame is wrapped into `0..period − 1`, so the join
  is never a ghost (it shows frame 0). A frame reached both ways round is drawn once, at
  the nearer distance. Past and future follow the way round it was reached.
- `wrapSpan`: the span as drawn on the ruler, one band or two across the join; the start
  bracket on the first, the end bracket on the last. `dragMarkers(…, period)` lets
  following markers go past the ends, up to `period − 1` from the playhead.
- `Store.onionPeriod` decides when it applies: a cycle, following markers, and Edit
  Multiple Frames off. Anchored markers and Edit Multiple Frames keep a real range
  inside the animation (Edit Multiple Frames edits keys in that range; across the join
  is not supported).
- Checked in the app on the stickman's run as a cycle: at frame 0 the ghosts are 14, 15,
  16 and 1, 2, 3 (the join, 17, never), the ruler shows two bands, and dragging the
  wrapped start bracket with the mouse sets "frames before" without moving the playhead.

### A5. The AI (done, step 9)

- `set_cycle {animation, on}`: `cyclePlan` and `SetCycle` (labelled "AI: Cycle …"),
  one undo step; returns the seam.
- `get_animation` says `cycle`, and for a cycle `seam`: `{ lastFrame, closes, gaps }`,
  each gap a bone with how far it is off (pixels, degrees, scale, colour, attachment),
  where the difference starts (`seamGap` in the parent's frame).
- `check_preview` returns the same `seam` for a cycle.
- `apply_motion` says `cycle`. Every clip in the library loops, and `new_animation`
  already makes a cycle, so nothing else was needed; a clip that does not loop would have
  to call `SetCycle(false)` when one is added.

## Part B — bone paths

### B1. What is drawn

For each selected bone (and, optionally, every bone), the path of one point on it:

- **Point**: the bone's tip (origin plus length along +x) by default, because a tip shows
  the swing and an origin on a hip barely moves. The pivot is the other choice, in
  Preferences ▸ Selection & Gizmos ▸ Bone path point: Tip / Origin.
- **Range**: the whole animation, or the onion span when the onion skin is on (it is the
  same "which frames" control, and the markers already exist).
- **Look**: a polyline through one dot per frame. Dots are spaced by speed: far apart
  means fast, bunched means slow (an ease you can see). Keyframes get a larger hollow
  dot. The current frame gets a filled dot. Past and future use the onion colours
  (`onionPastColor`, `onionFutureColor`) so the two read the same way. A cycle draws the
  path closed through the join.
- **IK**: positions come from the posed result, so a bone the solver moves draws its
  solved path, and the IK target draws its own keyed path. A thigh driven by the IK shows
  the arc the runtime will play.

### B2. Pure part (done, step 4)

`core/doc/bonePath.ts`, tested in `tests/bonePath.test.ts`:

- `pathPoint(pose, id, "tip" | "origin")`: the tip is the origin plus `boneLength`
  along the bone's +x (40 px when unset, as the stage draws it). Anything
  that is not a bone has its tip at its origin.
- `pathFrames(anim, span?)`: the frames a path runs through, in playing order. A cycle
  runs 0 to the frame before the join and is `closed`; anything else runs its whole
  length. With the onion span, only those frames: on a cycle the unwrapped span is
  wrapped in order (−2..2 on an 8-frame loop is 6, 7, 0, 1, 2), and a span as long as the
  loop is closed.
- `bonePaths({ sample, ids, frames, closed, which, isKey })`: one `BonePath` per id,
  `{ id, points: { frame, x, y, key }[], closed }`. Each frame is posed once for all the
  paths. `keyedIn(anim)` marks the frames where the node itself has a key; a bone the IK
  solves has none.
- Tests: a linear quarter turn puts the tip on the arc at equal spacing; an ease-in
  spaces the dots wider each frame; a cycle stops before the join and is closed; and the
  stickman's near shin (no keys, moved by IK) has a tip path equal to spine-core's,
  within 0.001 px, at every frame of the run.

### B3. Cost and caching (done, step 5)

`PathCache` (`view/viewport/pathCache.ts`, tested in `tests/pathCache.test.ts`) keeps one
pose per frame for the current symbol and animation. A playhead move reuses them all. A
new document revision makes them stale: each draw re-poses what fits in 6 ms and takes
the rest from the previous revision, then asks for another draw (`pending`), so during a
drag the path lags by a frame or two instead of the drag stuttering. Another symbol or
animation starts over.

Measured in the app on the stickman's run stretched to 120 frames, with the path of
every bone (15) shown: a playhead scrub draws in 0.8 ms (median; 6.3 ms at most, the
first build), and a new revision every frame, as a drag makes, in 3.6 ms (5.2 ms at
most).

### B4. Drawing and toggles (done, step 5)

- `Overlay.drawBonePaths`: under the bones, above the artwork, in screen space. A line
  through one dot per frame: the part already played in the onion past colour, the rest
  in the future colour; a hollow ring on each key; a filled dot in the playhead colour on
  the current frame (frame 0 when the playhead is on a cycle's join). A cycle's line
  closes back to the start.
- `Viewport.bonePathsToDraw`: Animate mode only, never in Play mode, off with the
  gizmos. Selected bones, or every bone by preference, never on a locked or hidden layer.
  Over the onion span while the onion skin is on, else the whole animation
  (`pathFrames`).
- Toggle: `ui.showBonePaths`, a view switch remembered in `gizmos.showBonePaths` like
  Show bones. A button in the stage bar after Show gizmos, View ▸ Show Bone Paths, ⌥B.
- Preferences ▸ Selection & Gizmos ▸ What is drawn: Show bone paths; Bone path follows
  (the tip / the origin); Bone paths for (selected bones / every bone).
- A bone with no length of its own draws 40 px long (`DRAWN_BONE_LENGTH`, shared with
  `Overlay.drawBones`), and its path follows that tip.

### B5. Editing on the path

#### Dragging dots (done, step 6)

The path is also a handle. With the Selection tool, a press on a path dot is taken
before artwork and bones (`pathDotUnder` in `view/tools/pathDrag.ts`):

- **A click** puts the playhead on that dot's frame and selects the bone. No undo step.
- **A drag** re-keys the bone at that frame so the dot follows the pointer. One undo step
  ("Drag Path"): every move is an `EditTracks` of kind `path.drag` built from the tracks
  as they were when the drag began, merged while the pointer moves.
- **Dots that pile up** (a loop passes its start again) are told apart by
  `pathDotAt`: the playhead's frame first, then a key, then the nearest.

What a drag writes is decided by `pathDragMode` (`core/doc/pathEdit.ts`, table test):

| Bone | Dragging its dot | Written |
|---|---|---|
| An IK target, the origin of anything, a bone whose keys move it without turning it, a root that does not turn | moves it (`translateTo`), the angle kept | `x`, `y` at that frame |
| Any other tip, option **This bone** | turns it about its origin so the tip points at the pointer (`rotateTo`) | rotation at that frame |
| Any other tip, option **With parent** | turns it and its parent so the tip reaches the pointer, keeping the bend (`rotateWithParentTo`) | rotation on both |
| A bone the IK solves | refused, with a message naming the target to drag | nothing |

- `rotateTo` is exact under any affine parent (mirrored, unevenly scaled): it works in
  the parent's space, where the parent maps the ray to the pointer onto a ray.
  `rotateWithParentTo` solves the two segments in world space; a parent the IK solves is
  never turned along.
- **The option is per bone**: `Node.pathDrag?: "parent"`, the Properties panel's Bone
  section ▸ Path drag (This bone / With parent), command `SetPathDrag`. Saved in the
  document (schema 13; anything but `"parent"` is dropped on load), never exported.
  ⌥ flips it for one drag.
- **Keys**: a dot without a key gets one first, by F6's rule (`keyAt`). On release the
  keys the drag ADDED are dropped again if they change no whole frame
  (`withoutRedundantKeys`: 0.01 px, 0.01°, colour and image exactly). Keys that already
  existed stay, even when the drag leaves them on the line: the user put them there.
- **⇧-drag** moves every key of the bone by what the dragged frame moved (`shiftKeys`).
- **On a cycle**, frame 0's dot moves the join key with it, keeping the join's whole
  turns.
- Not done: snapping while dragging a dot.
- Checked in the app with real drags on the stickman's run: a key dot of the near foot
  target (one undo step), an in-between dot (a key added at frame 11), a click (playhead
  to frame 3, no undo step), the IK-solved shin (refused, the message names
  foot_near_target), the head's tip alone and with its parent (the tip lands on the
  pointer), and frame 0 of the run as a cycle (the join key follows). ⇧ and ⌥ could not
  be held in those drags; `shiftKeys` and the option's flip are covered by tests only.

#### Spline handles (done, step 7)

The interval between two keys that move a bone can be bent like a spline. The one
selected bone shows a handle at each end of every interval that tweens, when a drag of
its path moves it (`pathDragMode` is `translate`). Dragging a handle bends that interval
(one undo step, "Bend Path").

This maps onto Spine exactly, with no extra keys. A cubic Bezier `P0 P1 P2 P3` run at
uniform speed is, per axis, a cubic in time with control times 1/3 and 2/3: a custom
ease on `x` and another on `y` (per-axis eases, ARCHITECTURE ▸ Easing) with the same
control times and control y `(P1 − P0) / (P3 − P0)` and `(P2 − P0) / (P3 − P0)` on each
axis. Shared control times other than 1/3 and 2/3 only change the speed along the
curve, never its shape, and are kept when a handle moves. The stage and the runtime
both read the curve as Spine's 10-piece polyline, so the stage draws what will play.

`core/doc/pathSpline.ts`, tested in `tests/pathSpline.test.ts`:

- `easesToSpline(a, b)`: the spline an interval draws, or null for a hold, a preset, a
  curve of several segments, or x and y timed apart. Linear and the quad eases are
  splines.
- `splineToEases(s)`: the two eases, or `{ split }` when an axis that does not travel has
  to bend. A handle whose control y passes ±3.2767 is pulled in (`clamped`, and a
  message on release).
- `withSpline(track, node, from, s)`: the track with the interval bent. A split cuts a
  key at the interval's middle frame with F6's rule (every other channel as the stage
  shows it), puts it on the curve, and gives each half its eases; it is refused when the
  interval is one frame long. A hold bent this way becomes a tween. On release, a split
  key that changes nothing is removed.
- `splineSegments(track)`: the intervals that get handles. A hold has none. An interval
  whose ease is not a spline shows straight handles (a third and two thirds of the
  chord) and the first drag replaces its x and y eases.
- `tests/spineParity.test.ts` bends a bone on both axes and on an axis that does not
  travel (the split), and plays it through spine-core frame by frame.

On the stage the handles are in the parent's space, hung from the key's dot through the
parent's matrix at that key's frame (`Viewport.bonePathsToDraw`, `HandleDrag` in
`view/tools/pathDrag.ts`); they are picked before dots and artwork.

Behaviour to know:

- The two handles at a key are independent (a corner, not a smooth point).
- A handle is stored as a fraction of the interval's travel, so moving a key afterwards
  stretches the bend with it.
- Not done: the Ease panel does not yet say that a preset was replaced by a bend.
- Checked in the app with real drags on the stickman's run (near foot target): an out
  handle bent the lift (one undo step, a custom x ease); an out handle on the flat
  stretch cut a key at frame 3 on the curve; undoing both put the track back exactly.

#### Rotation bones: bake (done, step 8)

A bone that turns draws an arc between keys, and no ease on its rotation makes that
arc a free curve. So the one selected bone that turns (`pathDragMode` is `rotate` or
`rotateWithParent`, by its Path drag option) shows handles fitted to the arc its tip
draws over each interval of at least two frames (`fitCubic`, least squares: dragging
nothing changes nothing). Dragging a handle reshapes that curve and **bakes** the
interval onto it (one undo step, "Bake Path"):

1. `bakePlan` turns the bone (`rotateTo`), or the bone and its parent
   (`rotateWithParentTo`), at every frame so the tip follows the curve, the angles
   unwrapped so they never jump a turn. A chain bends one way for the whole interval,
   the way it bends at the start (`bendOf`): decided per frame, a nearly straight chain
   flips between its two solutions.
2. It keeps the ends and adds keys where the error is largest until linear turning
   between kept keys keeps the tip within 0.5 px of the per-frame solve
   (Douglas–Peucker over frames). The tolerance is against the solve, not the curve: a
   bone that only turns keeps its tip on a circle, so the solve is the nearest it can
   get, and a two-bone chain straightens toward a target out of reach.
3. `withBakedKeys` writes the kept keys inside the interval and makes the turn linear
   there (rotation and shear eases; x, y and scale keep theirs; rotateDir and turns are
   dropped). The interval's own end keys are not rewritten. With the parent, its keys
   inside the interval are replaced and it is pinned with keys at both ends.

Tests: `tests/pathBake.test.ts` (the fit, the tolerance and key count, no turn jumps,
the two-bone bake on targets, one bend on a nearly straight chain, the track write) and
a case in `tests/spineParity.test.ts` playing a baked bone through spine-core. Handles
that pile up on a loop pick the interval the playhead is in (`handleAt`).

Checked in the app on the stickman's run: the head's handle in the 0→8 interval baked
keys at 1, 4, 5, 6 and 7 (one undo step) and left 8→16 alone; with "With parent" the
chest was baked with it, and straightened at frame 4 where the curve is out of the two
bones' reach.

#### On a cycle

Dragging frame 0's dot moves the join key with it, so the cycle stays closed (step 6).
Not done: the handles on either side of the join are independent, like every other
key's, so the curve can corner there.

### B6. The AI (done, step 9)

- `render_frame {…, paths: [bone…]}` draws each named bone's tip path under the bones
  (`PathMark`, painted by `PageVision`): an orange line, a ring on each key, a red dot
  on the frame drawn, closed for a cycle. The framing grows to hold the paths, and the
  text lists each path's frame count and keyed frames.
- `get_bone_path {animation, bone, point}` returns every frame's point in get_pose's
  space (y up), keys marked, `closed` for a cycle (`bonePaths`, IK included).
- `set_bone_path {animation, bone, keys: [{frame, x, y, out?, in?}]}` keys x, y (local to
  the parent, y up, as `set_keys`) and bends each interval with handles through
  `withSpline`: eases only, or a key added in the middle where an axis does not move
  (`addedKeys`). An interval with one handle keeps its other one. Refused for a bone the
  IK moves (naming the target), for a key that lies between two handled keys, and for a
  frame given twice. One undo step, "AI: Path of …".
- Tests in `tests/agentApi.test.ts`; `set_bone_path`'s result is played through
  spine-core there. Checked in the page: `set_cycle` and `render_frame` with three paths
  through `animo.agent`, and the picture looked at.

## Order of work

1. `core/doc/cycle.ts` + tests (A1, A2). Done.
2. Cycle and Close Loop commands, menu, timeline marks (A3). Check in the app on
   the stickman with real clicks (rule 3). Done.
3. Onion skin across the join (A4). Done.
4. `core/doc/bonePath.ts` + tests (B2). Done.
5. `PathCache` and `Overlay.drawBonePaths`, toggle, preferences (B3, B4). Check with a
   120-frame animation that a playhead scrub stays smooth. Done.
6. Dragging dots: `pathDragMode` + tests, then the drag on the stage (B5, first table). Done.
7. Spline handles: `core/doc/pathSpline.ts` + parity test, then the handles (B5). Done.
8. Bake Path for rotation bones (B5). Done.
9. AI tools (A5, B6) in `tools.json` and `AgentApi`, with `agentApi.test.ts` cases. Done.
10. ARCHITECTURE: a "Cycles" section and a "Bone paths" section, the onion skin's wrap,
    the AI tools, the path-drag gestures in the Keyboard Shortcuts window, and a pointer
    in CLAUDE.md. Done.

Each step keeps `spineParity`, `spineImport` and `spinePose` passing. Step 2 touches what the
exporter reads (`playTimes`, `endsAtLastFrame`), so rerun `scripts/unity-check/` once. Not
rerun yet: it needs the Unity Editor open on M0. Nothing in the file's header or format
changed (only keys and lengths), and spine-core plays every case in `spineParity`.

## Open questions

None at the moment.
