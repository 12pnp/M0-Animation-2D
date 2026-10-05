# Other attachments and constraints (Spine parity, phase F)

Done (2026-10-05): ARCHITECTURE ▸ Bones and IK (stretch), Boxes and points, Sequences, Physics,
sliders and paths. Checked in Unity in phase H (ARCHITECTURE ▸ Checked in Unity).

docs/SPINE-PARITY-PLAN.md ▸ Phase F, in the order built:

1. **IK stretch, compress, scale y.** The rest of `apply1` / `apply2` ported to
   `core/math/ik.ts`; fields on `IkConstraint`, Properties ▸ IK, `add_ik`. Random-rig parity.
2. **Bounding boxes and points.** Node kinds of their own, outlined on the stage, made from
   Modify ▸ Attachments, box points edited with the Mesh tool. Parity on vertices and position.
3. **Sequences.** A display's numbered images, keyed by Spine's sequence timeline rule; Make
   Sequence from the library, a Sequence row, Properties ▸ Sequence. Parity frame by frame in
   every mode.
4. **Physics, sliders and paths.** Modelled as Spine writes them and solved by spine-core: a
   symbol with any is posed by the runtime (the opened rigs' path), so the stage is the export
   by construction. Physics simulates while the stage plays. Path nodes and Make Path from
   Bones; Properties sections; opened physics and sliders become the model's.

Decisions:

- **No port of the path, physics and slider solvers.** They are long and stateful (physics);
  the runtime that plays the export also poses the stage.
- **The stage's runtime rig** keeps what the stage does not set itself: a slider's animation
  whole, deform and sequence keys. It is rebuilt after edits (`docEpoch`), which also fixed
  opened rigs keeping a stale rig.

Out of scope for now:

- Keys of path, physics and slider constraints (opened files' are carried).
- Converting an opened file's boxes, points, paths and sequences into the model's.
- A mesh sequence, weighted boxes and paths, skin membership of the new constraints.
