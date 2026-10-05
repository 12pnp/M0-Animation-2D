# The last carried things (Spine parity, phase K)

Done (2026-10-05): ARCHITECTURE ▸ Physics, sliders and paths, Colour, alpha and blend mode,
Meshes (deform keys), Skins (a skin's own box, point or path), Transform constraints, Checked in Unity.

After phase J an opened file still carries a few things the model does not hold. spine-unity's
samples have 10 path constraints (Hero, Stretchyman, mix-and-match, spineboy), 12 tinted
attachments (Spineunitygirl, mix-and-match) and 10 meshes deformed in a skin other than the
default (Goblins). Phase K makes them the document's, in this order:

1. **Opened path constraints.** A file's path constraint becomes the model's when its slot holds
   a path node and every field is one the model holds. Its `path` timelines become keys, and the
   skins that list it have it as a member. The reason they stayed carried (a path slot's key
   need not be its name) went away with `Node.key` in phase I.
2. **Attachment tint.** Spine's `color` on a region, mesh, linked mesh or sequence:
   `DisplayRef.tint` ("rrggbbaa"; display 0's `Node.tint`), written back on the attachment.
   It is edited in Properties for the display the node shows. spine-core poses a symbol with a
   tint, since the stage's own pose has no per-attachment colour. AI: `set_tint`.
3. **Deform keys on any display, in any skin.** Today only the default skin's display 0 takes
   deform keys. The keys of every other display go in `Animation.displayDeforms`, by skin, node
   and display. The pose, the export, the Mesh tool and the Deform row all use one accessor
   (`deformKeysOf`). The Deform row and the Mesh tool work on the mesh the stage shows. An opened
   file's skin deform timelines become keys.
4. **A transform constraint's property map edited.** Properties ▸ Transform lists what each
   source property drives (offset, scale, max) and adds or removes a mapping. It is no longer
   only kept.
5. **Boxes, points and paths in a slot skins fill.** A skin's own box, point or path under the
   node's key (`SkinDef.outlines`) is drawn, exported and edited like the node's own.
6. **The Unity check** rerun on rigs holding each.

Each step follows the project's rules. The decision is a pure function with a table test, and
a command replaces values. Anything exported gets a spine-core check. The app is checked with
real mouse input, and the AI bridge gets a tool for each new ability.
