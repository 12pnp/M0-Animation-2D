import type { ConstraintType } from "@/model/skeleton";
import { boneMatrix, boneTip, type Posed } from "./posed";

/**
 * What the stage draws for each constraint (E4-PLAN step 12), in world space, in the pose shown:
 * IK reaches from its chain's end to its target; a transform links its source to each bone it
 * moves; a path lays its bones along its attachment's curve; physics and sliders mark their bone.
 * No DOM: tested in vitest, drawn by the stage.
 */

/** A bezier segment: start, two handles, end (x, y each). */
export type Curve = readonly [number, number, number, number, number, number, number, number];

export interface ConstraintShape {
  /** Index in the skeleton's constraints (and the rig's). */
  readonly index: number;
  readonly type: ConstraintType;
  readonly name: string;
  /** Dashed links: x0, y0, x1, y1 each. */
  readonly links: readonly (readonly [number, number, number, number])[];
  readonly curves: readonly Curve[];
  /** Rings (an IK target, a physics bone), dots (a path's bones), squares (a slider's bone). */
  readonly marks: readonly { readonly x: number; readonly y: number; readonly mark: "ring" | "dot" | "square" }[];
}

const origin = (p: Posed, bone: number): [number, number] => { const m = boneMatrix(p, bone); return [m[4], m[5]]; };

/** Every active constraint's shape. */
export function constraintShapes(p: Posed): ConstraintShape[] {
  const out: ConstraintShape[] = [];
  p.rig.data.constraints.forEach((k, index) => {
    if (!p.rig.constraintActive[index]) return;
    const base = { index, type: k.kind, name: k.name };
    switch (k.kind) {
      case "ik": {
        const end = boneTip(p, k.bones.at(-1)!), [tx, ty] = origin(p, k.target);
        out.push({ ...base, links: [[end[0], end[1], tx, ty]], curves: [], marks: [{ x: tx, y: ty, mark: "ring" }] });
        break;
      }
      case "transform": {
        const [sx, sy] = origin(p, k.source);
        out.push({ ...base, links: k.bones.map((b) => { const [x, y] = origin(p, b); return [sx, sy, x, y] as const; }), curves: [], marks: [] });
        break;
      }
      case "path": {
        out.push({ ...base, links: [], curves: pathCurves(p, k.slot), marks: k.bones.map((b) => { const [x, y] = origin(p, b); return { x, y, mark: "dot" as const }; }) });
        break;
      }
      case "physics": {
        const [x, y] = origin(p, k.bone);
        out.push({ ...base, links: [], curves: [], marks: [{ x, y, mark: "ring" }] });
        break;
      }
      case "slider": {
        if (k.bone < 0) return;
        const [x, y] = origin(p, k.bone);
        out.push({ ...base, links: [], curves: [], marks: [{ x, y, mark: "square" }] });
        break;
      }
    }
  });
  return out;
}

/**
 * The bezier segments of the path attachment shown in `slot`, in the world. Its points come in
 * threes (handle in, point, handle out); segment i runs from point i to point i + 1, and from the
 * last point back to the first when the path is closed.
 */
export function pathCurves(p: Posed, slot: number): Curve[] {
  const att = p.rig.attachmentOf(slot);
  if (!att || att.kind !== "path") return [];
  const n = att.vertexCount;
  const w = new Float64Array(n * 2);
  p.rig.vertexWorld(slot, att, 0, n * 2, w, 0);
  const points = Math.floor(n / 3), out: Curve[] = [];
  const at = (i: number, k: number): [number, number] => [w[(i * 3 + k) * 2]!, w[(i * 3 + k) * 2 + 1]!];
  const segments = att.closed ? points : points - 1;
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % points;
    const [x0, y0] = at(i, 1), [c1x, c1y] = at(i, 2), [c2x, c2y] = at(j, 0), [x1, y1] = at(j, 1);
    out.push([x0, y0, c1x, c1y, c2x, c2y, x1, y1]);
  }
  return out;
}

/** A point on a bezier segment at t. */
function bezier(c: Curve, t: number): [number, number] {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]];
}

/**
 * The constraint drawn within `radius` screen pixels of (`sx`, `sy`): the nearest, the later on a
 * tie; null when none. `screen` maps a world point to screen pixels.
 */
export function hitConstraint(shapes: readonly ConstraintShape[], screen: (x: number, y: number) => [number, number], sx: number, sy: number, radius = 6): ConstraintShape | null {
  let best: ConstraintShape | null = null, bestD = radius;
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / l2)) : 0;
    return Math.hypot(sx - (ax + t * dx), sy - (ay + t * dy));
  };
  for (const s of shapes) {
    let d = Infinity;
    for (const [x0, y0, x1, y1] of s.links) { const a = screen(x0, y0), b = screen(x1, y1); d = Math.min(d, seg(a[0], a[1], b[0], b[1])); }
    for (const c of s.curves) {
      let prev = screen(c[0], c[1]);
      for (let k = 1; k <= 16; k++) { const [x, y] = bezier(c, k / 16), q = screen(x, y); d = Math.min(d, seg(prev[0], prev[1], q[0], q[1])); prev = q; }
    }
    // A mark is grabbed anywhere on it (rings and squares are about 6 pixels across).
    for (const m of s.marks) { const [x, y] = screen(m.x, m.y); d = Math.min(d, Math.max(0, Math.hypot(sx - x, sy - y) - 6)); }
    if (d <= bestD) { best = s; bestD = d; }
  }
  return best;
}
