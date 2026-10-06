import type { AttachmentRef } from "@/edit/attachments";
import { findAttachment } from "@/edit/attachments";
import { decodeBinds, isWeighted } from "@/edit/meshLayout";
import { type Skeleton, attachmentType } from "@/model/skeleton";
import type { Point } from "./gizmo";
import { boneMatrix, type Posed } from "./posed";

/**
 * The selected path attachment as the stage edits it (docs/PATH-PLAN.md): every vertex in the world
 * on the setup pose, three to a point (handle in, the point, handle out), and the slot bone's matrix
 * for taking a world point into its space.
 */
export interface PathView {
  readonly ref: AttachmentRef;
  /** x, y of each vertex in the world. */
  readonly world: readonly number[];
  readonly closed: boolean;
  /** The slot bone's world matrix [a, b, c, d, x, y]. */
  readonly bone: readonly number[];
}

/** The path at `ref` as the stage shows it, or null when it is not a path (or its slot has no bone). */
export function pathView(doc: Skeleton, p: Posed, ref: AttachmentRef): PathView | null {
  const a = findAttachment(doc, ref);
  if (!a || attachmentType(a) !== "path" || !a.vertices || a.vertexCount === undefined) return null;
  const slot = doc.slots?.find((x) => x.name === ref.slot), index = slot ? p.bones.get(slot.bone) : undefined;
  if (index === undefined) return null;
  const m = boneMatrix(p, index), world: number[] = [], v = a.vertices;
  if (!isWeighted(a)) {
    for (let i = 0; i + 1 < v.length; i += 2) world.push(m[0] * v[i]! + m[1] * v[i + 1]! + m[4], m[2] * v[i]! + m[3] * v[i + 1]! + m[5]);
  } else {
    for (const binds of decodeBinds(v)) {
      let x = 0, y = 0;
      for (const b of binds) {
        const bm = boneMatrix(p, b.bone);
        x += (bm[0] * b.x + bm[1] * b.y + bm[4]) * b.w;
        y += (bm[2] * b.x + bm[3] * b.y + bm[5]) * b.w;
      }
      world.push(x, y);
    }
  }
  if (!world.every(Number.isFinite)) return null;
  return { ref, world, closed: !!a.closed, bone: [...m] };
}

/** A world point in the slot bone's space, to two decimals as a drag writes it. */
export function toSlot(view: PathView, [x, y]: Point): [number, number] {
  const [a, b, c, d, wx, wy] = view.bone as [number, number, number, number, number, number];
  const det = a * d - b * c, dx = x - wx, dy = y - wy;
  const r = (n: number) => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };
  return [r((d * dx - b * dy) / det), r((a * dy - c * dx) / det)];
}

/**
 * The vertex a press at screen point (`sx`, `sy`) lands on, or -1. `screen` is each vertex on
 * screen. A point (the middle of a three) is grabbed from further away than a handle, and wins a tie.
 */
export function hitPath(screen: readonly number[], sx: number, sy: number, pointRadius = 9, handleRadius = 7): number {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < screen.length / 2; i++) {
    const isPoint = i % 3 === 1, radius = isPoint ? pointRadius : handleRadius;
    const d = Math.hypot(screen[i * 2]! - sx, screen[i * 2 + 1]! - sy);
    if (d <= radius && d - (isPoint ? 2 : 0) < bestD) { best = i; bestD = d - (isPoint ? 2 : 0); }
  }
  return best;
}
