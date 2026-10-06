/**
 * The transform tools' maths: a pointer drag in the world turned into a bone's new local setup
 * values, and which bone the pointer is on. No DOM: tested in vitest (`tests/gizmo.test.ts`).
 *
 * Matrices are the engine's: [a, b, c, d, x, y], y up, (a, c) the x axis.
 */

export type Matrix = readonly [number, number, number, number, number, number];
export type Point = readonly [number, number];
export type Tool = "move" | "rotate" | "scale" | "shear";

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

/** The space the Move tool works in: the bone's own axes, its parent's, or the world's. */
export type Space = "local" | "parent" | "world";

function unit(x: number, y: number): Point {
  const n = Math.hypot(x, y);
  return n === 0 ? [1, 0] : [x / n, y / n];
}

/** A space's two axes as world unit vectors: the bone's x and y, the parent's, or the world's. */
export function spaceAxes(space: Space, bone: Matrix, parent: Matrix): readonly [Point, Point] {
  if (space === "world") return [[1, 0], [0, 1]];
  const m = space === "local" ? bone : parent;
  return [unit(m[0], m[2]), unit(m[1], m[3])];
}

/**
 * A move held to one axis: once the pointer has gone `threshold` from where it began, the axis it
 * went nearer to is chosen (`lock`, kept for the rest of the drag), and the displacement is its
 * part along that axis. Until then nothing moves.
 */
export function lockToAxis(delta: Point, axes: readonly [Point, Point], lock: 0 | 1 | null, threshold: number): { delta: Point; lock: 0 | 1 | null } {
  const along = (a: Point) => delta[0] * a[0] + delta[1] * a[1];
  let chosen = lock;
  if (chosen === null) {
    if (Math.hypot(delta[0], delta[1]) < threshold) return { delta: [0, 0], lock: null };
    chosen = Math.abs(along(axes[0])) >= Math.abs(along(axes[1])) ? 0 : 1;
  }
  const a = axes[chosen], t = along(a);
  // `+ 0` turns a negative zero into 0.
  return { delta: [a[0] * t + 0, a[1] * t + 0], lock: chosen };
}

/** The bone axis (0: x, 1: y) a space's axis `k` stands for: itself in the bone's space, else the bone axis most nearly along it. */
function boneAxisFor(space: Space, k: 0 | 1, bone: Matrix, parent: Matrix): 0 | 1 {
  if (space === "local") return k;
  const own = spaceAxes("local", bone, parent), w = spaceAxes(space, bone, parent)[k];
  return Math.abs(w[0] * own[0][0] + w[1] * own[0][1]) >= Math.abs(w[0] * own[1][0] + w[1] * own[1][1]) ? 0 : 1;
}

/**
 * A scale held to one of the bone's axes (Scale in the Local or World space): the drag picks the
 * nearer axis of `space` as `lockToAxis` does; in the world's space that is the bone axis most
 * nearly along it. The factor is how far the pointer went along that bone axis from the origin;
 * the other axis stays 1. Nothing scales until the axis is chosen, or when the press began within
 * `minStart` of the origin (along that axis).
 */
export function scaleAlong(space: Space, bone: Matrix, parent: Matrix, p0: Point, p1: Point, lock: 0 | 1 | null, threshold: number, minStart = 1e-9): { factors: Point; lock: 0 | 1 | null } {
  const held = lockToAxis([p1[0] - p0[0], p1[1] - p0[1]], spaceAxes(space, bone, parent), lock, threshold);
  if (held.lock === null) return { factors: [1, 1], lock: null };
  const j = boneAxisFor(space, held.lock, bone, parent), u = spaceAxes("local", bone, parent)[j], o: Point = [bone[4], bone[5]];
  const a = (p0[0] - o[0]) * u[0] + (p0[1] - o[1]) * u[1], b = (p1[0] - o[0]) * u[0] + (p1[1] - o[1]) * u[1];
  const f = Math.abs(a) < minStart ? 1 : b / a;
  return { factors: j === 0 ? [f, 1] : [1, f], lock: held.lock };
}

/**
 * A shear held to one bone axis (Shear in the Local or World space): the drag picks the nearer
 * axis of `space` as `lockToAxis` does, and only that axis shears, by `shearDelta`'s amount. A
 * drag along the bone's x shears shearX, along its y shears shearY.
 */
export function shearAlong(space: Space, bone: Matrix, parent: Matrix, p0: Point, p1: Point, lock: 0 | 1 | null, threshold: number): { delta: Point; lock: 0 | 1 | null } {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const held = lockToAxis([dx, dy], spaceAxes(space, bone, parent), lock, threshold);
  if (held.lock === null) return { delta: [0, 0], lock: null };
  const [lx, ly] = shearDelta((Math.atan2(bone[2], bone[0]) * 180) / Math.PI, dx, dy, false);
  return { delta: boneAxisFor(space, held.lock, bone, parent) === 0 ? [lx, 0] : [0, ly], lock: held.lock };
}

/** Degrees of shear for each world unit the pointer moves along the bone's own axes. */
const SHEAR_PER_UNIT = 0.5;

/**
 * The shear a drag adds: the world displacement (`dx`, `dy`) taken along the bone's axes (its
 * world rotation `deg`), so a drag along the bone's x shears x and along its y shears y. `lock`
 * keeps only the larger of the two.
 */
export function shearDelta(deg: number, dx: number, dy: number, lock: boolean): Point {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  let lx = (dx * c + dy * s) * SHEAR_PER_UNIT, ly = (-dx * s + dy * c) * SHEAR_PER_UNIT;
  if (lock) { if (Math.abs(lx) >= Math.abs(ly)) ly = 0; else lx = 0; }
  return [lx, ly];
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
export function scaleFactors(bone: Matrix, p0: Point, p1: Point, uniform: boolean, minStart = 1e-9): Point {
  const ox = bone[4], oy = bone[5];
  const v0: Point = [p0[0] - ox, p0[1] - oy], v1: Point = [p1[0] - ox, p1[1] - oy];
  const l0 = Math.hypot(v0[0], v0[1]);
  // A press this close to the origin would make the ratio jump: nothing scales.
  if (l0 < minStart) return [1, 1];
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

/**
 * The bone under the pointer within `radius` pixels: the selected one if it is in reach. Else a
 * bone's origin wins over another bone's segment (an IK target sits on the tip of the bone it
 * pulls); then the nearest; on a tie the later one (drawn on top).
 */
export function pickBone(bones: readonly ScreenBone[], px: number, py: number, radius = 6, selected: string | null = null): string | null {
  // The selected bone in reach stays picked: bones often share an origin (hips and pelvis).
  const sel = bones.find((b) => b.name === selected);
  if (sel && Math.min(Math.hypot(px - sel.x0, py - sel.y0), segmentDistance(sel, px, py)) <= radius) return sel.name;
  const nearest = (d: (b: ScreenBone) => number) => {
    let best: string | null = null, bestD = radius;
    for (const b of bones) { const x = d(b); if (x <= bestD) { best = b.name; bestD = x; } }
    return best;
  };
  return nearest((b) => Math.hypot(px - b.x0, py - b.y0)) ?? nearest((b) => segmentDistance(b, px, py));
}
