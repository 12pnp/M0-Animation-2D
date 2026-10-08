# FramePath: key nodes with a detail panel and a speed — plan

**Status: done 2026-10-09 (see "Result"); split translatex/translatey keys left for later.** The FramePath tab gets what the TwinSpline tab has under its picture: numbered nodes, the picked node's data and a speed graph. On FramePath the nodes are the bone's translate keys, and a node's speed is written into the keys' own Bezier curves, so it plays and exports as plain Spine data (no sidecar, no bake).

```mermaid
flowchart LR
    K["translate keys<br/>of the bone"] -->|"keySpeeds()"| N["nodes 1..N<br/>speed per key"]
    N --> UI["FramePath lower area<br/>strip · data · speed graph"]
    UI -->|"drag a point / type a speed"| E["setTranslateKeySpeed()<br/>(src/edit/keySpeed.ts)"]
    E -->|"rewrites the curve of<br/>the span before and after"| K
    K -->|"exported as is"| U["Spine JSON → Unity bake"]
```

## What was asked

> at "FramePath", now when click node must show detail panel like in "TwinSpline", for add addition speed adjust

The owner chose (2026-10-09): **ease between keys** (the keys stay on their frames; the speed shapes each span's Bezier, the clip length never changes), and **keyed frames only** are nodes.

## The design

- **Nodes** are the keys of the bone's combined `translate` timeline in the shown animation, numbered 1..N in time order. A bone keyed with split `translatex` / `translatey` timelines gets an honest line instead of nodes (not handled in this step).
- **Speed** of a node: −0.99 to 5, the TwinSpline's range: the bone moves *1 + speed* times as fast as the span's even pace at that key. The span from key *i* to key *i+1* gets the shape `[1/3, (1+a)/3, 2/3, 1 − (1+b)/3]` on both channels, *a* the speed at its start, *b* at its end. The same normalised shape on x and y keeps the bone on the straight line between the keys: only the timing changes. Both speeds 0 is the straight line, written as no curve.
- **Reading back**: a key's speed is the slope its curves have there over the span's even pace, minus 1, from the channel that moves most. Any imported curve reads; a stepped span reads as stepped and becomes a curve once a speed is set on it.
- **Closed** (the FramePath ⋮ toggle): setting the speed of the first or the last node sets both, as the drag does for their place.
- **The lower area** under the picture on FramePath: the numbered strip (press: pick and go to that key's frame), the picked key's data (frame, place x/y, speed with its ×multiplier), the speed graph over the animation's frames (the speed the curves give at each moment, a point per key; drag a point up or down, Shift in steps of 0.1, double-click: 0). A key's dot on the picture picks that node too.

## Steps

1. `src/edit/keySpeed.ts`: `keySpeeds`, `spanSpeedAt` (the graph's line), `setTranslateKeySpeed`; table tests in `tests/keySpeed.test.ts` (linear reads 0, a set speed reads back, both 0 drops the curve, the path between keys stays on the line, stepped, last key, refusals).
2. The FramePath lower area in `motionPanel.ts`: strip, data, graph and its drag; the picture's key dot picks the node.
3. e2e in `e2e/motionModes.spec.ts`: the strip shows the keys, a node's data, a speed typed is written into the curves.
4. Status and results here.

## Result

1. `src/edit/keySpeed.ts` as planned; `tests/keySpeed.test.ts` (7 tests) passes. Speeds read back to four places, since the handles are stored as short floats. A span whose x and y had different imported curves gets one shape on both once a speed is set on it, so the bone then runs straight between those two keys.
2. `motionPanel.ts`: on FramePath the lower area shows a button per translate key (`renderKeyStrip`), the picked key's frame, place and speed (`renderKeyData`), and the speed graph over the frames (`drawKeySpeed`, the same canvas and drag as TwinSpline's: a point drags its speed, double-click puts it to 0, the cap scrubs the frames). A key's dot on the picture picks its node. With Closed on, the first and the last key take a speed or a place together, as one undo step.
3. e2e: `motionModes.spec.ts` checks the strip, the data and a typed speed written into the curves. The whole e2e suite (154) and `vitest` (842) pass. It also fixed `twinSpline.spec.ts`, which the FramePath rename had left asking for the old menu name.

## Step 2: a frame strip like the Timeline's, and one Key toggle (2026-10-09, the owner's second note)

> remove all Green bt, then convert to similar like "TimeLine". we have 32 node, if we need add additionPath, just have bt for toggle key

FramePath and TwinSpline are to stay clearly apart (TwinSpline may go soon); the work is FramePath's.

```mermaid
flowchart LR
    STRIP["frame strip (canvas)<br/>ruler · green playhead tag · ◆ per key"] -->|"click / drag"| PH["session.seek(frame)"]
    PH --> SEL["picked key = the key on the playhead's frame"]
    SEL --> DATA["key data + speed graph"]
    KEY["◆ toggle"] -->|"no key here"| ADD["keyBone(translate) at the frame:<br/>the pose the bone has there"]
    KEY -->|"a key here"| DEL["deleteKeys(translate, frame)"]
```

- **The green numbered buttons go** on FramePath. In their place, a strip drawn like the Timeline's ruler: frame numbers, the green playhead tag, and a diamond on every frame with a translate key. It shares the speed graph's view (same left edge, zoom and pan), so a frame on the strip is above the same frame on the graph.
- **Click or drag on the strip** moves the playhead. The picked key is simply the key on the playhead's frame, so clicking a dot in the picture, a point on the graph or a diamond on the strip all pick the same way; a frame with no key shows "no key here" in the data.
- **One toggle button** at the strip's left, ◆: on a frame with no translate key it keys translate there with the pose the bone has on that frame (the motion does not change); on a frame with a key it deletes that key. One undo step each.
- TwinSpline keeps its own strip as it is.

### Result (step 2)

Built as above in `motionPanel.ts` (`renderKeyStrip`, `drawKeyStrip`, `keyStripEvents`, `toggleKey`) and `style.css`. The key data now follows the playhead: the "picked" key is the one on its frame. With no key on that frame, the data says so and points at ◆. The strip and the graph also show for a bone with fewer than two keys, so ◆ can start a FramePath. e2e: `motionModes.spec.ts` checks no green buttons, the strip, the key data on the playhead's frame, and ◆ adding then deleting a key. Checked in the browser on Stickman_IK's `hips`: the strip lines up with the graph, a click moves the playhead, and ◆ added the key on frame 13 and then removed it.

## Step 3: Shift + click deletes a key; two speeds per key with three leg modes (2026-10-09, the owner's third note)

> 1 add can delete "key ◆ Speed" (when hover node + shift, node icon to red, l click delete). 2 add full 2 control with 3 mode

The owner chose: the two controls are the speed **arriving** at a key and the speed **leaving** it; the three modes are TwinSpline's legs: **Mirror**, **Break**, **Auto**. Delete works on the graph's points and on the strip's diamonds.

```mermaid
stateDiagram-v2
    [*] --> Mirror: in = out
    Mirror --> Break: Break (or Alt + drag a leg)
    Break --> Mirror: Mirror (in takes out's value)
    Mirror --> Auto: Auto
    Break --> Auto: Auto
    Auto: in, out from the neighbours (an action; reads back as Mirror or Break)
```

- **Two speeds per key.** The span before a key ends at its *in* speed, the span after starts at its *out* speed (`setTranslateKeySpeeds(animation, bone, index, { in, out })` in `src/edit/keySpeed.ts`; `keySpeedPairs` reads them). The graph draws a key's point with a leg each side: a hollow ring on a short stem at the in speed (left) and the out speed (right). The point drags both by the same amount; a leg drags its own side, and in Mirror the other side follows.
- **The modes** are actions, as on TwinSpline's legs, shown on the key's data row and in the point's right-click menu. **Mirror**: in takes the out speed. **Break**: each leg on its own. **Auto**: the pace through the key is the Catmull–Rom one (the distance from the key before to the key after, over their time), written as the in and out speeds that give it, held to −0.99…5. The mode shown is read from the data: in = out is Mirror; else Break. A Break chosen on equal speeds is remembered by the panel for that key until the bone or animation changes, since the file has nowhere to keep it.
- **Delete.** With Shift held over a point on the graph or a diamond on the strip, it turns red; a click deletes that translate key (one undo step). A Shift + drag on a point that started without Shift still steps by 0.1.

### Result (step 3)

- `src/edit/keySpeed.ts`: `keySpeedPairs`, `autoKeySpeeds`, `setTranslateKeySpeeds` (a side left out leaves its span as it was, a stepped one too); `setTranslateKeySpeed` sets both sides through it. `tests/keySpeed.test.ts` has three more tests (10 in all). The Auto test checks the written handles, not a finite difference of the engine's pose: the engine draws a Bezier as 10 straight steps, so a 1 ms difference near a key reads the first step's slope, not the curve's.
- `motionPanel.ts`: the graph draws a leg each side of a key (in left, out right); the point drags both, a leg drags its side (and the other too in Mirror; Alt + drag breaks first; double-click on a leg: Auto). The key's data has *Speed in*, *Speed out* and *Legs: Mirror · Break · Auto*; right-click on a point gives the same and Delete. Shift over a point or a diamond turns it red (Shift pressed or let go with the pointer still there counts too) and a click deletes the key.
- e2e: `motionModes.spec.ts` checks Break, Mirror and Auto through the data row, and a Shift + click delete on the graph and on the strip (it fails on step 2's code, where Shift + press began a drag). All suites pass: vitest 845, e2e 157. Checked in the browser on `hips`: the legs and the Mirror · Break · Auto row show. The red Shift hover is not checked: the e2e test checks the delete, not the colour, and the browser pane cannot hold Shift while hovering.

### Revised (step 3, the owner's fourth note, 2026-10-09)

> 3 mode: 2 hand, relate 2 side · break leg, freedom by each hand · plain node, if you have 2 plain node it just basic line

The three modes are now **Mirror** (two handles, linked), **Break** (each handle free) and **Plain** (no handles: the key's speed is 0 on both sides, so a span between two plain keys is the straight line, written as no curve). **Auto is gone**, with `autoKeySpeeds` and its test.

```mermaid
stateDiagram-v2
    Plain: Plain · no handles · in = out = 0
    Mirror: Mirror · 2 handles, linked
    Break: Break · 2 handles, each free
    [*] --> Plain: a new key
    Plain --> Mirror: drag the point, or Mirror
    Mirror --> Break: Break, or Alt + drag a handle
    Break --> Mirror: Mirror (in takes out's value)
    Mirror --> Plain: Plain, or double-click
    Break --> Plain: Plain, or double-click
```

- The mode is read from the keys: in ≠ out is Break; both 0 is Plain; else Mirror. A choice the file cannot show (Mirror or Break at 0 and 0, Break on equal speeds) is remembered by the panel for that key until the bone or animation changes.
- A plain key draws no handles on the graph. Double-click on a point or a handle makes the key Plain.

Result: built as above. `motionPanel.ts` has `keyMode` / `setKeyLegs` with Mirror · Break · Plain on the key's data row and in the point's right-click menu; a plain key draws no handles; double-click on a point or a handle makes it Plain. The e2e test checks that a key with no speeds starts Plain with no handles, that Break lets out differ from in, that Mirror links them, and that Plain puts both to 0 and hides the handles. vitest 844 and the Motion Path e2e (36) pass.

## Step 4: the Timeline's look (2026-10-09, the owner's fifth note: "make it same style as time line")

- **The strip** is drawn as the Timeline's top: its ruler (24 px, frame numbers on `--bg`, the same label steps from `timeline/layout.ts`'s `labelStep`), the green playhead tag with the time since the key before (`secondsSinceLastKey`), and under it the Timeline's row of span tabs, one between each two keys with its length ("4f · 0.17s"), the playhead's span lit; each key's ◆ sits between its tabs.
- **The speed graph** is drawn as the Timeline's graph: no ruler or pink cap of its own (the strip above is its ruler), the panel's colour, the frame lines running down through it, past the end dimmed, a 1.5 px curve, square keys (white when picked), thin handles with small rings, and the green playhead line.
- Checked in the browser on `hips`; the Motion Path e2e (36) passes.

## Step 5: the three modes on the picture, a curved path (2026-10-09, the owner's sixth note)

> now convert "FramePath" to can 3 mode

The picture's path between keys gets the same three modes as the speed graph: **Plain** (straight lines to the keys either side), **Mirror** (two handles in line: a smooth curve through the key), **Break** (two free handles: a corner). One mode per key serves both views.

```mermaid
flowchart LR
    H["key i: handle out (vector)<br/>handle in (vector)"] -->|"direction"| SHAPE["picture: the path's shape"]
    H -->|"length ÷ (chord ÷ 3) − 1"| SPEED["speed graph: in / out speed"]
    SHAPE -->|"drag a handle tip"| H
    SPEED -->|"drag a point / leg"| H
    H -->|"x and y value handles,<br/>time handles at thirds"| CURVE["Spine curve of each span"]
```

- **The model.** Each key has a handle out (to the span after it) and a handle in (from the span before), each a vector in the bone's translate units. A span from key *i* to *i + 1* is written with its time handles at a third and two thirds and its value handles at `key i + out` and `key i+1 + in`, on x and y each: with the same time handles on both channels, x(t) and y(t) share one parameter, so the span is exactly the 2D Bezier those four points make. A span whose handles lie on its chord at a third each way is the straight, even line, written as no curve.
- **Speed is the handle's length.** The speed at a side is `|handle| ÷ (|chord| ÷ 3) − 1`, the chord being that side's span. On a straight span that is exactly step 1's speed, so files made since step 1 read the same. The speed graph changes only the length (the direction stays); the picture's handle tip changes direction and length, so the speed follows.
- **Modes.** Plain: both handles on their chords at a third (straight, speed 0); the picture draws no handles. Mirror: the in handle points opposite the out handle, at the same speed. Break: each free. Read from the data: on the chords at speed 0 is Plain, opposite at equal speed is Mirror, else Break; a choice the data cannot show is kept by the panel as before.
- **The picture** draws, for each key that is not Plain, a line from its dot to each handle's tip and a ring there (TwinSpline's look). A tip is dragged in the panel's space; the handle is that offset taken back through the parent bone's matrix at the key's frame. In Mirror the other handle turns to stay opposite and keeps the same speed.
- **Reading other files.** A Spine curve whose time handles are not at the thirds reads its handle as the velocity it gives (value offset × (Δt ÷ 3) ÷ time offset); writing a handle puts the time handles at the thirds.
- **Not in this step.** Moving a key's place remaps its spans' curves channel by channel as before (`settle` in `edit/keys.ts`), which can bend the handles; keeping them as vectors when a key moves comes later if needed.

### Result (step 5)

- `src/edit/keySpeed.ts` rewritten around handle vectors: `spanHandles`, `keyHandles`, `keyChords`, `setKeyHandles`; the speeds (`spanEnds`, `keySpeedPairs`, `setTranslateKeySpeeds`) are now the handles' lengths, and `spanSpeedSamples` the 2D speed along the curve. Step 1's tests pass unchanged, so files made since then read the same. Four new tests: handles read back, the bone passes the 2D Bezier's middle point at the middle time, a speed keeps a curved handle's direction, and a handle that is not two numbers is refused. Handles read back to four places (a third is a short float).
- `motionPanel.ts`: `keyMode` reads Plain · Mirror · Break from the handles; `setKeyLegs` does Plain (handles back on the chords) and Mirror (the in handle turned opposite at the same speed); the picture draws each non-Plain key's handles (`drawKeyHandles`, through the parent's matrix at the key, cached per document) and a tip drags (`dragKeyHandle`; Mirror turns the other handle, Alt + drag breaks first).
- e2e: `motionModes.spec.ts` checks that Mirror gives a key two handles on the picture, that dragging a tip curves both spans and turns the other handle, and that Plain makes both spans straight again (no curve) with no handles. vitest 848 and e2e 158 pass.
- In the browser: on Stickman_IK's `hips` Mirror · Break · Plain switch, but no handles could be seen: key 5 sits on the same place as its neighbours (a chord of 0, so its handles have no length); a bone that travels shows the curve better.

## Step 6: the strip and graph always shown, the resize line under the picture (2026-10-09, the owner's seventh note)

> this panel must always show, and move drag able at blue line to red line

- **Always shown**: the frame strip, the speed graph and the key data stay for any selection. With no animation, no bone, a bone a constraint places, or split x/y keys, they are empty, the ◆ toggle is off, and the data says why (`keyHint`).
- **The resize line** (`lp-split`) moves from above the strip to right under the picture, above the zoom bar; dragging it still trades the picture's height for the strip and graph's.
- e2e: `motionModes.spec.ts` checks both with no bone selected, and that dragging the line up gives the lower area more room. All e2e (119) pass.

## Step 7: the speed graph's points move in time; the Timeline's graph leaves translate to FramePath (2026-10-09, the owner's eighth note)

> now it has 3 graphs: FramePath, SpeedGraph, Timeline graph. Reduce the Timeline graph's duty; make SpeedGraph free drag.

The owner chose: a point on the speed graph drags **sideways too**, moving its key to another frame (legs stay up and down, the speed); and the Timeline's graph **no longer shows or edits a bone's combined translate curves**, which FramePath owns.

```mermaid
flowchart LR
    DRAG["drag a key's point<br/>on the speed graph"] -->|"sideways: frames"| MOVE["moveKeys(translate, key, Δframes)<br/>held between its neighbours"]
    DRAG -->|"up / down: speed"| SPEED["setTranslateKeySpeeds"]
    TL["Timeline graph"] -->|"bones · translate"| OUT["left out: a note points to Motion Path"]
    TL -->|"rotate · scale · shear · split x/y · the rest"| KEEP["as before"]
```

- **Sideways**: the key moves to the frame under the pointer, held between the keys either side (never onto one) and inside the animation; its curves follow (`moveKeys` settles them, so the handles stay at the thirds and the speeds keep). Up and down sets the speed as before; both in one drag, one undo step.
- **The Timeline's graph** leaves out the `translate` timeline of bones; a line on the graph says the selected bone's translate is edited in Motion Path (FramePath). Split `translatex` / `translatey` keys, which FramePath does not handle, stay on the Timeline. The dope sheet rows are not changed.

### Result (step 7)

- `motionPanel.ts`: `moveKeyTo` moves the dragged key with `moveKeys` (held between its neighbours, inside the animation; the playhead follows it); sideways movement under 6 px is ignored so an up-and-down drag does not nudge the key.
- `timeline/timeline.ts`: `graphChannels` leaves out bones' `translate`; `translateLeftOut` draws the note. ⌘A on the graph therefore selects no translate keys either.
- e2e: a new test in `motionModes.spec.ts` drags a point sideways (the key moves earlier) and past its neighbour (it stops one frame after it). `graph.spec.ts`'s geometry helper leaves translate out as the graph now does, and its "dragged up" check asks for a smaller rise (the value scale is tighter without translate's large values); `copyPaste.spec.ts`'s ⌘A count no longer needs ten keys. vitest 766 and e2e 120 pass.
