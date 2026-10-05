# Meshes (Spine parity, phase D)

Done (2026-10-05): ARCHITECTURE ▸ Meshes. Checked in Unity in phase H (ARCHITECTURE ▸ Checked in Unity).

docs/SPINE-PARITY-PLAN.md ▸ Phase D. An image becomes a mesh: its outline and inner points
triangulated, the points bound to bones by weights, and moved per frame by deform keys, as
Spine's mesh attachments, weights and `deform` timeline. Today an opened file's meshes are
drawn (through spine-core) and written back, and nothing here makes or edits one.

## The model

```ts
interface MeshData {
  points: number[];      // x, y per point in the image's pixels (y down, origin top-left): where
                         // the point is and the texture it shows (uv = point ÷ size)
  triangles: number[];   // three point indices each
  hull: number;          // the first `hull` points, in order, are the outline
  weights?: Array<Array<[NodeId, number]>>;  // per point, bones and weights summing to 1
}
DisplayRef.mesh?: MeshData
Animation.deforms?: Record<NodeId, DeformKey[]>  // per mesh node: { frame, offsets, tween? }
```

**One rule for where a point is**, used by the stage and written by the exporter, so they
agree by construction. With `p` the point in the node's own space (`point − pivot`), `N` the
node's world at the setup pose, `B_i` bone i's world now and `S_i` at the setup pose, and `d`
the deform offset in the node's space:

- no weights: `world = node world now · (p + d)`;
- weights: `world = Σ w_i · B_i · S_i⁻¹ · N · (p + d)`.

Spine stores a weighted vertex as an offset in each bone's space at the setup pose
(`S_i⁻¹ · N · p`) and a weighted deform as offsets in those spaces (the linear part of
`S_i⁻¹ · N` times `d`); its runtime sums `w_i · B_i · (offset + deform)`, which is the same.

## Steps

1. **Mesh.** `core/mesh/`: the outline from the image's alpha (`traceContour`), points along
   it and inside it, and a triangulation that stays inside the outline (ear clipping of the
   outline, the inner points inserted, Delaunay flips that never cross an outline edge). The
   stage draws a mesh display through the triangle path the opened rigs use; the exporter
   writes `type: "mesh"` (uvs, triangles, vertices, hull, width, height). Modify ▸ Make Mesh;
   a Mesh tool: drag a point, click inside to add one, Delete removes it, re-triangulated.
   Parity: world vertices against spine-core.
2. **Weights.** Bind a mesh to the selected bones; automatic weights (distance to each bone's
   segment, the nearest bones kept); a brush that adds weight for a chosen bone; points
   tinted by their bone. Weighted vertices exported as Spine's.
3. **Deform keys.** In Animate mode the Mesh tool moving points keys a deform at the playhead;
   a Deform row on the timeline; the `deform` timeline exported and imported; parity on world
   vertices frame by frame.
4. **Docs.** ARCHITECTURE ▸ Meshes.

## Out of scope for now

- Converting an opened file's mesh attachments into editable meshes: they stay carried and are
  posed by spine-core.
- Linked meshes, mesh edges for Spine's editor, and per-point setup positions that differ from
  the texture position (Spine's "deform in setup").
