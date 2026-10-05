import type { Curve } from "@/model/skeleton";
import { shortFloat } from "@/model/timelines";

/**
 * A bezier's handles are absolute times and values (Format-Json-Atlas.md §12.1), so they follow
 * the interval's ends by hand: when an end moves, each handle keeps its place relative to the
 * ends — proportionally in time and in each channel's value. A channel that was flat keeps its
 * handles' offsets from the start.
 */

/** One interval's ends: times, and each channel's value at either end. */
export interface Segment {
  readonly t0: number;
  readonly t1: number;
  readonly v0: readonly number[];
  readonly v1: readonly number[];
}

export function sameSegment(a: Segment, b: Segment): boolean {
  return a.t0 === b.t0 && a.t1 === b.t1 && a.v0.every((v, i) => v === b.v0[i]) && a.v1.every((v, i) => v === b.v1[i]);
}

/** The curve with its handles moved from `from`'s ends to `to`'s. Linear, stepped and malformed
 *  curves are returned as they are. */
export function remapCurve(curve: Curve | undefined, from: Segment, to: Segment): Curve | undefined {
  if (!Array.isArray(curve) || curve.length !== from.v0.length * 4 || sameSegment(from, to)) return curve;
  const time = (x: number) => from.t1 === from.t0 ? to.t0 + (x - from.t0) : to.t0 + ((x - from.t0) * (to.t1 - to.t0)) / (from.t1 - from.t0);
  const value = (c: number, y: number) => {
    const dv = from.v1[c]! - from.v0[c]!;
    return dv === 0 ? to.v0[c]! + (y - from.v0[c]!) : to.v0[c]! + ((y - from.v0[c]!) * (to.v1[c]! - to.v0[c]!)) / dv;
  };
  return curve.map((n, i) => shortFloat(i % 2 === 0 ? time(n) : value(i >> 2, n)));
}

/** A normalised cubic: handles (x1, y1) and (x2, y2) between (0, 0) and (1, 1). */
export type Shape = readonly [number, number, number, number];

export const PRESETS = {
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
} as const satisfies Record<string, Shape>;

/** The bezier array for `shape` on every channel of the segment. */
export function shapeCurve(shape: Shape, s: Segment): number[] {
  const out: number[] = [];
  const t = (x: number) => shortFloat(s.t0 + x * (s.t1 - s.t0));
  s.v0.forEach((v0, c) => {
    const v = (y: number) => shortFloat(v0 + y * (s.v1[c]! - v0));
    out.push(t(shape[0]), v(shape[1]), t(shape[2]), v(shape[3]));
  });
  return out;
}
