# Finishing touches (Spine parity, phase L)

Done (2026-10-05): ARCHITECTURE ▸ Meshes (Making one, Opened meshes), Sequences, Skins, Bone paths,
Not built yet, Checked in Unity.

Phase K left an opened file carrying only a few kinds of data, and ARCHITECTURE listed a few
things as not built. Phase L does them:

1. **Deform and sequence keys between frames.** A deform timeline with a key between frames is
   written frame by frame (Spine's offsets at every whole frame, straight between). A sequence
   timeline becomes hold keys showing, at every frame, the image Spine shows (`bakedSequenceKeys`).
2. **Skin colours.** `SkinDef.color`, Spine's editor colour for a skin: a swatch in the Skins panel,
   written as nonessential data and read back. AI: `set_skin_color`.
3. **A mesh for a skin's own image.** Make Mesh, Remove Mesh, Bind and Unbind act on the image the
   stage shows (`meshTargets`, `shownMeshes`): a shown skin's own, or a display other than 0.
4. **Bone path leftovers.**
   - A dragged dot snaps onto the path's other dots, grid lines, guides and objects (`snapPoint`).
   - A smooth key's handles stay opposite as one is dragged; ⌥ makes a corner smooth or a smooth
     key a corner (`handlePartner`, `handlesSmooth`, `mirroredHandle`).
   - On a cycle the join is one key, so the curve runs smoothly across it.
   - The Ease panel says when a bend replaced a tween's position ease (`bentOnPath`).
5. **ARCHITECTURE ▸ Not built yet** brought up to date.
6. **The Unity check**, rerun with a rig holding a skin colour and a mesh made for a skin's image.

Video and sprite-sheet export still waits for the desktop build.
