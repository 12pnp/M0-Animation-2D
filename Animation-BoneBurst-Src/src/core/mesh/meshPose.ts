import { applyInverse, apply, invert, mat, type Matrix2D, mul } from "@/core/math/Matrix2D";
import type { MeshData } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";

/**
 * Where a mesh's points are (ARCHITECTURE ▸ Meshes): the one rule the stage
 * draws with and the exporter writes, so they agree by construction. `p` is a
 * point in its node's space (point − pivot, y down), `d` its deform offset.
 *
 * - no weights: `node world now · (p + d)`;
 * - weights: `Σ w_i · B_i · S_i⁻¹ · N · (p + d)`, `B_i` bone i's world now,
 *   `S_i` at the setup pose, `N` the node's world at the setup pose. Spine
 *   stores `S_i⁻¹ · N · p` per bone and sums `w_i · B_i · (offset + deform)`.
 */

export interface MeshBones {
  /** A bone's world now. */
  now(id: NodeId): Matrix2D | undefined;
  /** A bone's world at the setup pose. */
  setup(id: NodeId): Matrix2D | undefined;
  /** The mesh node's world at the setup pose. */
  node: Matrix2D;
}

/** Every point's setup position (`MeshData.vertices`, else its texture
 *  coordinate), flat, in the image's pixel frame. */
export function meshPositions(mesh: MeshData): readonly number[] {
  return mesh.vertices ?? mesh.points;
}

/** The point `i` in its node's space, deform included. */
function localPoint(mesh: MeshData, pivot: { x: number; y: number }, i: number, deform?: readonly number[] | null) {
  const p = meshPositions(mesh);
  return {
    x: p[i * 2]! - pivot.x + (deform?.[i * 2] ?? 0),
    y: p[i * 2 + 1]! - pivot.y + (deform?.[i * 2 + 1] ?? 0),
  };
}

/** Every point's world position, flat `[x0, y0, …]`. */
export function meshWorld(
  mesh: MeshData, pivot: { x: number; y: number }, nodeNow: Matrix2D, deform?: readonly number[] | null, bones?: MeshBones,
): number[] {
  const n = mesh.points.length / 2;
  const out = new Array<number>(n * 2);
  const tmp = { x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    const p = localPoint(mesh, pivot, i, deform);
    const w = mesh.weights?.[i];
    if (!w?.length || !bones) {
      apply(tmp, nodeNow, p.x, p.y);
      out[i * 2] = tmp.x;
      out[i * 2 + 1] = tmp.y;
      continue;
    }
    apply(tmp, bones.node, p.x, p.y);
    const sx = tmp.x, sy = tmp.y;
    const own = mesh.boneOffsets?.[i];
    const dx = deform?.[i * 2] ?? 0, dy = deform?.[i * 2 + 1] ?? 0;
    let x = 0, y = 0, total = 0;
    for (let j = 0; j < w.length; j++) {
      const [bone, weight] = w[j]!;
      const b = bones.now(bone), s = bones.setup(bone);
      if (!b || !s) continue;
      const o = { x: 0, y: 0 };
      if (own?.[j]) {
        // The file's own offset, the deform carried into the bone's setup space.
        const d = boneSpaceDelta(s, bones.node, dx, dy);
        if (!d) continue;
        o.x = own[j]![0] + d.x;
        o.y = own[j]![1] + d.y;
      } else if (!applyInverse(o, s, sx, sy)) continue;
      apply(tmp, b, o.x, o.y);
      x += tmp.x * weight;
      y += tmp.y * weight;
      total += weight;
    }
    // Not renormalized: the runtime sums the weights as written.
    out[i * 2] = total ? x : sx;
    out[i * 2 + 1] = total ? y : sy;
  }
  return out;
}

/** The texture coordinates: each point over the image's size. */
export function meshUvs(mesh: MeshData, width: number, height: number): number[] {
  return mesh.points.map((v, i) => (i % 2 === 0 ? v / width : v / height));
}

/**
 * Spine's `vertices` for the mesh, in the slot bone's space for no weights
 * (y up), or `[count, bone, x, y, weight, …]` per point with each offset in
 * that bone's setup space (y up) and bones by name (`bonesToIndices` turns
 * them into indices). In a weighted mesh a point with no weights follows
 * its own node (`self`) at weight 1, where the stage leaves it: Spine has no
 * unweighted point in a weighted mesh.
 */
export function boneburstVertices(
  mesh: MeshData, pivot: { x: number; y: number }, bones: MeshBones | null, nameOf: (id: NodeId) => string, self?: NodeId,
): Array<number | string> {
  const n = mesh.points.length / 2;
  const out: Array<number | string> = [];
  for (let i = 0; i < n; i++) {
    const p = localPoint(mesh, pivot, i);
    if (!bones) { out.push(p.x, -p.y); continue; }
    const entries = (mesh.weights?.[i] ?? []).map((e, j) => [e, mesh.boneOffsets?.[i]?.[j]] as const).filter(([[b]]) => bones.setup(b));
    if (!entries.length) { if (self) out.push(1, nameOf(self), p.x, -p.y, 1); else out.push(0); continue; }
    out.push(entries.length);
    const world = apply({ x: 0, y: 0 }, bones.node, p.x, p.y);
    for (const [[bone, weight], own] of entries) {
      const o = own ? { x: own[0], y: own[1] } : { x: 0, y: 0 };
      if (!own) applyInverse(o, bones.setup(bone)!, world.x, world.y);
      out.push(nameOf(bone), o.x, 0 - o.y, weight);
    }
  }
  return out;
}

/** A deform key's offsets as Spine's `deform` vertices: per point (no
 *  weights) in the slot bone's space, or per weighted entry in that bone's
 *  setup space, both y up. */
export function boneburstDeform(mesh: MeshData, offsets: readonly number[], bones: MeshBones | null): number[] {
  const n = mesh.points.length / 2;
  const out: number[] = [];
  const lin = (m: Matrix2D) => ({ ...m, tx: 0, ty: 0 });
  for (let i = 0; i < n; i++) {
    const dx = offsets[i * 2] ?? 0, dy = offsets[i * 2 + 1] ?? 0;
    const w = mesh.weights?.[i];
    const live = w?.filter(([b]) => bones?.setup(b)) ?? [];
    // No weights (or none live): the slot bone's space, or the node's own
    // bone at weight 1 in a weighted mesh; either way the node's space.
    if (!live.length || !bones) { out.push(dx, -dy); continue; }
    const world = apply({ x: 0, y: 0 }, lin(bones.node), dx, dy);
    for (const [bone] of live) {
      const inv = mat();
      if (!invert(inv, lin(bones.setup(bone)!))) { out.push(0, 0); continue; }
      const o = apply({ x: 0, y: 0 }, inv, world.x, world.y);
      out.push(o.x, -o.y);
    }
  }
  return out;
}

/** A node-space offset in a bone's setup space: `lin(S⁻¹ · N) · d`. */
export function boneSpaceDelta(setup: Matrix2D, node: Matrix2D, dx: number, dy: number): { x: number; y: number } | null {
  const inv = mat();
  if (!invert(inv, { ...setup, tx: 0, ty: 0 })) return null;
  const w = apply({ x: 0, y: 0 }, { ...node, tx: 0, ty: 0 }, dx, dy);
  return apply({ x: 0, y: 0 }, inv, w.x, w.y);
}

/**
 * How far point `i` must move in its node's space (a deform offset) for its
 * world position to move by (dx, dy): the world motion through the inverse of
 * the point's own linear map, `node world` without weights, `Σ w_i · B_i ·
 * S_i⁻¹ · N` with them. Exact, since the map is affine in the offset.
 */
export function localDelta(
  mesh: MeshData, i: number, nodeNow: Matrix2D, bones: MeshBones | undefined, dx: number, dy: number,
): { x: number; y: number } {
  const w = mesh.weights?.[i];
  let a = 0, b = 0, c = 0, d = 0;
  if (!w?.length || !bones) ({ a, b, c, d } = nodeNow);
  else {
    for (const [bone, weight] of w) {
      const B = bones.now(bone), S = bones.setup(bone);
      if (!B || !S) continue;
      const inv = mat();
      if (!invert(inv, S)) continue;
      const m = mul(mat(), mul(mat(), B, inv), bones.node);
      a += m.a * weight; b += m.b * weight; c += m.c * weight; d += m.d * weight;
    }
  }
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return { x: 0, y: 0 };
  return { x: (d * dx - c * dy) / det, y: (a * dy - b * dx) / det };
}
