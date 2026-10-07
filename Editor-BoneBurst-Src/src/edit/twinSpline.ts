import type { MotionNode, MotionPath } from "@/model/sidecar";
import { curveOf, endFrame, type Pt } from "./motionPath";

/**
 * TwinSpline (docs/TWINSPLINE-PLAN.md): the motion path is a ring spline through its nodes, and each node carries a speed
 * value, so a second spline, the speed spline, runs through them over the path's length. The bone goes along the ring;
 * its speed at a place is `1 + the speed spline there`. The value is held between -0.99 and 5, so the multiplier is never 0.
 * Pure: the path in, numbers out.
 */

export const SPEED_MIN = -0.99;
export const SPEED_MAX = 5;

/** A speed value held to its range, to four places. */
export function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, v)) * 1e4) / 1e4;
}

/** A node's speed value (0 when it has none: an even pace). */
export const speedOf = (n: Pick<MotionNode, "speed">): number => clampSpeed(n.speed ?? 0);

/** The multiplier a speed value makes: 0.01 to 6. */
export const multiplierOf = (speed: number): number => 1 + clampSpeed(speed);

/** How far along the ring (0..1 of its length) each node sits; the first at 0. */
export function nodeProgress(m: Pick<MotionPath, "nodes" | "closed">): number[] {
  const c = curveOf(m);
  return m.nodes.map((_, i) => (c.length > 0 ? (c.nodeAt[i] ?? 0) / c.length : i / Math.max(1, m.nodes.length - 1)));
}

/**
 * The speed spline: a smooth curve through the nodes' speed values over progress 0..1 (a cubic Hermite through them, each
 * tangent taken from the neighbours; a ring runs round, so its end meets its start), held to the range everywhere.
 */
export function speedAt(m: Pick<MotionPath, "nodes" | "closed">, p: number): number {
  const n = m.nodes.length;
  if (n === 0) return 0;
  const xs = nodeProgress(m), vs = m.nodes.map(speedOf);
  if (n === 1) return vs[0]!;
  const x = Math.min(1, Math.max(0, p));
  // The points the curve runs through: on a ring, the first again at 1, and a neighbour a lap away at each end for the tangents.
  const px = m.closed ? [...xs, 1] : xs, pv = m.closed ? [...vs, vs[0]!] : vs, last = px.length - 1;
  const before = (i: number): [number, number] => (i > 0 ? [px[i - 1]!, pv[i - 1]!] : m.closed ? [xs[n - 1]! - 1, vs[n - 1]!] : [px[0]!, pv[0]!]);
  const after = (i: number): [number, number] => (i < last ? [px[i + 1]!, pv[i + 1]!] : m.closed ? [1 + xs[1 % n]!, vs[1 % n]!] : [px[last]!, pv[last]!]);
  const tangent = (i: number): number => {
    const [x0, v0] = before(i), [x1, v1] = after(i), dx = x1 - x0;
    return dx > 1e-9 ? (v1 - v0) / dx : 0;
  };
  let i = 0;
  while (i < last - 1 && x > px[i + 1]!) i++;
  const x0 = px[i]!, x1 = px[i + 1]!, h = x1 - x0;
  if (h <= 1e-9) return clampSpeed(pv[i]!);
  const t = (x - x0) / h, t2 = t * t, t3 = t2 * t;
  const v = (2 * t3 - 3 * t2 + 1) * pv[i]! + (t3 - 2 * t2 + t) * h * tangent(i) + (-2 * t3 + 3 * t2) * pv[i + 1]! + (t3 - t2) * h * tangent(i + 1);
  return clampSpeed(v);
}

/** Samples of the time table: the cumulative time to each of them. */
const TABLE = 512;

/** From the path's progress to time and back: time to reach a place is the sum of `dp / (1 + speed)`, as a share of the whole. */
export interface TimeMap {
  /** Progress 0..1 at time share `tau` (0..1). */
  progress(tau: number): number;
  /** Time share 0..1 at progress `p`. */
  time(p: number): number;
}

const maps = new WeakMap<object, TimeMap>();

function build(m: Pick<MotionPath, "nodes" | "closed">): TimeMap {
  const cum = new Float64Array(TABLE + 1);
  let prev = 1 / multiplierOf(speedAt(m, 0));
  for (let k = 1; k <= TABLE; k++) {
    const cur = 1 / multiplierOf(speedAt(m, k / TABLE));
    cum[k] = cum[k - 1]! + ((prev + cur) / 2) / TABLE;
    prev = cur;
  }
  const total = cum[TABLE]! || 1;
  for (let k = 0; k <= TABLE; k++) cum[k] = cum[k]! / total;
  return {
    time(p) {
      const x = Math.min(1, Math.max(0, p)) * TABLE, k = Math.min(TABLE - 1, Math.floor(x));
      return cum[k]! + (cum[k + 1]! - cum[k]!) * (x - k);
    },
    progress(tau) {
      const t = Math.min(1, Math.max(0, tau));
      let lo = 0, hi = TABLE;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid]! <= t) lo = mid; else hi = mid; }
      const span = cum[hi]! - cum[lo]!;
      return (lo + (span > 0 ? (t - cum[lo]!) / span : 0)) / TABLE;
    },
  };
}

/** The time map of a path (kept for as long as the path object is: a changed path is a new object). */
export function timeMap(m: Pick<MotionPath, "nodes" | "closed">): TimeMap {
  let t = maps.get(m);
  if (!t) { t = build(m); maps.set(m, t); }
  return t;
}

/** The progress (0..1 of the ring's length) at a frame: even when no node has a speed; the run takes `endFrame` frames whatever the speeds. */
export function progressAtFrame(m: MotionPath, frame: number): number {
  const end = Math.max(1, endFrame(m));
  return timeMap(m).progress(Math.min(end, Math.max(0, frame)) / end);
}

/** The path's point at a frame. */
export function placeAtFrame(m: MotionPath, frame: number): Pt {
  const c = curveOf(m);
  return c.at(progressAtFrame(m, frame) * c.length);
}

/** The frame (a fraction of one) each node is reached on, and the last on `endFrame`; a ring's last entry is the way back to the first. */
export function arrivalFrames(m: MotionPath): number[] {
  const end = endFrame(m), t = timeMap(m), xs = nodeProgress(m);
  return [...xs, ...(m.closed ? [1] : [])].map((p) => t.time(p) * end);
}
