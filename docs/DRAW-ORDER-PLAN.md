# Draw order keys

Done: steps 1 to 6 (ARCHITECTURE ▸ Draw order keys).

Spine animates the order slots draw in with a **Draw order** row: a key holds the
whole order from that frame on, as offsets from the setup order. This editor has
none: the order is the layer stack, fixed for every animation. An opened Spine
file's draw order keys are carried through untouched (`anim.spine.drawOrder`) and
only spine-core applies them.

## The model

`Animation.drawOrder?: DrawOrderKey[]`, sorted by frame:

```ts
interface DrawOrderKey {
  frame: number;
  /** The symbol's drawing layers, back to front, from this frame on.
   *  Absent: the setup order (the layer stack) again. */
  order?: NodeId[];
}
```

A whole order rather than Spine's offsets: it survives layers being added,
removed or restacked (a layer the key does not list keeps its setup place
relative to its neighbours; `orderAt` fills it in), and offsets are computed only
at export. Absent field = no keys = what is drawn today.

Pure functions in `core/doc/drawOrder.ts`, table-tested:

- `drawingLayers(sym)`: the layers that draw, back to front (not groups, not bones).
- `orderAt(sym, anim, frame)`: the order in force at a frame (the key at or
  before it; none = setup).
- `withOrder(order, setup)`: a key's order with missing layers put back and
  unknown ones dropped.
- `toOffsets(order, setupSlots)` / `fromOffsets(offsets, setupSlots)`: Spine's
  encoding, checked against spine-core's `SkeletonJson` in a test.
- `reordered(order, ids, how)`: forward / backward / to front / to back.

## Steps

1. **Model.** Type, schema (sanitize, migration to version 16), the pure
   functions, tests.
2. **Stage.** `evaluateSymbol` orders its entries by `orderAt`; the renderer
   already draws entries in order. Onion skin, hit testing and bounds follow the
   entries.
3. **Export and import.** The exporter writes a `drawOrder` timeline from the keys:
   offsets over the flattened slot list, a nested symbol's slots moving as one
   block. The importer turns an opened file's draw order keys into the model
   instead of carrying them. `spineParity`, `spineImport` and `spinePose` stay
   green; a stickman parity case with draw order keys is added.
4. **The row.** A **Draw order** row at the top of the timeline (always shown
   when the animation has keys, and in the focused view): a key per frame, drag to
   move, Delete to remove, right-click **Key Draw Order Here**.
5. **Editing an order.** In Animate mode, with the playhead on a draw order key
   (or with auto key on, anywhere), Modify ▸ Arrange and dragging a layer in the
   layer list change that key instead of the layer stack, as Spine's draw order
   keys do. Setup mode keeps editing the stack.
6. **AI and docs.** `draw_order` takes an optional frame; ARCHITECTURE ▸ Draw
   order keys.

## Out of scope

A nested symbol's own draw order keys: the exporter flattens nested symbols
into one skeleton with one draw order timeline, so only the exported symbol's
keys are written; a nested one with keys gets a warning.
