import type { MeshData, Node, OutlineWeights, SymbolItem } from "./types";
import type { NodeId } from "./ids";
import { cloneTf, IDENTITY, type Transform } from "@/core/math/Transform";
import { apply, matOf, type Matrix2D } from "@/core/math/Matrix2D";
import { meshWorld, type MeshBones } from "@/core/mesh/meshPose";
import { segmentDistance } from "@/core/math/geom";

/**
 * Bounding boxes and points (ARCHITECTURE ▸ Boxes and points), pure. A box
 * node holds a polygon in its own space (y down, about its origin), which
 * Spine's `boundingbox` attachment writes in the slot bone's space; a point
 * node is its own origin and x axis moved by `Node.point`, Spine's `point`
 * attachment. A box or path opened weighted follows its bones by the mesh
 * rule (`meshWorld`). Neither draws: the stage outlines them.
 */

/** The skin whose own outline the stage shows for a box, point or path
 *  node: the last of `skins` that has one; null, the node's own. */
export function outlineSkin(sym: SymbolItem, node: Node, skins: readonly string[]): string | null {
  for (const name of [...skins].reverse()) if (sym.skins?.find((d) => d.name === name)?.outlines?.[node.id]) return name;
  return null;
}

/** `node` as the shown skins outline it: a skin's box, path or point in
 *  place of its own (Spine's skin attachment under the node's key). */
export function skinnedOutline(sym: SymbolItem, node: Node, skins: readonly string[]): Node {
  const skin = outlineSkin(sym, node, skins);
  const o = skin ? sym.skins!.find((d) => d.name === skin)!.outlines![node.id]! : null;
  if (!o) return node;
  const out = { ...node };
  if (node.kind === "box" && o.box) out.box = o.box;
  if (node.kind === "path" && o.path) out.path = o.path;
  if (node.kind === "point") { if (o.point) out.point = o.point; else delete out.point; }
  return out;
}

/** The outline field of `o` a node of `kind` holds. */
export function outlineField(kind: Node["kind"]): "box" | "path" | "point" | null {
  return kind === "box" || kind === "path" || kind === "point" ? kind : null;
}

/** A point's pick and outline radius, in its own units. */
export const POINT_RADIUS = 6;

/** A point node's place in its own space: its offset, then its rotation. */
export function pointMatrix(node: Node): Matrix2D {
  const p = node.point;
  if (!p) return matOf(1, 0, 0, 1, 0, 0);
  const r = (p.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return matOf(c, s, -s, c, p.x, p.y);
}

/** `node` with its point offset changed by `patch`; none at the origin. */
export function withPointOffset(node: Node, patch: Partial<NonNullable<Node["point"]>>): Node {
  const p = { x: 0, y: 0, rotation: 0, ...node.point, ...patch };
  const out = { ...node };
  if (p.x || p.y || p.rotation) out.point = p; else delete out.point;
  return out;
}

/** The point as Spine's attachment writes it: y up, counterclockwise. */
export function pointToBoneBurst(node: Node): Record<string, number> {
  const p = node.point, out: Record<string, number> = {};
  if (!p) return out;
  if (p.x) out.x = p.x;
  if (p.y) out.y = 0 - p.y;
  if (p.rotation) out.rotation = 0 - p.rotation;
  return out;
}

/** The box a box or point node takes on the stage, in its own space. */
export function boxNodeBounds(node: Node): { x: number; y: number; w: number; h: number } | null {
  if (node.kind === "point") {
    const x = node.point?.x ?? 0, y = node.point?.y ?? 0;
    return { x: x - POINT_RADIUS, y: y - POINT_RADIUS, w: POINT_RADIUS * 2, h: POINT_RADIUS * 2 };
  }
  const p = node.kind === "box" ? node.box?.points : node.kind === "path" ? node.path?.points : undefined;
  if (!p || p.length < 6) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!);
    y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A box's or path's points and their weights, if any. */
export function outlineOfNode(node: Node): ({ points: number[] } & OutlineWeights) | null {
  return node.kind === "box" ? node.box ?? null : node.kind === "path" ? node.path ?? null : null;
}

/** Whether a box's or path's points follow bones. */
export function outlineWeighted(node: Node): boolean {
  return !!outlineOfNode(node)?.weights?.some((w) => w.length);
}

/** An outline as a mesh with no triangles, for the mesh rule's functions
 *  (`meshWorld`, `boneburstVertices`, `localDelta`): its points about 0, 0. */
export function outlineAsMesh(o: { points: number[] } & OutlineWeights): MeshData {
  const m: MeshData = { width: 1, height: 1, points: o.points, triangles: [], hull: 0 };
  if (o.weights) m.weights = o.weights;
  if (o.boneOffsets) m.boneOffsets = o.boneOffsets;
  return m;
}

/** A box's or path's points in the world: through the node, or, weighted,
 *  through its bones (`bones` now and at the setup pose). */
export function outlineWorld(node: Node, world: Matrix2D, bones?: MeshBones | null): number[] {
  const o = outlineOfNode(node);
  if (!o) return [];
  if (bones && outlineWeighted(node)) return meshWorld(outlineAsMesh(o), { x: 0, y: 0 }, world, null, bones);
  const out = new Array<number>(o.points.length), q = { x: 0, y: 0 };
  for (let i = 0; i < o.points.length; i += 2) {
    apply(q, world, o.points[i]!, o.points[i + 1]!);
    out[i] = q.x; out[i + 1] = q.y;
  }
  return out;
}

/** `o` with point positions `points`, the moved ones dropping the file's own
 *  bone offsets (they follow their bones from where they now are). */
export function withOutlinePoints<T extends { points: number[] } & OutlineWeights>(o: T, points: number[], moved: Iterable<number>): T {
  const out = { ...o, points };
  if (o.boneOffsets) {
    const offs = [...o.boneOffsets];
    for (const i of moved) offs[i] = [];
    if (offs.some((x) => x.length)) out.boneOffsets = offs; else delete out.boneOffsets;
  }
  return out;
}

/** A box's or path's points in the world as the pose has them. */
export function entryOutline(e: { node: Node; world: Matrix2D; outline?: number[] }): number[] {
  return e.outline ?? outlineWorld(e.node, e.world);
}

/** The points of `next` that differ from `base`, rounded to hundredths, the
 *  rest left exactly as they were (an opened file's are not rounded). */
export function roundMoved(base: readonly number[], next: readonly number[]): { points: number[]; moved: number[] } {
  const moved: number[] = [];
  const points = [...next];
  for (let i = 0; i < next.length / 2; i++) {
    if (next[i * 2] === base[i * 2] && next[i * 2 + 1] === base[i * 2 + 1]) continue;
    moved.push(i);
    points[i * 2] = Math.round(next[i * 2]! * 100) / 100;
    points[i * 2 + 1] = Math.round(next[i * 2 + 1]! * 100) / 100;
  }
  return { points, moved };
}

/** Whether (x, y) is within `tolerance` of the polyline `line`. */
export function nearPolyline(line: readonly number[], x: number, y: number, tolerance: number): boolean {
  for (let i = 0; i + 3 < line.length; i += 2) {
    if (segmentDistance(line[i]!, line[i + 1]!, line[i + 2]!, line[i + 3]!, x, y) <= tolerance) return true;
  }
  return false;
}

/** A box polygon for an image's outline (pixels, y down) about its pivot:
 *  the shape the box node takes when made from a picture. */
export function boxFromOutline(outline: readonly number[], pivot: { x: number; y: number }): number[] {
  return outline.map((v, i) => Math.round((v - (i % 2 === 0 ? pivot.x : pivot.y)) * 100) / 100);
}

/** `p` with a point at (x, y) on the edge nearest to it. */
export function withBoxPoint(p: readonly number[], x: number, y: number): number[] {
  const n = p.length / 2;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = segmentDistance(p[i * 2]!, p[i * 2 + 1]!, p[j * 2]!, p[j * 2 + 1]!, x, y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return [...p.slice(0, (best + 1) * 2), x, y, ...p.slice((best + 1) * 2)];
}

/** `p` without point `i`; null when fewer than three would be left. */
export function withoutBoxPoint(p: readonly number[], i: number): number[] | null {
  if (p.length / 2 <= 3) return null;
  return p.filter((_, k) => k >> 1 !== i);
}

/**
 * A box's weights after `withBoxPoint` put a point in at `at`: the new point
 * takes the two it sits between, half each, merged by bone, and no offsets.
 */
export function boxWeightsWithPoint(box: { points: number[] } & OutlineWeights, at: number): OutlineWeights {
  if (!box.weights) return {};
  const n = box.weights.length;
  const merged = new Map<NodeId, number>();
  for (const w of [box.weights[(at - 1 + n) % n]!, box.weights[at % n]!]) for (const [b, v] of w) merged.set(b, (merged.get(b) ?? 0) + v / 2);
  const out: OutlineWeights = { weights: [...box.weights.slice(0, at), [...merged], ...box.weights.slice(at)] };
  if (box.boneOffsets) out.boneOffsets = [...box.boneOffsets.slice(0, at), [], ...box.boneOffsets.slice(at)];
  return out;
}

/** The weights of the points `keep` says stay. */
export function outlineWeightsKept(o: OutlineWeights, keep: (i: number) => boolean): OutlineWeights {
  const out: OutlineWeights = {};
  if (o.weights) out.weights = o.weights.filter((_, i) => keep(i));
  if (o.boneOffsets) out.boneOffsets = o.boneOffsets.filter((_, i) => keep(i));
  return out;
}

/** `base`, else `base 2`, …: a name no node of `sym` has. */
export function uniqueNodeName(sym: SymbolItem, base: string): string {
  const taken = new Set(Object.values(sym.nodes).map((n) => n.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
  return name;
}

export interface AttachmentPlan {
  name: string;
  parentId: NodeId | null;
  bind: Transform;
  /** Where its layer goes: above the selected node's, else the top. */
  layerIndex: number;
  points?: number[];
}

/**
 * Where a new box or point goes (ARCHITECTURE ▸ Boxes and points): on a
 * selected image, in its place (a box takes its outline, `outline` in image
 * pixels, else its rectangle); on a selected bone, at its origin under it (a
 * box a square); else at the origin.
 */
export function attachmentPlan(
  sym: SymbolItem, kind: "box" | "point", selected: Node | null, outline: readonly number[] | null, size?: { w: number; h: number },
): AttachmentPlan {
  const layerIndex = selected ? Math.max(0, sym.layers.findIndex((l) => l.nodeId === selected.id)) : 0;
  const square = [-20, -20, 20, -20, 20, 20, -20, 20];
  if (selected && selected.kind !== "bone" && selected.kind !== "group") {
    const rect = size ? [0, 0, size.w, 0, size.w, size.h, 0, size.h] : null;
    const shape = outline && outline.length >= 6 ? outline : rect;
    return {
      name: uniqueNodeName(sym, `${selected.name}_${kind}`), parentId: selected.parentId, bind: cloneTf(selected.bind), layerIndex,
      ...(kind === "box" ? { points: shape ? boxFromOutline(shape, selected.pivot) : square } : {}),
    };
  }
  return {
    name: uniqueNodeName(sym, selected ? `${selected.name}_${kind}` : kind), parentId: selected?.id ?? null, bind: cloneTf(IDENTITY), layerIndex,
    ...(kind === "box" ? { points: square } : {}),
  };
}
