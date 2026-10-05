# The rest of the carried attachments (Spine parity, phase J)

Done (2026-10-05): ARCHITECTURE ▸ Boxes and points, Sequences, Meshes (other skins' meshes,
linked meshes), Physics, sliders and paths (keys), Inherit modes, the side columns, Checked in Unity.

Phase I left these carried: an opened file keeps them and the export writes them back, but the
model does not hold them. spine-unity's samples have 239 meshes in skins other than the default
(mix-and-match, Goblins, spineboy), 8 linked meshes whose source is in another skin, 9 weighted
paths (Hero, Stretchyman, mix-and-match), a point with an offset (spineboy) and two rotated
sequences (Dragon). Phase J makes them the document's, in this order:

1. **Points with an offset.** `Node.point` `{ x, y, rotation }` in the node's space (y down,
   the editor's clockwise degrees), written as the attachment's `x`, `y`, `rotation`.
   The overlay, picking and the bounds place it there. Properties ▸ Point edits it. AI: `set_point`.
2. **Rotated or scaled sequence regions.** `DisplayRef.region` `{ rotation?, scaleX?, scaleY? }`
   in Spine's convention, written with the region. The stage's own pose cannot turn a
   display, so a symbol with one is posed by spine-core (`runtimePosed`).
3. **Weighted boxes and paths.** A box or path holds `weights` and the file's `boneOffsets`, as a
   mesh does. The pose, the export and the Mesh tool share the mesh rule (`meshWorld`,
   `boneburstVertices`), and a moved point drops its own offsets.
4. **Other skins' meshes and linked meshes.** A skin's mesh is a skin display with a `mesh`; a
   linked mesh may name its source's skin (`linked.skin`, Spine's `skin`). In Setup mode the
   Mesh tool edits the mesh the stage shows. A skin mesh that an animation deforms stays
   carried, since only display 0 of the default skin takes deform keys.
5. **Keys between frames.** A physics, slider or path channel, or an inherit timeline, with a
   key that falls between frames at the chosen rate is no longer carried. A channel is written
   frame by frame around such a key, the way bone keys already are. An inherit key takes the
   next whole frame.
6. **The Properties panel at a narrow width:** no clipped fields.
7. **The Unity check** rerun after the format changes.

Each step follows the project's rules. The decision is a pure function with a table test, and a
command replaces values. Anything exported gets a spine-core check. The app is checked with real
mouse input, and the AI bridge gets a tool for any new ability.
