# Carried things made editable (Spine parity, phase I)

Done (2026-10-05): ARCHITECTURE ▸ Inherit modes, Physics, sliders and paths (keys), Meshes
(opened meshes, linked meshes), Boxes and points, Sequences, Skins, bone icons, Checked in Unity.

docs/SPINE-PARITY-PLAN.md marks with ◐ what an opened file keeps and the export writes back,
but nothing here edits. Phase I makes those editable, in this order:

1. **Inherit modes and keys.** Properties ▸ Bone ▸ Inherit sets `Node.inherit` in Setup mode
   and keys it in Animate mode (`Animation.inherits`, Spine's `inherit` timeline, stepped).
   The stage cannot compose a bone that ignores part of its parent, so a symbol with either is
   posed by spine-core (`runtimePosed`), the way physics is. Inherit keys show on a row under
   the bone. An opened file's inherit timelines become keys. AI: `set_inherit`.
2. **Physics, slider and path constraint keys.** Each constraint's keyable values get a
   timeline row, as IK and transform constraints have. A physics constraint keys its mix,
   inertia, strength, damping, mass, wind and gravity. A slider keys its time and mix. A path
   keys position, spacing and its three mixes. The keys are in `Animation.constraintKeys`,
   written as Spine's `physics`, `slider` and `path` timelines and applied to the runtime rig.
   An opened file's become keys. AI: `key_constraint`.
3. **Opened meshes become editable**, then **linked meshes** (one mesh's shape on another
   image).
4. **Opened boxes, points, paths and sequences become the model's.**
5. **Smaller gaps**: bone icons in the Tree, skin membership of the phase F constraints.
6. **The Unity check** again after the format changes.

Each step follows the project's rules. The decision is a pure function with a table test,
and a command replaces values. Anything exported gets a spine-core parity case. The app is
checked with real mouse input, and the AI bridge gets a tool.
