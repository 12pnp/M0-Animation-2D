import type { Node, SymbolItem } from "./types";
import type { NodeId } from "./ids";
import { cloneTf, IDENTITY, type Transform } from "@/core/math/Transform";

/**
 * Bounding boxes and points (ARCHITECTURE ▸ Boxes and points), pure. A box
 * node holds a polygon in its own space (y down, about its origin), which
 * Spine's `boundingbox` attachment writes in the slot bone's space; a point
 * node is its own origin and x axis, Spine's `point` attachment at 0, 0, 0.
 * Neither draws: the stage outlines them.
 */

/** A point's pick and outline radius, in its own units. */
export const POINT_RADIUS = 6;

/** The box a box or point node takes on the stage, in its own space. */
export function boxNodeBounds(node: Node): { x: number; y: number; w: number; h: number } | null {
  if (node.kind === "point") return { x: -POINT_RADIUS, y: -POINT_RADIUS, w: POINT_RADIUS * 2, h: POINT_RADIUS * 2 };
  const p = node.kind === "box" ? node.box?.points : node.kind === "path" ? node.path?.points : undefined;
  if (!p || p.length < 6) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!);
    y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Whether (x, y) is within `tolerance` of the polyline `line`. */
export function nearPolyline(line: readonly number[], x: number, y: number, tolerance: number): boolean {
  for (let i = 0; i + 3 < line.length; i += 2) {
    const ax = line[i]!, ay = line[i + 1]!, dx = line[i + 2]! - ax, dy = line[i + 3]! - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= tolerance) return true;
  }
  return false;
}

/** Even-odd: whether (x, y) is inside the polygon `p`. */
export function inPolygon(p: readonly number[], x: number, y: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!, yi = p[i * 2 + 1]!, xj = p[j * 2]!, yj = p[j * 2 + 1]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
    const ax = p[i * 2]!, ay = p[i * 2 + 1]!, bx = p[((i + 1) % n) * 2]!, by = p[((i + 1) % n) * 2 + 1]!;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < bestD) { bestD = d; best = i; }
  }
  return [...p.slice(0, (best + 1) * 2), x, y, ...p.slice((best + 1) * 2)];
}

/** `p` without point `i`; null when fewer than three would be left. */
export function withoutBoxPoint(p: readonly number[], i: number): number[] | null {
  if (p.length / 2 <= 3) return null;
  return p.filter((_, k) => k >> 1 !== i);
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
