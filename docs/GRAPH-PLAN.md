# Graph editor (Spine parity, phase B)

Done (ARCHITECTURE ▸ Graph editor). docs/SPINE-PARITY-PLAN.md ▸ Phase B. A Graph panel shows a bone's property values over time as
curves, the way spine-core plays them, and edits them: move a key in time and value, bend an
interval by its handles. Spine's Graph view.

## What it edits

A property's own keys are already a channel (`core/doc/propertyKeys.ts`): `channelKeys(track,
prop)` gives `{ frame, values, eases }` per key, one value and one ease per leaf (Rotate,
X, Y, Scale X, Scale Y, Shear), and `setChannel` writes a channel back without moving any
other. The graph edits those lists and writes them back with `setChannel`; an IK constraint's
mix is a channel of the same shape (`Animation.ik`).

## The rules, pure (`core/doc/graphEdit.ts`)

- `GRAPH_CHANNELS`: the curves a bone has, with their property, leaf and colour.
- `graphSamples(keys, leaf, from, to, step)`: the curve as the runtime plays it, from
  `sampleChannel` (`applyTween`, the runtime's polyline).
- `cubicOf(ease)`: an interval's ease as one cubic `[x1, y1, x2, y2]`: a custom cubic as it is,
  linear as the straight cubic, a preset or a several-piece curve fitted (`fitCubic`); null
  for a stepped key.
- `withHandle(keys, index, leaf, end, frame, value)`: the interval leaving key `index` bent so
  its out (or in) handle sits at that frame and value, in the curve's units: x clamped to the
  interval, y to `CURVE_Y_LIMIT`. An interval whose two ends are equal cannot bend (the
  editor's eases are fractions of the change); its handles only slide in time.
- `moveGraphKeys(keys, picks, frames, values)`: the picked keys moved by whole frames (never
  before 0, replacing a key of the channel they land on) and their picked leaves by a value.

## Steps

1. Rules and table tests: handle round trip (a cubic read and written back is the same),
   handles against `applyTween`, moves, collisions.
2. The panel (`view/panels/GraphPanel.ts`), a tab beside Timeline: the selected bone's curves
   (chips switch each one), a key per point, the playhead. One curve shows its real values on
   the axis; several are each scaled to their own range, as Spine's normalized view. Wheel zooms
   time (⌥ value), middle or right drag pans, F fits.
3. Editing: a press on a point picks it (⇧ adds), a drag moves the picked keys (time snaps to
   frames); a press on a handle drags it; Delete removes the picked keys
   (`deleteChannelKeys`); a double-click on a curve keys it there (`keyChannelAt`). Each drag
   is one undo step from the track as it was at the press.
4. IK mix as a curve of the selected bone's constraint.
5. Docs: ARCHITECTURE ▸ Graph editor.
