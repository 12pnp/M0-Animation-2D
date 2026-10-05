import type { NodeId } from "@/core/doc/ids";
import type { DeformKey, MeshData } from "@/core/doc/types";
import { insidePolygon } from "./makeMesh";
import { triangulate } from "./triangulate";

/**
 * Editing a mesh (ARCHITECTURE ▸ Meshes), pure: a point added, removed or
 * moved, the mesh re-triangulated within its outline, weights and deform
 * offsets kept in step; automatic weights; a weight brush.
 */

type Weights = Array<Array<[NodeId, number]>>;

function retriangulated(m: MeshData): MeshData {
  return { ...m, triangles: triangulate(m.points, m.hull) };
}

/** The weights at (x, y) blended from the corners of the triangle it falls
 *  in (barycentric); null when it falls in none. */
function weightsAt(m: MeshData, x: number, y: number): Array<[NodeId, number]> | null {
  if (!m.weights) return null;
  const p = m.points;
  for (let t = 0; t < m.triangles.length; t += 3) {
    const [a, b, c] = [m.triangles[t]!, m.triangles[t + 1]!, m.triangles[t + 2]!];
    const ax = p[a * 2]!, ay = p[a * 2 + 1]!, bx = p[b * 2]!, by = p[b * 2 + 1]!, cx = p[c * 2]!, cy = p[c * 2 + 1]!;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
    const sum = new Map<NodeId, number>();
    for (const [i, l] of [[a, l1], [b, l2], [c, l3]] as const) for (const [bone, w] of m.weights[i] ?? []) sum.set(bone, (sum.get(bone) ?? 0) + w * l);
    return [...sum].filter(([, w]) => w > 1e-6).sort((u, v) => v[1] - u[1]);
  }
  return null;
}

/** `m` with a point at (x, y) inside its outline; null when outside. */
export function withPoint(m: MeshData, x: number, y: number): MeshData | null {
  if (!insidePolygon(m.points, m.hull, x, y)) return null;
  const out: MeshData = { ...m, points: [...m.points, x, y] };
  if (m.weights) out.weights = [...m.weights, weightsAt(m, x, y) ?? []];
  return retriangulated(out);
}

/** `m` without point `i`; null when that would leave an outline of fewer
 *  than three points. */
export function withoutPoint(m: MeshData, i: number): MeshData | null {
  const onHull = i < m.hull;
  if (onHull && m.hull <= 3) return null;
  const out: MeshData = { ...m, points: m.points.filter((_, k) => k >> 1 !== i), hull: onHull ? m.hull - 1 : m.hull };
  if (m.weights) out.weights = m.weights.filter((_, k) => k !== i);
  return retriangulated(out);
}

/** `m` with point `i` at (x, y); the triangles redone so none turns over. */
export function withPointMoved(m: MeshData, i: number, x: number, y: number): MeshData {
  const points = [...m.points];
  points[i * 2] = x;
  points[i * 2 + 1] = y;
  return retriangulated({ ...m, points });
}

/** Deform keys kept in step with a point added at the end or point `i` removed. */
export function deformsWithPoint(keys: readonly DeformKey[]): DeformKey[] {
  return keys.map((k) => ({ ...k, offsets: [...k.offsets, 0, 0] }));
}
export function deformsWithoutPoint(keys: readonly DeformKey[], i: number): DeformKey[] {
  return keys.map((k) => ({ ...k, offsets: k.offsets.filter((_, n) => n >> 1 !== i) }));
}

/** A bone as a segment, in the same space as the points it weighs. */
export interface BoneSegment { id: NodeId; x0: number; y0: number; x1: number; y1: number }

function segmentDistance(s: BoneSegment, x: number, y: number): number {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((x - s.x0) * dx + (y - s.y0) * dy) / len2)) : 0;
  return Math.hypot(x - s.x0 - t * dx, y - s.y0 - t * dy);
}

/**
 * Automatic weights: each point follows the `keep` bones nearest to it (by
 * distance to each bone's segment), weighted by the inverse fourth power of
 * that distance, normalized. A point on a bone follows it alone.
 */
export function autoWeights(points: readonly number[], bones: readonly BoneSegment[], keep = 2): Weights {
  const n = points.length / 2;
  return Array.from({ length: n }, (_, i) => {
    const x = points[i * 2]!, y = points[i * 2 + 1]!;
    const near = bones.map((b) => ({ id: b.id, d: segmentDistance(b, x, y) })).sort((a, b) => a.d - b.d).slice(0, keep);
    if (!near.length) return [];
    if (near[0]!.d < 1e-6) return [[near[0]!.id, 1]] as Array<[NodeId, number]>;
    const raw = near.map((b) => [b.id, 1 / b.d ** 4] as [NodeId, number]);
    const total = raw.reduce((s, [, w]) => s + w, 0);
    return raw.map(([id, w]) => [id, Math.round((w / total) * 1000) / 1000] as [NodeId, number]).filter(([, w]) => w > 0);
  });
}

/**
 * A stroke of the weight brush at (x, y): every point within `radius` gains
 * `strength` of `bone`'s weight (less towards the edge), the others' weights
 * scaled down to make room; weights under 1% are dropped and the rest
 * normalized. `points` are in the brush's space.
 */
export function paintWeights(
  weights: Weights | undefined, points: readonly number[], x: number, y: number, radius: number, bone: NodeId, strength: number,
): Weights {
  const n = points.length / 2;
  return Array.from({ length: n }, (_, i) => {
    const own = weights?.[i] ?? [];
    const d = Math.hypot(points[i * 2]! - x, points[i * 2 + 1]! - y);
    if (d > radius) return own;
    const add = strength * (1 - d / radius);
    const current = own.find(([b]) => b === bone)?.[1] ?? 0;
    const next = Math.min(1, current + add);
    const others = own.filter(([b]) => b !== bone);
    const rest = others.reduce((s, [, w]) => s + w, 0);
    const scale = rest > 0 ? (1 - next) / rest : 0;
    const out: Array<[NodeId, number]> = [[bone, next], ...others.map(([b, w]) => [b, w * scale] as [NodeId, number])];
    const kept = out.filter(([, w]) => w >= 0.01);
    const total = kept.reduce((s, [, w]) => s + w, 0) || 1;
    return kept.map(([b, w]) => [b, Math.round((w / total) * 1000) / 1000] as [NodeId, number]).sort((u, v) => v[1] - u[1]);
  });
}
