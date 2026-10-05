import type { ChannelEases, EaseSpec, TweenChannel, TweenSpec } from "@/core/math/easing";
import { CHANNEL_PARENT, CURVE_Y_LIMIT, sameEase } from "@/core/math/easing";
import { boneburstPolyline, readPolyline } from "@/core/boneburst/runtime/bezier";
import type { BoneBurstLocal } from "./transform";
import type { ColorTransform } from "@/core/doc/types";
import { colorOfLightDark } from "./color";
import { obj, num, str } from "./importRead";
import type { BoneBurstRaw } from "./types";

/**
 * Spine's per-channel keys turned into the editor's keyframes.
 *
 * Spine keys each value on its own: rotate at some times, translate x at
 * others, each key with its own curve per value. The editor keys a node's
 * whole state at shared frames, with one ease per tween channel (position,
 * rotation, scale, colour). So the keys land on the UNION of the frames any
 * value is keyed at, and each interval between two of them gets, per
 * channel, the ease that reproduces what Spine plays there:
 *
 *   a value that does not change         any ease (it stays put)
 *   stepped, or before a value's first key  a hold
 *   linear                               linear
 *   a bezier over the whole interval     that curve, scaled into 0..1
 *   part of a bezier (another value is keyed inside it)  the part, cut out
 *                                        exactly (de Casteljau)
 *
 * Values of one channel wanting different eases (x and y on their own
 * curves) get them per axis, as refinements (`ChannelGroup.parts`).
 *
 * and every interval is then CHECKED at each whole frame, through the
 * stage's own sampler (`sample`), against Spine's evaluation of the
 * original keys (`valueAt`, Spine's 10-piece polyline). Where the values of
 * one refinement want different curves, a hold meets a tween, or a cut-out
 * part drifts from the polyline Spine drew for the whole, the interval is
 * written frame by frame instead: exact at every whole frame, straight
 * between. `baked` counts those.
 */

/** A value's key, in frames (whole, unless it truly falls between two) and
 *  in absolute units; the curve's controls too. */
export interface CompKey {
  frame: number;
  value: number;
  curve: null | "stepped" | [number, number, number, number];
}

/** One animated value: before its first key it shows `setup`. */
export interface Comp { setup: number; keys: CompKey[] }

/** Spine's value at a frame (`CurveTimeline.getCurveValue` and the setup
 *  pose before the first key). */
export function valueAt(c: Comp, f: number): number {
  const k = c.keys;
  if (k.length === 0 || f < k[0]!.frame) return c.setup;
  let i = 0;
  while (i + 1 < k.length && k[i + 1]!.frame <= f) i++;
  const a = k[i]!, b = k[i + 1];
  if (!b || f === a.frame || a.curve === "stepped") return a.value;
  if (!a.curve) return a.value + ((b.value - a.value) * (f - a.frame)) / (b.frame - a.frame);
  const [c1x, c1y, c2x, c2y] = a.curve;
  return readPolyline(boneburstPolyline({ x0: a.frame, y0: a.value, c1x, c1y, c2x, c2y, x1: b.frame, y1: b.value }), f);
}

type CompEase = { kind: "const" } | { kind: "hold" } | { kind: "linear" } | { kind: "curve"; c: number[] } | null;

/** How one value moves over [a, b], a and b both key frames of the union. */
function compEase(c: Comp, a: number, b: number, eps: number): CompEase {
  const va = valueAt(c, a), vb = valueAt(c, b);
  const k = c.keys;
  if (k.length === 0) return { kind: "const" };
  if (a < k[0]!.frame) return Math.abs(vb - va) <= eps ? { kind: "const" } : { kind: "hold" };
  let i = 0;
  while (i + 1 < k.length && k[i + 1]!.frame <= a) i++;
  const ka = k[i]!, kb = k[i + 1];
  if (!kb) return { kind: "const" };
  if (ka.curve === "stepped") return b === kb.frame && Math.abs(vb - va) > eps ? { kind: "hold" } : { kind: "const" };
  if (!ka.curve) return Math.abs(vb - va) <= eps ? { kind: "const" } : { kind: "linear" };

  // Bezier: the part over [a, b], in absolute frames and values.
  let p = [ka.frame, ka.value, ...ka.curve, kb.frame, kb.value];
  const cut = a !== ka.frame || b !== kb.frame;
  if (cut) p = subCurve(p, a, b);
  const [, y0, c1x, c1y, c2x, c2y, , y1] = p as [number, number, number, number, number, number, number, number];
  if (Math.abs(vb - va) <= eps) {
    return Math.abs(c1y - y0) <= eps && Math.abs(c2y - y0) <= eps && Math.abs(y1 - y0) <= eps ? { kind: "const" } : null;
  }
  const n = [(c1x - a) / (b - a), (c1y - va) / (vb - va), (c2x - a) / (b - a), (c2y - va) / (vb - va)];
  // A cut is exact as a curve, but Spine plays each half as its own
  // polyline, which drifts from the whole's: the value controls are fitted
  // to what the whole plays at each frame inside.
  if (cut) fitValues(n, a, b, (f) => (valueAt(c, f) - va) / (vb - va));
  const ok = n[0]! >= 0 && n[0]! <= 1 && n[2]! >= 0 && n[2]! <= 1
    && Math.abs(n[1]!) <= CURVE_Y_LIMIT && Math.abs(n[3]!) <= CURVE_Y_LIMIT;
  return ok ? { kind: "curve", c: n } : null;
}

/**
 * The value controls of a curve over [a, b] (in 0..1 space, `n` as
 * [c1x, c1y, c2x, c2y]) that best reproduce `target` at the whole frames
 * inside, as Spine plays it. With the time controls fixed, the polyline and
 * so the played value are linear in the two value controls: least squares,
 * pulled faintly toward the start (the exact cut) for one frame or none.
 */
function fitValues(n: number[], a: number, b: number, target: (f: number) => number): void {
  const frames: number[] = [];
  for (let f = Math.floor(a) + 1; f < b; f++) if (f > a) frames.push(f);
  if (frames.length === 0) return;
  const played = (y1: number, y2: number, p: number) =>
    readPolyline(boneburstPolyline({ x0: 0, y0: 0, c1x: n[0]!, c1y: y1, c2x: n[2]!, c2y: y2, x1: 1, y1: 1 }), p);
  const lambda = 1e-6;
  let s11 = lambda, s12 = 0, s22 = lambda, r1 = lambda * n[1]!, r2 = lambda * n[3]!;
  for (const f of frames) {
    const p = (f - a) / (b - a);
    const g0 = played(0, 0, p), g1 = played(1, 0, p) - g0, g2 = played(0, 1, p) - g0;
    const t = target(f) - g0;
    s11 += g1 * g1; s12 += g1 * g2; s22 += g2 * g2; r1 += g1 * t; r2 += g2 * t;
  }
  const det = s11 * s22 - s12 * s12;
  if (Math.abs(det) < 1e-18) return;
  n[1] = (r1 * s22 - r2 * s12) / det;
  n[3] = (r2 * s11 - r1 * s12) / det;
}

/** The cubic (x0,y0 c1 c2 x1,y1) restricted to x in [a, b]. */
function subCurve(p: number[], a: number, b: number): number[] {
  const at = (u: number) => {
    const l = 1 - u;
    return l * l * l * p[0]! + 3 * l * l * u * p[2]! + 3 * l * u * u * p[4]! + u * u * u * p[6]!;
  };
  // x(u) rises for any curve Spine writes (controls inside the interval).
  const solve = (x: number) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) < x) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const ua = a <= p[0]! ? 0 : solve(a), ub = b >= p[6]! ? 1 : solve(b);
  const left = split(p, ub)[0];
  return ub === 0 ? left : split(left, ua / ub)[1];
}

/** De Casteljau: the cubic cut at parameter u into two. */
function split(p: number[], u: number): [number[], number[]] {
  const lerp = (i: number, j: number, q: number[]) => [q[i]! + (q[j]! - q[i]!) * u, q[i + 1]! + (q[j + 1]! - q[i + 1]!) * u];
  const [ax, ay] = lerp(0, 2, p), [bx, by] = lerp(2, 4, p), [cx, cy] = lerp(4, 6, p);
  const q = [ax!, ay!, bx!, by!, cx!, cy!];
  const [dx, dy] = lerp(0, 2, q), [ex, ey] = lerp(2, 4, q);
  const r = [dx!, dy!, ex!, ey!];
  const [mx, my] = lerp(0, 2, r);
  return [
    [p[0]!, p[1]!, ax!, ay!, dx!, dy!, mx!, my!],
    [mx!, my!, ex!, ey!, cx!, cy!, p[6]!, p[7]!],
  ];
}

/** One tween channel: the values it moves together. `parts` split it into
 *  its refinements (position into x and y …), tried when the values do not
 *  share one ease. */
export interface ChannelGroup { channel: TweenChannel; comps: Comp[]; eps: number; parts?: ChannelGroup[] }

/** The ease one channel needs over [a, b], "const" when it does not move. */
function groupEase(g: ChannelGroup, a: number, b: number): CompEase {
  let out: CompEase = { kind: "const" };
  for (const c of g.comps) {
    const e = compEase(c, a, b, g.eps);
    if (!e) return null;
    if (e.kind === "const") continue;
    if (out.kind === "const") { out = e; continue; }
    if (e.kind !== out.kind) return null;
    // One ease for the channel: the same times, values within a hair (two
    // fits of one cut); averaged, and the interval check has the last word.
    if (e.kind === "curve" && out.kind === "curve") {
      const prev: number[] = out.c;
      if (e.c.some((v, i) => Math.abs(v - prev[i]!) > (i % 2 ? 1e-2 : 1e-6))) return null;
      out = { kind: "curve", c: prev.map((v, i) => (v + e.c[i]!) / 2) };
    }
  }
  return out;
}

/** A channel's ease over [a, b], or, when its values want different ones,
 *  each refinement's. */
function channelEases(g: ChannelGroup, a: number, b: number): Array<{ channel: TweenChannel; e: CompEase }> {
  const e = groupEase(g, a, b);
  if (e || !g.parts) return [{ channel: g.channel, e }];
  return g.parts.map((p) => ({ channel: p.channel, e: groupEase(p, a, b) }));
}

function easeSpec(e: CompEase): EaseSpec | null {
  if (!e || e.kind === "const" || e.kind === "hold") return null;
  return e.kind === "linear" ? { kind: "linear" } : { kind: "curve", curve: e.c };
}

/** A keyframe's timing: its tween, and per-channel overrides. */
export interface KeyTiming { frame: number; tween: TweenSpec; eases?: ChannelEases }

/**
 * The key frames and eases for one node, and the intervals written frame by
 * frame. `extra` adds frames that must be keys (attachment switches);
 * `check(a, b, timing)` samples the interval as the stage would and says
 * whether it matches Spine at every whole frame inside it.
 */
export function mergeKeys(
  groups: ChannelGroup[], extra: number[], end: number,
  check: (a: KeyTiming, b: number) => boolean,
): { keys: KeyTiming[]; baked: number } {
  // A key between frames (a retimed animation) has no frame of its own: the
  // interval round it fails the check and is written frame by frame.
  const frames = new Set<number>([0, ...extra]);
  for (const g of groups) for (const c of g.comps) for (const k of c.keys) frames.add(Math.round(k.frame));
  const sorted = [...frames].filter((f) => f >= 0 && f <= end).sort((p, q) => p - q);

  const keys: KeyTiming[] = [];
  let baked = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!, b = sorted[i + 1];
    if (b === undefined) { keys.push({ frame: a, tween: { kind: "none" } }); break; }
    const eases = groups.flatMap((g) => channelEases(g, a, b));
    let timing: KeyTiming | null = null;
    if (eases.every(({ e }) => e !== null)) {
      const moving = eases.filter(({ e }) => e!.kind !== "const");
      if (moving.length === 0 || moving.every(({ e }) => e!.kind === "hold")) {
        timing = { frame: a, tween: { kind: "none" } };
      } else if (moving.every(({ e }) => e!.kind !== "hold")) {
        const tween = easeSpec(moving[0]!.e)!;
        const over: ChannelEases = {};
        // Against what the channel would inherit: a shear unset follows a
        // rotation override. Parents come before their refinements.
        for (const { channel, e } of moving.slice(1)) {
          const spec = easeSpec(e)!;
          const parent = CHANNEL_PARENT[channel];
          if (!sameEase(spec, over[channel] ?? (parent && over[parent]) ?? tween)) over[channel] = spec;
        }
        timing = Object.keys(over).length ? { frame: a, tween, eases: over } : { frame: a, tween };
      }
    }
    if (timing && check(timing, b)) { keys.push(timing); continue; }
    // Frame by frame: exact at each whole frame. A single frame is its own
    // straight line, so that one only fails the check when nothing could
    // pass it; keep it straight.
    baked++;
    for (let f = a; f < b; f++) keys.push({ frame: f, tween: { kind: "linear" } });
  }
  return { keys, baked };
}
/* ── bone keys ───────────────────────────────────────────────────────────── */
export type BoneValue = keyof BoneBurstLocal;
/** Which timeline value feeds which pose value, and how its keys add to or
 *  multiply the setup pose. */
export const BONE_TIMELINES: Record<string, Array<{ value: BoneValue; field: string; }>> = {
  rotate: [{ value: "rotation", field: "value" }],
  translate: [{ value: "x", field: "x" }, { value: "y", field: "y" }],
  translatex: [{ value: "x", field: "value" }],
  translatey: [{ value: "y", field: "value" }],
  scale: [{ value: "scaleX", field: "x" }, { value: "scaleY", field: "y" }],
  scalex: [{ value: "scaleX", field: "value" }],
  scaley: [{ value: "scaleY", field: "value" }],
  shear: [{ value: "shearX", field: "x" }, { value: "shearY", field: "y" }],
  shearx: [{ value: "shearX", field: "value" }],
  sheary: [{ value: "shearY", field: "value" }],
};
export const SHEAR_TIMELINES = ["shear", "shearx", "sheary"];
interface BoneGroups extends ChannelGroup { values: BoneValue[]; }
/** A bone's keyed values, grouped by the editor's tween channels. */
export function boneComps(timelines: BoneBurstRaw, setup: BoneBurstLocal, rate: number, keepShear: boolean): { groups: BoneGroups[]; rest: BoneBurstRaw | null; } {
  const comps = new Map<BoneValue, Comp>();
  const rest: BoneBurstRaw = {};
  for (const [timeline, keys] of Object.entries(timelines)) {
    const spec = keepShear && SHEAR_TIMELINES.includes(timeline) ? undefined : BONE_TIMELINES[timeline];
    if (!spec || !Array.isArray(keys)) { rest[timeline] = keys; continue; }
    spec.forEach(({ value, field }, i) => {
      const scale = value === "scaleX" || value === "scaleY";
      const base = setup[value];
      const abs = (v: number) => (scale ? base * v : base + v);
      comps.set(value, compOf(keys.filter(obj), rate, i, (k) => abs(num(k[field], scale ? 1 : 0)), abs, base));
    });
  }
  const group = (
    channel: ChannelGroup["channel"], values: BoneValue[], eps: number,
    parts: Array<[ChannelGroup["channel"], BoneValue[]]> = []
  ): BoneGroups | null => {
    const cs = values.map((v) => comps.get(v)).filter((c): c is Comp => !!c);
    if (!cs.length) return null;
    const refined = parts.map(([ch, vs]) => group(ch, vs, eps)).filter((p): p is BoneGroups => !!p);
    return { channel, comps: cs, eps, values: values.filter((v) => comps.has(v)), ...(refined.length ? { parts: refined } : {}) };
  };
  // The stage's rotation turns skewY, which is rotation + shearX; its shear
  // is skewY − skewX, shearY − shearX (`fromBoneBurstLocal`).
  const groups = [
    group("position", ["x", "y"], 1e-6, [["x", ["x"]], ["y", ["y"]]]),
    group("rotation", ["rotation", "shearX", "shearY"], 1e-6, [["rotation", ["rotation", "shearX"]], ["shear", ["shearX", "shearY"]]]),
    group("scale", ["scaleX", "scaleY"], 1e-9, [["scaleX", ["scaleX"]], ["scaleY", ["scaleY"]]]),
  ].filter((g): g is BoneGroups => !!g);
  return { groups, rest: Object.keys(rest).length ? rest : null };
}
/** The bone's local pose at a frame: its keyed values, the setup pose for
 *  the rest. */
export function boneLocalAt(groups: BoneGroups[], setup: BoneBurstLocal, f: number): BoneBurstLocal {
  const out = { ...setup };
  for (const g of groups) g.values.forEach((v, i) => { out[v] = valueAt(g.comps[i]!, f); });
  return out;
}
/**
 * One value of a Spine timeline as a `Comp`: keys at whole frames, values
 * and curve controls absolute. `index` picks the value's four numbers in
 * each key's curve (x then y for two-value timelines).
 */
function compOf(
  keys: BoneBurstRaw[], rate: number, index: number,
  value: (k: BoneBurstRaw) => number, abs: (v: number) => number, setup: number
): Comp {
  const out: CompKey[] = [];
  keys.forEach((k, i) => {
    const t = num(k.time, 0), frame = frameOf(t, rate);
    const next = keys[i + 1];
    let curve: CompKey["curve"] = null;
    if (k.curve === "stepped") curve = "stepped";
    else if (Array.isArray(k.curve) && next) {
      const c = k.curve.slice(index * 4, index * 4 + 4).map((x) => num(x, 0));
      const t1 = num(next.time, 0), f1 = frameOf(t1, rate);
      // Times into frames, keeping each control where it sat between the
      // two keys (a key's time is read onto its whole frame).
      const toF = (x: number) => (t1 === t ? frame : frame + ((x - t) / (t1 - t)) * (f1 - frame));
      curve = [toF(c[0]!), abs(c[1]!), toF(c[2]!), abs(c[3]!)];
    }
    out.push({ frame, value: value(k), curve });
  });
  return { setup, keys: out };
}
/* ── slot keys ───────────────────────────────────────────────────────────── */
interface Rgba2 { r: number; g: number; b: number; a: number; dr: number; dg: number; db: number; }
const CHANNELS = ["r", "g", "b", "a", "dr", "dg", "db"] as const;
function hexColor(v: unknown, fallback: number[]): number[] {
  if (!str(v)) return fallback;
  const out = fallback.slice();
  for (let i = 0; i * 2 < v.length && i < out.length; i++) out[i] = parseInt(v.slice(i * 2, i * 2 + 2), 16) / 255;
  return out;
}
export function slotSetup(s: BoneBurstRaw): Rgba2 {
  const [r, g, b, a] = hexColor(s.color, [1, 1, 1, 1]) as [number, number, number, number];
  const [dr, dg, db] = hexColor(s.dark, [0, 0, 0]) as [number, number, number];
  return { r, g, b, a, dr, dg, db };
}
function toColor(c: Rgba2): ColorTransform {
  return colorOfLightDark(c.r, c.g, c.b, c.a, c.dr, c.dg, c.db);
}
export function slotColor(color: unknown, dark: unknown): ColorTransform {
  return toColor(slotSetup({ color, dark }));
}
/** Which colour values each colour timeline keys, in its curve order. */
const COLOR_TIMELINES: Record<string, Array<{ ch: (typeof CHANNELS)[number]; read: (k: BoneBurstRaw) => number; }>> = {
  rgba: (["r", "g", "b", "a"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.color, [1, 1, 1, 1])[i]! })),
  rgb: (["r", "g", "b"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.color, [1, 1, 1])[i]! })),
  alpha: [{ ch: "a", read: (k: BoneBurstRaw) => num(k.value, 1) }],
  rgba2: [
    ...(["r", "g", "b", "a"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.light, [1, 1, 1, 1])[i]! })),
    ...(["dr", "dg", "db"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.dark, [0, 0, 0])[i]! })),
  ],
  rgb2: [
    ...(["r", "g", "b"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.light, [1, 1, 1])[i]! })),
    ...(["dr", "dg", "db"] as const).map((ch, i) => ({ ch, read: (k: BoneBurstRaw) => hexColor(k.dark, [0, 0, 0])[i]! })),
  ],
};
type ColorGroup = ChannelGroup & { chans: Array<(typeof CHANNELS)[number]>; setup: Rgba2; };
export function colorComps(timelines: BoneBurstRaw, setup: Rgba2, rate: number): { group: ColorGroup | null; rest: BoneBurstRaw | null; } {
  const comps = new Map<(typeof CHANNELS)[number], Comp>();
  const rest: BoneBurstRaw = {};
  for (const [timeline, keys] of Object.entries(timelines)) {
    if (timeline === "attachment") continue;
    const spec = COLOR_TIMELINES[timeline];
    if (!spec || !Array.isArray(keys)) { rest[timeline] = keys; continue; }
    spec.forEach(({ ch, read }, i) => comps.set(ch, compOf(keys.filter(obj), rate, i, read, (v) => v, setup[ch])));
  }
  const chans = CHANNELS.filter((c) => comps.has(c));
  const group: ColorGroup | null = chans.length
    ? { channel: "color", comps: chans.map((c) => comps.get(c)!), eps: 1e-7, chans, setup } : null;
  return { group, rest: Object.keys(rest).length ? rest : null };
}
export function slotColorAt(g: ColorGroup, f: number): ColorTransform {
  const c = { ...g.setup };
  g.chans.forEach((ch, i) => { c[ch] = valueAt(g.comps[i]!, f); });
  return toColor(c);
}
/**
 * A key time in frames: the whole frame it was written for (the editor
 * stores times to seven digits, so 1/3 s is 9.999999 frames at 30 fps), or
 * where it truly falls between two.
 */

export function frameOf(t: number, rate: number): number {
  const f = t * rate;
  return Math.abs(f - Math.round(f)) <= 2e-3 ? Math.round(f) : f;
}
