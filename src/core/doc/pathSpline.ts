import { CURVE_Y_LIMIT, type EaseSpec, easeOf, easeSegments, type TweenSpec } from "@/core/math/easing";
import type { Keyframe, Node, Track } from "./types";
import { insertKeyframe, keyIndexAt } from "./timeline";

/**
 * Spline handles on a bone's path (docs/CYCLE-PATH-PLAN.md, B5 ▸ Spline
 * handles). The interval between two keys that move a bone is a cubic Bezier
 * P0 P1 P2 P3 in the parent's space when its x and y eases are each one cubic
 * with the same control times: per axis, value = P0 + (P3 − P0)·ease, and an
 * ease's control y is where that axis's handle sits as a fraction of the
 * axis's travel. So a handle is written as two custom eases, with no extra
 * keys, and the export carries it as Spine's own curves. The shared control
 * times only change the speed along the curve, never its shape, and are kept.
 */

export interface Pt { x: number; y: number }

export interface Spline {
  p0: Pt; p1: Pt; p2: Pt; p3: Pt;
  /** The control times both axes share. */
  cx: [number, number];
}

/** One cubic in the interval's 0..1 space, or null when the ease is not one. */
function cubicOf(spec: TweenSpec): { c1x: number; c1y: number; c2x: number; c2y: number } | null {
  if (spec.kind === "linear") return { c1x: 1 / 3, c1y: 1 / 3, c2x: 2 / 3, c2y: 2 / 3 };
  const segs = easeSegments(spec);
  return segs && segs.length === 1 ? segs[0]! : null;
}

/**
 * The spline the interval from `a` to `b` draws, in the parent's space, or
 * null when it is not one: a hold, a preset ease, several segments, or x and
 * y timed by different control times.
 */
export function easesToSpline(a: Keyframe, b: Keyframe): Spline | null {
  if (a.tween.kind === "none") return null;
  const ex = cubicOf(easeOf(a, "x")), ey = cubicOf(easeOf(a, "y"));
  if (!ex || !ey) return null;
  if (Math.abs(ex.c1x - ey.c1x) > 1e-9 || Math.abs(ex.c2x - ey.c2x) > 1e-9) return null;
  const p0 = { x: a.transform.x, y: a.transform.y };
  const p3 = { x: b.transform.x, y: b.transform.y };
  const at = (u: number, v: number): Pt => ({ x: p0.x + (p3.x - p0.x) * u, y: p0.y + (p3.y - p0.y) * v });
  return { p0, p1: at(ex.c1y, ey.c1y), p2: at(ex.c2y, ey.c2y), p3, cx: [ex.c1x, ex.c2x] };
}

/**
 * The handles a straight interval starts with: at a third and two thirds of
 * the chord, which is the same motion as linear.
 */
export function straightSpline(a: Keyframe, b: Keyframe): Spline {
  const p0 = { x: a.transform.x, y: a.transform.y };
  const p3 = { x: b.transform.x, y: b.transform.y };
  const at = (u: number): Pt => ({ x: p0.x + (p3.x - p0.x) * u, y: p0.y + (p3.y - p0.y) * u });
  return { p0, p1: at(1 / 3), p2: at(2 / 3), p3, cx: [1 / 3, 2 / 3] };
}

export type SplineEases =
  | { x: EaseSpec; y: EaseSpec; clamped: boolean }
  /** An axis that does not travel cannot bend: the interval needs a key in
   *  its middle first (`splitSpline`). */
  | { split: true };

const TINY = 1e-9;

/**
 * The x and y eases that make an interval draw `s`. A handle so far out that
 * its control y passes ±`CURVE_Y_LIMIT` (the range a document keeps) is
 * pulled in, and `clamped` says so.
 */
export function splineToEases(s: Spline): SplineEases {
  let clamped = false;
  const axis = (k: "x" | "y"): EaseSpec | null => {
    const travel = s.p3[k] - s.p0[k];
    const u1 = s.p1[k] - s.p0[k], u2 = s.p2[k] - s.p0[k];
    if (Math.abs(travel) < TINY) {
      if (Math.abs(u1) > TINY || Math.abs(u2) > TINY) return null;
      return { kind: "curve", curve: [s.cx[0], s.cx[0], s.cx[1], s.cx[1]] };
    }
    const lim = (v: number) => {
      const c = Math.max(-CURVE_Y_LIMIT, Math.min(CURVE_Y_LIMIT, v));
      if (c !== v) clamped = true;
      return c;
    };
    return { kind: "curve", curve: [s.cx[0], lim(u1 / travel), s.cx[1], lim(u2 / travel)] };
  };
  const x = axis("x"), y = axis("y");
  return x && y ? { x, y, clamped } : { split: true };
}

/** de Casteljau: the two halves of `s` at parameter `t`. Their control
 *  times start again at a third and two thirds. */
export function splitSpline(s: Spline, t: number): [Spline, Spline] {
  const mix = (a: Pt, b: Pt): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const a = mix(s.p0, s.p1), b = mix(s.p1, s.p2), c = mix(s.p2, s.p3);
  const d = mix(a, b), e = mix(b, c);
  const m = mix(d, e);
  const cx: [number, number] = [1 / 3, 2 / 3];
  return [{ p0: s.p0, p1: a, p2: d, p3: m, cx }, { p0: m, p1: e, p2: c, p3: s.p3, cx }];
}

/** The point of `s` at parameter `t`. */
export function splineAt(s: Spline, t: number): Pt {
  const l = 1 - t;
  const w = [l * l * l, 3 * l * l * t, 3 * l * t * t, t * t * t] as const;
  return {
    x: w[0] * s.p0.x + w[1] * s.p1.x + w[2] * s.p2.x + w[3] * s.p3.x,
    y: w[0] * s.p0.y + w[1] * s.p1.y + w[2] * s.p2.y + w[3] * s.p3.y,
  };
}

function withEases(k: Keyframe, x: EaseSpec, y: EaseSpec): Keyframe {
  // A hold has no motion to bend; a bent interval tweens.
  const tween = k.tween.kind === "none" ? { kind: "linear" as const } : k.tween;
  return { ...k, tween, eases: { ...k.eases, x, y } };
}

export type SplineEdit =
  | { track: Track; clamped: boolean; split: number | null }
  /** The interval is a frame long: no room for the key a split needs. */
  | { refused: string };

/**
 * `track` with the interval leaving the key at `from` drawing `s`. When an
 * axis that does not travel has to bend, a key is cut at the interval's
 * middle frame, on the spline, and each half gets its own eases (`split`
 * is that frame). The key is not tied to the spline afterwards: the caller
 * removes it again if it turns out to change nothing.
 */
export function withSpline(track: Track, node: Node, from: number, s: Spline): SplineEdit {
  const i = keyIndexAt(track, from);
  const a = track.keys[i], b = track.keys[i + 1];
  if (!a || !b) return { refused: "There is no key after this one to bend toward." };
  const eases = splineToEases(s);
  if (!("split" in eases)) {
    return { track: { ...track, keys: track.keys.map((k, j) => (j === i ? withEases(k, eases.x, eases.y) : k)) }, clamped: eases.clamped, split: null };
  }
  const span = b.frame - a.frame;
  if (span < 2) return { refused: "The interval is one frame long: there is no frame in it for the key a bend needs." };
  const mid = a.frame + Math.floor(span / 2);
  const t = (mid - a.frame) / span;
  const [h1, h2] = splitSpline({ ...s, cx: [1 / 3, 2 / 3] }, t);
  const e1 = splineToEases(h1), e2 = splineToEases(h2);
  if ("split" in e1 || "split" in e2) return { refused: "This bend would need more than one new key." };
  // F6's key (what the stage shows there, every other channel included),
  // then x and y on the spline.
  const cut = insertKeyframe(track, mid, node);
  if (!cut) return { refused: "This bend would need a key where there already is one." };
  const m = h1.p3;
  const keys = cut.keys.map((k) => {
    if (k.frame === a.frame) return withEases(k, e1.x, e1.y);
    if (k.frame === mid) return withEases({ ...k, transform: { ...k.transform, x: m.x, y: m.y } }, e2.x, e2.y);
    return k;
  });
  return { track: { ...cut, keys }, clamped: e1.clamped || e2.clamped, split: mid };
}

/** An interval of a track that can show handles, and the spline it draws.
 *  `exact` is false when the ease is not a spline (a preset, several
 *  segments, axes timed apart): the handles then start straight, and the
 *  first drag replaces the ease. */
export interface SplineSegment { from: number; to: number; spline: Spline; exact: boolean }

/** Every interval of `track` that tweens. A hold jumps, so it has none. */
export function splineSegments(track: Track | undefined): SplineSegment[] {
  if (!track) return [];
  const out: SplineSegment[] = [];
  for (let i = 0; i + 1 < track.keys.length; i++) {
    const a = track.keys[i]!, b = track.keys[i + 1]!;
    if (a.tween.kind === "none") continue;
    const s = easesToSpline(a, b);
    out.push({ from: a.frame, to: b.frame, spline: s ?? straightSpline(a, b), exact: !!s });
  }
  return out;
}

/** A handle as the stage draws it, in the symbol's space: the out handle of
 *  the interval leaving `from` (P1) or its in handle (P2), and the dot it
 *  hangs from. */
export interface PathHandle {
  from: number;
  /** The key the interval runs to. */
  to: number;
  end: "out" | "in";
  x: number; y: number;
  anchorX: number; anchorY: number;
  /** On a bone that turns: the curve its tip draws over the interval, in the
   *  symbol's space, fitted to the arc. Dragging bakes it (`bakePlan`). */
  bake?: Spline;
}

/**
 * The handle under (x, y) within `radius`. Handles pile up where a loop
 * comes back to where it started: the interval the playhead (`current`) is in
 * wins, then the nearest, then the first listed.
 */
export function handleAt(
  handles: readonly PathHandle[], x: number, y: number, radius: number, current?: number,
): PathHandle | null {
  let best: PathHandle | null = null;
  let bestRank: [number, number] | null = null;
  for (const h of handles) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d > radius) continue;
    const inside = current !== undefined && current >= h.from && current <= h.to ? 0 : 1;
    if (!bestRank || inside < bestRank[0] || (inside === bestRank[0] && d < bestRank[1])) {
      bestRank = [inside, d];
      best = h;
    }
  }
  return best;
}

/**
 * The cubic from `p0` to `p3` closest to `samples` (least squares, each
 * sample at its own parameter `t`): the handles that match a path already
 * drawn, such as the arc a turning bone's tip makes. With too few samples to
 * pin two handles, the straight ones.
 */
export function fitCubic(p0: Pt, p3: Pt, samples: ReadonlyArray<{ t: number; p: Pt }>): Spline {
  let a11 = 0, a12 = 0, a22 = 0;
  const r1 = { x: 0, y: 0 }, r2 = { x: 0, y: 0 };
  for (const { t, p } of samples) {
    const l = 1 - t;
    const b1 = 3 * l * l * t, b2 = 3 * l * t * t, b0 = l * l * l, b3 = t * t * t;
    const rx = p.x - b0 * p0.x - b3 * p3.x, ry = p.y - b0 * p0.y - b3 * p3.y;
    a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2;
    r1.x += b1 * rx; r1.y += b1 * ry; r2.x += b2 * rx; r2.y += b2 * ry;
  }
  const det = a11 * a22 - a12 * a12;
  const cx: [number, number] = [1 / 3, 2 / 3];
  if (samples.length < 2 || Math.abs(det) < 1e-12) {
    const at = (u: number): Pt => ({ x: p0.x + (p3.x - p0.x) * u, y: p0.y + (p3.y - p0.y) * u });
    return { p0, p1: at(1 / 3), p2: at(2 / 3), p3, cx };
  }
  return {
    p0, p3, cx,
    p1: { x: (a22 * r1.x - a12 * r2.x) / det, y: (a22 * r1.y - a12 * r2.y) / det },
    p2: { x: (a11 * r2.x - a12 * r1.x) / det, y: (a11 * r2.y - a12 * r1.y) / det },
  };
}
