/**
 * Tween easing, evaluated the way the Spine 4.3 runtime plays it.
 *
 * The stage must show what the runtime shows at every whole frame, so this
 * file reproduces the runtime rather than the ideal curve. Spine carries
 * one cubic bezier per key interval and does not evaluate it exactly:
 * `CurveTimeline.setBezier` samples it at parameter 0.1 … 0.9 and
 * `getBezierValue` reads the 10-segment polyline through those points and
 * the two keys, by time. `boneburstPolyline` / `readPolyline` (in the
 * runtime's `bezier.ts`) are that, and
 * `tests/easing.test.ts` checks them against spine-core itself.
 *
 * What each ease is, in Spine:
 *   linear            no curve
 *   ease (quad in/out, in-out)  ONE cubic, exactly: p + e·(g(p) − p) with
 *                     g = p², 2p − p² or the smoothstep 3p² − 2p³
 *   curve (custom)    its own cubic segments, one key per anchor
 *   preset (sine, back, bounce …)  no cubic holds them: the exact function
 *                     at every whole frame, a key per frame in the file,
 *                     straight between them
 */

import { curveValueAt } from "./easeCurve";
import { boneburstPolyline, type EaseSegment, readPolyline } from "@/core/boneburst/runtime/bezier";

export type EaseFamily = "pow" | "sine" | "circ" | "expo" | "back" | "elastic" | "bounce";
export type EaseDir = "in" | "out" | "inOut";

export type TweenSpec =
  | { kind: "none" }                                  // hold / stepped
  | { kind: "linear" }                                // tweenEasing: 0
  | { kind: "ease"; value: number }                   // tweenEasing in [-2, 2] \ {0}
  /** Cubic bezier with implicit (0,0) and (1,1):
   *  `[c1x,c1y, c2x,c2y, (ax,ay, c1x,c1y, c2x,c2y)*]`, 4 + 6k numbers. */
  | { kind: "curve"; curve: readonly number[] }
  | { kind: "preset"; family: EaseFamily; dir: EaseDir; amount?: number };

/** An ease that tweens — what a per-property override may hold. */
export type EaseSpec = Exclude<TweenSpec, { kind: "none" }>;

export const TWEEN_NONE: TweenSpec = { kind: "none" };
export const TWEEN_LINEAR: TweenSpec = { kind: "linear" };
export const DEFAULT_CUSTOM_CURVE: readonly number[] = [0.42, 0, 0.58, 1];

/* ── Preset families ──────────────────────────────────────────────────────*/

export interface EaseAmount {
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
}

export const EASE_FAMILIES: ReadonlyArray<{ id: EaseFamily; label: string; amount?: EaseAmount }> = [
  { id: "pow", label: "Power", amount: { label: "Power", min: 1.2, max: 8, default: 2, step: 0.1 } },
  { id: "sine", label: "Sine" },
  { id: "circ", label: "Circular" },
  { id: "expo", label: "Exponential" },
  { id: "back", label: "Back", amount: { label: "Overshoot", min: 0, max: 4, default: 1.70158, step: 0.1 } },
  { id: "elastic", label: "Elastic", amount: { label: "Oscillations", min: 1, max: 10, default: 3, step: 0.5 } },
  { id: "bounce", label: "Bounce", amount: { label: "Bounciness", min: 0.05, max: 0.7, default: 0.25, step: 0.05 } },
];

export function familyInfo(family: EaseFamily) {
  return EASE_FAMILIES.find((f) => f.id === family)!;
}

export function presetAmount(spec: { family: EaseFamily; amount?: number }): number {
  const a = familyInfo(spec.family).amount;
  if (!a) return 0;
  const v = spec.amount ?? a.default;
  return Math.min(a.max, Math.max(a.min, v));
}

/** Height of a ball above the floor, dropped from 1 with `r` of each
 *  bounce's height kept, over three bounces. r = 0.25 is Penner's bounce. */
function bounceOut(p: number, r: number): number {
  const v = Math.sqrt(r);
  const widths = [1, 2 * v, 2 * v * v, 2 * v * v * v];
  const total = widths.reduce((s, w) => s + w, 0);
  let t = p * total;
  if (t <= 1) return t * t;
  t -= 1;
  for (let k = 1; k < widths.length; k++) {
    const w = widths[k]!;
    if (t <= w || k === widths.length - 1) {
      const u = (t - w / 2) / (w / 2);
      return 1 - Math.pow(r, k) * (1 - u * u);
    }
    t -= w;
  }
  return 1;
}

/** The ideal ease-in shape of a family, 0 → 1. */
function easeIn(family: EaseFamily, amount: number, p: number): number {
  switch (family) {
    case "pow":     return Math.pow(p, amount);
    case "sine":    return 1 - Math.cos((p * Math.PI) / 2);
    case "circ":    return 1 - Math.sqrt(Math.max(0, 1 - p * p));
    case "expo": {
      const lo = Math.pow(2, -10);
      return (Math.pow(2, 10 * (p - 1)) - lo) / (1 - lo);
    }
    case "back":    return p * p * ((amount + 1) * p - amount);
    case "elastic": {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      const period = 1 / amount;
      const q = p - 1;
      return -Math.pow(2, 10 * q) * Math.sin(((q - period / 4) * 2 * Math.PI) / period);
    }
    case "bounce":  return 1 - bounceOut(1 - p, amount);
  }
}

/** The ideal curve of a preset, before the runtime samples it. */
export function easeFunction(spec: { family: EaseFamily; dir: EaseDir; amount?: number }): (p: number) => number {
  const amount = presetAmount(spec);
  const fin = (p: number) => easeIn(spec.family, amount, p);
  switch (spec.dir) {
    case "in":    return fin;
    case "out":   return (p) => 1 - fin(1 - p);
    case "inOut": return (p) => (p < 0.5 ? fin(2 * p) / 2 : 1 - fin(2 - 2 * p) / 2);
  }
}

/* ── Bezier segments ──────────────────────────────────────────────────────*/

/**
 * How far a custom curve's y may go. Spine has no limit (floats); this is
 * the range the document has always kept, from the DragonBones Int16 table.
 */
export const CURVE_Y_LIMIT = 3.2767;


/**
 * The cubic segments an ease is made of, or null for linear, a hold and the
 * presets. The quad eases are polynomials in p with x = p, so their controls
 * sit at x = 1/3 and 2/3 and y from the end slopes: y1 = y'(0)/3,
 * y2 = 1 − y'(1)/3.
 */
export function easeSegments(spec: TweenSpec): EaseSegment[] | null {
  const seg = (y1: number, y2: number): EaseSegment[] =>
    [{ x0: 0, y0: 0, c1x: 1 / 3, c1y: y1, c2x: 2 / 3, c2y: y2, x1: 1, y1: 1 }];
  switch (spec.kind) {
    case "none":
    case "linear":
    case "preset":
      return null;
    case "ease": {
      const v = spec.value;
      if (v < 0) { const e = -v; return seg((1 - e) / 3, (2 - e) / 3); }       // in:  p + e(p² − p)
      if (v <= 1) return seg((1 + v) / 3, (2 + v) / 3);                          // out: p + e(p − p²)
      const e = v - 1;                                                           // in-out: smoothstep
      return seg((1 - e) / 3, (2 + e) / 3);
    }
    case "curve": {
      const c = spec.curve;
      const out: EaseSegment[] = [];
      let x0 = 0, y0 = 0;
      for (let i = 0; i + 3 < c.length; i += 6) {
        const last = i + 4 >= c.length;
        const x1 = last ? 1 : c[i + 4]!, y1 = last ? 1 : c[i + 5]!;
        out.push({ x0, y0, c1x: c[i]!, c1y: c[i + 1]!, c2x: c[i + 2]!, c2y: c[i + 3]!, x1, y1 });
        x0 = x1; y0 = y1;
      }
      return out;
    }
  }
}

/* ── Evaluation ───────────────────────────────────────────────────────────
   Playback samples every tweened node on every frame, so each spec's
   polylines are built once (specs are replaced, never mutated).           */

const polyCache = new WeakMap<object, Array<{ x0: number; x1: number; pts: Float64Array }>>();

function polylinesOf(spec: Extract<TweenSpec, { kind: "ease" | "curve" }>) {
  let polys = polyCache.get(spec);
  if (!polys) {
    polys = easeSegments(spec)!.map((s) => ({ x0: s.x0, x1: s.x1, pts: boneburstPolyline(s) }));
    polyCache.set(spec, polys);
  }
  return polys;
}

/**
 * Map a linear 0..1 progress across a span of `frameCount` frames through a
 * tween spec, the way the Spine runtime plays the export: the bezier's
 * polyline for the eases Spine carries, and for a preset the exact ease at
 * the whole frames either side, straight between (one key per frame in the
 * file). `none` holds at the start value. At a whole frame this is what the
 * stage shows.
 */
export function applyTween(spec: TweenSpec, progress: number, frameCount: number): number {
  switch (spec.kind) {
    case "none":   return 0;
    case "linear": return progress;
    case "preset": {
      if (progress <= 0) return 0;
      if (progress >= 1) return 1;
      const f = easeFunction(spec);
      const at = progress * frameCount, k = Math.floor(at + 1e-9);
      const a = f(k / frameCount);
      return at - k < 1e-9 ? a : a + (f((k + 1) / frameCount) - a) * (at - k);
    }
    case "ease":
    case "curve": {
      if (progress <= 0) return 0;
      if (progress >= 1) return 1;
      const polys = polylinesOf(spec);
      const seg = polys.find((s) => progress <= s.x1) ?? polys[polys.length - 1]!;
      return readPolyline(seg.pts, progress);
    }
  }
}

/** The curve as authored, drawn dashed behind what the runtime plays. The
 *  quad eases have x = p, so they are their polynomials. */
export function idealEase(spec: TweenSpec, p: number): number {
  switch (spec.kind) {
    case "none":   return 0;
    case "linear": return p;
    case "preset": return easeFunction(spec)(p);
    case "curve":  return curveValueAt(spec.curve, p);
    case "ease": {
      const v = spec.value;
      if (v < 0) return p + -v * (p * p - p);
      if (v <= 1) return p + v * (p - p * p);
      return p + (v - 1) * (3 * p * p - 2 * p * p * p - p);
    }
  }
}

/** What the export writes for an ease over `span` frames, in words. */
export function exportNote(spec: TweenSpec, span: number): string {
  const frames = `${span} frame${span === 1 ? "" : "s"}`;
  switch (spec.kind) {
    case "none":   return `${frames} · a hold: one stepped key`;
    case "linear": return `${frames} · one straight key`;
    case "preset": return `${frames} · no bezier holds this ease: ${span} keys, one per frame`;
    case "ease":
    case "curve": {
      const n = easeSegments(spec)!.length;
      return `${frames} · ${n} bezier${n === 1 ? "" : "s"}, which Spine plays as ${n * 10} straight pieces`;
    }
  }
}

/* ── Cutting an interval ──────────────────────────────────────────────────*/

/**
 * The eases of the two halves of an interval of `span` frames cut `at`
 * frames in, each reproducing the part of the original motion it now
 * governs at every whole frame. F6 does not do this — it gives both halves
 * the whole ease — so whatever must stay put across a cut (Edit Multiple
 * Frames) goes through here.
 *
 * Each half is a custom curve made of straight segments through the
 * original's value at each of its whole frames: Spine's polyline of a
 * straight bezier is the straight line, so every frame lands exactly. Null
 * when the cut shows no progress on one side.
 */
export function splitTween(spec: EaseSpec, span: number, at: number): [EaseSpec, EaseSpec] | null {
  if (spec.kind === "linear") return [spec, spec];
  const u = at / span;
  const E = (p: number) => applyTween(spec, p, span);
  const eu = E(u);
  if (Math.abs(eu) < 1e-6 || Math.abs(1 - eu) < 1e-6) return null;
  const head = Array.from({ length: at + 1 }, (_, k) => E((k / at) * u) / eu);
  const tail = Array.from({ length: span - at + 1 }, (_, k) => (E(u + (k / (span - at)) * (1 - u)) - eu) / (1 - eu));
  if ([...head, ...tail].some((v) => Math.abs(v) > CURVE_Y_LIMIT)) return null;
  return [{ kind: "curve", curve: polylineCurve(head) }, { kind: "curve", curve: polylineCurve(tail) }];
}

/** A curve of straight segments through `values`, evenly spaced over 0..1,
 *  merging runs that lie on one line. */
export function polylineCurve(values: number[]): number[] {
  const last = values.length - 1;
  const pts = values.map((y, j): [number, number] => [j / last, y]);
  const TOL = 1e-9;
  const kept: Array<[number, number]> = [pts[0]!];
  let a = 0;
  while (a < pts.length - 1) {
    let b = a + 1;
    while (b + 1 < pts.length && collinear(pts, a, b + 1, TOL)) b++;
    kept.push(pts[b]!);
    a = b;
  }
  const out: number[] = [];
  for (let s = 0; s < kept.length - 1; s++) {
    const [ax, ay] = kept[s]!;
    const [bx, by] = kept[s + 1]!;
    if (s > 0) out.push(ax, ay);
    out.push(ax + (bx - ax) / 3, ay + (by - ay) / 3, ax + (2 * (bx - ax)) / 3, ay + (2 * (by - ay)) / 3);
  }
  return out;
}

function collinear(pts: Array<[number, number]>, a: number, b: number, tol: number): boolean {
  const [ax, ay] = pts[a]!;
  const [bx, by] = pts[b]!;
  for (let i = a + 1; i < b; i++) {
    const [x, y] = pts[i]!;
    if (Math.abs(ay + ((by - ay) * (x - ax)) / (bx - ax) - y) > tol) return false;
  }
  return true;
}

/* ── Labels ───────────────────────────────────────────────────────────────*/

const DIR_LABEL: Record<EaseDir, string> = { in: "in", out: "out", inOut: "in-out" };

/** Which quad ease a classic scalar is: negative in, up to 1 out, above in-out. */
export function classicDir(value: number): EaseDir {
  if (value < 0) return "in";
  if (value > 1) return "inOut";
  return "out";
}

/** How an ease reads in the transport readout. */
export function easeLabel(spec: TweenSpec): string {
  switch (spec.kind) {
    case "none":   return "no tween";
    case "linear": return "linear";
    case "ease":   return `ease ${DIR_LABEL[classicDir(spec.value)]}`;
    case "curve":  return "custom";
    case "preset": return `${spec.family} ${DIR_LABEL[spec.dir]}`;
  }
}

/** The short tag drawn on a tweened span in the frame grid. */
export function easeTag(spec: TweenSpec): string | null {
  switch (spec.kind) {
    case "none":
    case "linear": return null;
    case "ease":   return DIR_LABEL[classicDir(spec.value)];
    case "curve":  return "~";
    case "preset": return spec.family;
  }
}

/** Quick presets offered in the frame context menu. */
export const EASE_PRESETS: ReadonlyArray<{ label: string; spec: TweenSpec }> = [
  { label: "No tween",     spec: TWEEN_NONE },
  { label: "Linear",       spec: TWEEN_LINEAR },
  { label: "Ease in",      spec: { kind: "ease", value: -1 } },
  { label: "Ease out",     spec: { kind: "ease", value: 1 } },
  { label: "Ease in-out",  spec: { kind: "ease", value: 2 } },
];

/* ── Per-property eases ───────────────────────────────────────────────────*/

/**
 * The properties an ease can be set for. `x`, `y`, `scaleX` and `scaleY`
 * refine position and scale one axis at a time; `shear` (skewY − skewX, how
 * far the two skews part) refines rotation, as Spine keys rotate and shear
 * on timelines of their own. A refinement unset follows its parent.
 */
export type TweenChannel = "position" | "x" | "y" | "rotation" | "shear" | "scale" | "scaleX" | "scaleY" | "color";
/** In the Ease dialog's order, each refinement after its parent. */
export const TWEEN_CHANNELS: readonly TweenChannel[] = ["position", "x", "y", "rotation", "shear", "scale", "scaleX", "scaleY", "color"];
export const CHANNEL_PARENT: Partial<Record<TweenChannel, TweenChannel>> = {
  x: "position", y: "position", shear: "rotation", scaleX: "scale", scaleY: "scale",
};
export type ChannelEases = Partial<Record<TweenChannel, EaseSpec>>;

/** The ease a channel follows over the interval leaving a key. A hold holds
 *  every channel; otherwise the most specific override wins over the key's
 *  own ease. */
export function easeOf(key: { tween: TweenSpec; eases?: ChannelEases }, channel: TweenChannel): TweenSpec {
  if (key.tween.kind === "none") return key.tween;
  const parent = CHANNEL_PARENT[channel];
  return key.eases?.[channel] ?? (parent && key.eases?.[parent]) ?? key.tween;
}

/** Structural equality, for "do these keys share an ease". */
export function sameEase(a: TweenSpec | undefined, b: TweenSpec | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
