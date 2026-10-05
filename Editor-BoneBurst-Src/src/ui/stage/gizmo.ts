/**
 * The transform tools' maths: a pointer drag in the world turned into a bone's new local setup
 * values, and which bone the pointer is on. No DOM: tested in vitest (`tests/gizmo.test.ts`).
 *
 * Matrices are the engine's: [a, b, c, d, x, y], y up, (a, c) the x axis.
 */

export type Matrix = readonly [number, number, number, number, number, number];
export type Point = readonly [number, number];
export type Tool = "move" | "rotate" | "scale";

const DEG = 180 / Math.PI;

/** `n` to `places` decimals, never -0: what a drag writes into the file. */
export function tidy(n: number, places: number): number {
  const k = 10 ** places;
  const r = Math.round(n * k) / k;
  return r === 0 ? 0 : r;
}

/**
 * A drag's values, with each one that ends where the drag began put back as the file had it: its
 * value, or no key (undefined) when the file left it to the default. A drag along x then leaves
 * `scaleY` out of the file, and a drag out and back changes nothing.
 */
export function asWritten<P extends Record<string, number | undefined>>(
  patch: P, began: Readonly<Record<string, number>>, written: Readonly<Record<string, number | undefined>>,
): P {
  const out: Record<string, number | undefined> = { ...patch };
  for (const k of Object.keys(out)) if (out[k] === began[k]) out[k] = written[k];
  return out as P;
}

/** The world displacement (`dx`, `dy`) in the parent's space: what a bone's x and y add. */
export function moveDelta(parent: Matrix, dx: number, dy: number): Point {
  const [a, b, c, d] = parent;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [0, 0];
  return [(d * dx - b * dy) / det, (a * dy - c * dx) / det];
}

/** The angle from `p0` to `p1` around `o`, in degrees, the short way (-180, 180]. */
export function turn(o: Point, p0: Point, p1: Point): number {
  let r = (Math.atan2(p1[1] - o[1], p1[0] - o[0]) - Math.atan2(p0[1] - o[1], p0[0] - o[0])) * DEG;
  if (r > 180) r -= 360;
  else if (r <= -180) r += 360;
  return r;
}

/**
 * The local rotation that points a bone's x axis at the world angle `deg` (degrees), under a
 * parent it inherits from normally: the direction taken into the parent's space, less the bone's
 * x shear, a half turn more for a negative x scale. Exact under any parent, turned, scaled
 * unevenly or mirrored. Of its whole turns, the one nearest `near`.
 */
export function localRotation(parent: Matrix, deg: number, shearX: number, scaleX: number, near: number): number {
  const [a, b, c, d] = parent;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return near;
  const wx = Math.cos(deg / DEG), wy = Math.sin(deg / DEG);
  let r = Math.atan2((a * wy - c * wx) / det, (d * wx - b * wy) / det) * DEG - shearX + (scaleX < 0 ? 180 : 0);
  r += Math.round((near - r) / 360) * 360;
  return r;
}

/**
 * Which way a world turn moves the bone's local rotation, for the inherit modes `localRotation`
 * does not cover: against it when the parent it inherits a turn from is mirrored. The modes that
 * drop the parent's turn and mirror take the skeleton's alone.
 */
export function turnSign(parent: Matrix, inherit: string, skeletonFlip: boolean): number {
  if (inherit === "onlyTranslation" || inherit === "noRotationOrReflection") return skeletonFlip ? -1 : 1;
  const [a, b, c, d] = parent;
  return a * d - b * c < 0 ? -1 : 1;
}

/**
 * The scale factors a drag from `p0` to `p1` gives, about the bone's origin, along the bone's own
 * axes (`bone`, its world matrix when the drag began). `uniform` scales both by the change in
 * distance. An axis the drag started across (less than a fifth of the reach along it) keeps 1.
 */
export function scaleFactors(bone: Matrix, p0: Point, p1: Point, uniform: boolean): Point {
  const ox = bone[4], oy = bone[5];
  const v0: Point = [p0[0] - ox, p0[1] - oy], v1: Point = [p1[0] - ox, p1[1] - oy];
  const l0 = Math.hypot(v0[0], v0[1]);
  if (l0 < 1e-9) return [1, 1];
  if (uniform) { const f = Math.hypot(v1[0], v1[1]) / l0; return [f, f]; }
  const [a, b, c, d] = bone;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return [1, 1];
  const local = (v: Point): Point => [(d * v[0] - b * v[1]) / det, (a * v[1] - c * v[0]) / det];
  const u0 = local(v0), u1 = local(v1), reach = Math.hypot(u0[0], u0[1]);
  const fx = Math.abs(u0[0]) > reach * 0.2 ? u1[0] / u0[0] : 1;
  const fy = Math.abs(u0[1]) > reach * 0.2 ? u1[1] / u0[1] : 1;
  return [fx, fy];
}

/** A bone as the overlay draws it, in screen pixels: from its origin to its tip. */
export interface ScreenBone { readonly name: string; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** Distance from (`px`, `py`) to the segment. */
export function segmentDistance(s: ScreenBone, px: number, py: number): number {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - s.x0) * dx + (py - s.y0) * dy) / l2)) : 0;
  return Math.hypot(px - (s.x0 + t * dx), py - (s.y0 + t * dy));
}

/** The bone under the pointer within `radius` pixels: the nearest; on a tie the later one (drawn on top). */
export function pickBone(bones: readonly ScreenBone[], px: number, py: number, radius = 6): string | null {
  let best: string | null = null, bestD = radius;
  for (const b of bones) {
    const d = segmentDistance(b, px, py);
    if (d <= bestD) { best = b.name; bestD = d; }
  }
  return best;
}
