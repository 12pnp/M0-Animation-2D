/**
 * Spine's curve between two keys. Spine carries one cubic bezier per key
 * interval and does not evaluate it exactly: `CurveTimeline.setBezier`
 * samples it at parameter 0.1 … 0.9 and `getBezierValue` reads the
 * 10-segment polyline through those points and the two keys, by time.
 * `boneburstPolyline` / `readPolyline` are that, and `tests/easing.test.ts`
 * checks them against spine-core itself.
 */

/** One cubic bezier from (x0,y0) to (x1,y1), in the interval's 0..1 space:
 *  x is progress through the interval, y through the change. */
export interface EaseSegment {
  x0: number; y0: number;
  c1x: number; c1y: number; c2x: number; c2y: number;
  x1: number; y1: number;
}

/**
 * The polyline `CurveTimeline.setBezier` builds for a segment: its two ends
 * and the curve at parameter 0.1 … 0.9, as [x0,y0, x1,y1, …] (11 points).
 * The runtime gets the inner points by forward differencing; evaluating
 * the cubic directly gives the same points to rounding.
 */
export function boneburstPolyline(s: EaseSegment): Float64Array {
  const out = new Float64Array(22);
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, l = 1 - t;
    const a = l * l * l, b = 3 * l * l * t, c = 3 * l * t * t, d = t * t * t;
    out[i * 2] = i === 0 ? s.x0 : i === 10 ? s.x1 : a * s.x0 + b * s.c1x + c * s.c2x + d * s.x1;
    out[i * 2 + 1] = i === 0 ? s.y0 : i === 10 ? s.y1 : a * s.y0 + b * s.c1y + c * s.c2y + d * s.y1;
  }
  return out;
}

/** `getBezierValue`: the first point past `x`, read linearly from the one
 *  before it. */
export function readPolyline(pts: Float64Array, x: number): number {
  for (let i = 2; i < pts.length; i += 2) {
    if (pts[i]! >= x || i === pts.length - 2) {
      const x0 = pts[i - 2]!, y0 = pts[i - 1]!, x1 = pts[i]!, y1 = pts[i + 1]!;
      return x1 === x0 ? y1 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1]!;
}
