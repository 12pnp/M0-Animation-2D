# Transform constraints (Spine parity, phase C)

Done (ARCHITECTURE ▸ Transform constraints). docs/SPINE-PARITY-PLAN.md ▸ Phase C. A transform constraint makes bones follow another bone's
rotation, position, scale or shear, in world or local space, as Spine 4.3's does. Before this, an
opened file's transform constraints were carried and only spine-core posed them.

## Spine 4.3 (spine-core 4.3.13, `TransformConstraint`, `TransformConstraintData`)

- `bones` follow `source`. `localSource` / `localTarget` read and write local values instead
  of world ones; `additive` adds instead of replacing; `clamp` keeps each result between the
  property's offset and its `max`.
- `properties` map a source property to target properties: `{ rotate: { offset, to: { x: {
  offset, max, scale } } } }`. A constraint without `properties` maps nothing: spine-core
  4.3.13 reads none, and the importer keeps it that way. Offsets per source property (`rotation`, `x`, `y`, `scaleX`, `scaleY`,
  `shearY` on the constraint) are added to what the source reads.
- One mix per target property (`mixRotate`, `mixX`, `mixY` (default `mixX`), `mixScaleX`,
  `mixScaleY` (default `mixScaleX`), `mixShearY`), each read only when a property maps to it.
- Constraints apply in the file's list order; the exporter writes IK first, then transform.

## The model (schema 20)

`SymbolItem.transforms?: TransformConstraint[]`: `{ id, name, boneIds, sourceId, localSource?,
localTarget?, additive?, clamp?, offsets, mix, properties, spine? }`, every value as Spine writes
it (y up). Pure solver in `core/math/transformConstraint.ts`, transcribed from spine-core and
checked against it; the stage solves after IK in one constraint pass that shares IK's solved
locals (`pose.ts`), since a world change to a bone rebuilds its children from their solved
locals, as the runtime does.

## Steps

1. Solver port and model, schema, sanitize; the constraint pass in `pose.ts`.
2. Export (constraint list and `transform` timelines) and import (an opened file's become the
   model's when their bones resolve). Parity: random rigs with world and local, additive and
   clamp, against spine-core frame by frame, as `IK: 60 random rigs` does.
3. Keys: `Animation.transforms` (the six mixes per key, linear / stepped / smooth), a row on
   the timeline beside the IK rows, the stage and opened rigs reading them.
4. Properties: a Transform section on a bone (add one with the selected bones following a
   source; source, mixes, offsets, Local source / Local target / Relative / Clamp; delete).
5. AI: `add_transform_constraint`, `key_transform`.
6. Docs: ARCHITECTURE ▸ Transform constraints.

## Out of scope

- Editing a remapped `properties` table (a source property driving another kind): it is read,
  solved, exported and kept; the panel edits the identity map's offsets and mixes.
- Non-normal inherit on a constrained bone: native symbols have none; opened rigs are posed by
  spine-core.
