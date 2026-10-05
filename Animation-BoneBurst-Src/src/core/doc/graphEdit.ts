import { applyTween, CURVE_Y_LIMIT, type TweenSpec } from "@/core/math/easing";
import { fitCubic } from "./pathSpline";
import { type ChannelKey, sampleChannel } from "./propertyKeys";
import type { TimelineProp } from "./types";

/**
 * The graph editor's rules (docs/GRAPH-PLAN.md, ARCHITECTURE ▸ Graph editor):
 * a channel's keys (`channelKeys`) as curves over time, a key moved in time
 * and value, an interval bent by its handles. The panel only draws and
 * applies them; `setChannel` writes the result back.
 */

/** One curve: a leaf of a property. */
export interface GraphChannel {
  id: string;
  prop: TimelineProp;
  /** Which of the property's values (`LEAVES[prop]`). */
  leaf: number;
  label: string;
  color: string;
}

/** A bone's curves, in the dopesheet's colours. */
export const GRAPH_CHANNELS: readonly GraphChannel[] = [
  { id: "rotate", prop: "rotate", leaf: 0, label: "Rotate", color: "#5fd35f" },
  { id: "x", prop: "x", leaf: 0, label: "X", color: "#4fb3ff" },
  { id: "y", prop: "y", leaf: 0, label: "Y", color: "#b27bff" },
  { id: "scaleX", prop: "scale", leaf: 0, label: "Scale X", color: "#ff6b6b" },
  { id: "scaleY", prop: "scale", leaf: 1, label: "Scale Y", color: "#ffa36b" },
  { id: "shear", prop: "shear", leaf: 0, label: "Shear", color: "#f0c94a" },
];

export interface GraphPoint { frame: number; value: number }

/** The curve from `from` to `to` every `step` frames (and at each key), as
 *  the runtime plays it; `rest` when the channel has no keys. */
export function graphSamples(
  keys: readonly ChannelKey[], leaf: number, from: number, to: number, step: number, rest: readonly number[],
): GraphPoint[] {
  const frames = new Set<number>();
  for (let f = from; f <= to + 1e-9; f += step) frames.add(Math.round(f * 1e6) / 1e6);
  for (const k of keys) if (k.frame >= from && k.frame <= to) frames.add(k.frame);
  return [...frames].sort((a, b) => a - b).map((frame) => ({ frame, value: sampleChannel(keys, frame, rest)[leaf]! }));
}

/** The straight cubic: linear. */
const STRAIGHT: readonly number[] = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/** An interval's ease as one cubic `[x1, y1, x2, y2]` with ends (0, 0) and
 *  (1, 1); null when the key holds (stepped). A preset or a curve of several
 *  pieces is fitted. */
export function cubicOf(ease: TweenSpec, span = 30): number[] | null {
  switch (ease.kind) {
    case "none": return null;
    case "linear": return [...STRAIGHT];
    case "curve": if (ease.curve.length === 4) return [...ease.curve];
  }
  const n = 24;
  const samples = Array.from({ length: n - 1 }, (_, i) => {
    const t = (i + 1) / n;
    return { t, p: { x: t, y: applyTween(ease, t, span) } };
  });
  const s = fitCubic({ x: 0, y: 0 }, { x: 1, y: 1 }, samples);
  return [clamp01(s.p1.x), clampY(s.p1.y), clamp01(s.p2.x), clampY(s.p2.y)];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const clampY = (v: number) => Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, v));

/** Where the interval leaving key `index` has its out and in handles, in
 *  frames and the curve's units; null for a stepped key or the last key. */
export function handlesOf(keys: readonly ChannelKey[], index: number, leaf: number): { out: GraphPoint; in: GraphPoint } | null {
  const a = keys[index], b = keys[index + 1];
  if (!a || !b) return null;
  const c = cubicOf(a.eases[leaf]!, b.frame - a.frame);
  if (!c) return null;
  const span = b.frame - a.frame, va = a.values[leaf]!, dv = b.values[leaf]! - va;
  return {
    out: { frame: a.frame + c[0]! * span, value: va + c[1]! * dv },
    in: { frame: a.frame + c[2]! * span, value: va + c[3]! * dv },
  };
}

/**
 * `keys` with the interval leaving key `index` bent so its `end` handle sits
 * at (`frame`, `value`): time clamped to the interval, the value as a
 * fraction of the change, within `CURVE_Y_LIMIT`. Where the two ends are
 * equal the value cannot be a fraction of anything, so only the time moves.
 */
export function withHandle(
  keys: readonly ChannelKey[], index: number, leaf: number, end: "out" | "in", frame: number, value: number,
): ChannelKey[] {
  const a = keys[index], b = keys[index + 1];
  if (!a || !b) return [...keys];
  const span = b.frame - a.frame, va = a.values[leaf]!, dv = b.values[leaf]! - va;
  const c = cubicOf(a.eases[leaf]!, span);
  if (!c) return [...keys];
  const x = clamp01((frame - a.frame) / span);
  const y = Math.abs(dv) > 1e-9 ? clampY((value - va) / dv) : c[end === "out" ? 1 : 3]!;
  if (end === "out") { c[0] = x; c[1] = y; } else { c[2] = x; c[3] = y; }
  const eases = a.eases.map((e, n) => (n === leaf ? ({ kind: "curve", curve: c } as TweenSpec) : e));
  return keys.map((k, i) => (i === index ? { ...k, eases } : k));
}

/** A picked point: a key of the channel, and one of its leaves. */
export interface GraphPick { frame: number; leaf: number }

/**
 * The picked keys moved by `frames` whole frames (never before 0) and each
 * picked leaf by `value`. A moved key lands on and replaces an unmoved key of
 * the channel at its new frame; two moved keys landing together keep the
 * later.
 */
export function moveGraphKeys(
  keys: readonly ChannelKey[], picks: readonly GraphPick[], frames: number, value: number,
): ChannelKey[] {
  const leaves = new Map<number, Set<number>>();
  for (const p of picks) (leaves.get(p.frame) ?? leaves.set(p.frame, new Set()).get(p.frame)!).add(p.leaf);
  const moved = new Map<number, ChannelKey>();
  for (const k of keys) {
    const own = leaves.get(k.frame);
    if (!own) continue;
    const frame = Math.max(0, k.frame + frames);
    moved.set(frame, { ...k, frame, values: k.values.map((v, n) => (own.has(n) ? v + value : v)) });
  }
  return [...keys.filter((k) => !leaves.has(k.frame) && !moved.has(k.frame)), ...moved.values()].sort((a, b) => a.frame - b.frame);
}

/** The lowest and highest value a curve reaches over `samples`, widened so a
 *  flat curve still has a height. */
export function valueRange(samples: readonly GraphPoint[]): { min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const s of samples) { min = Math.min(min, s.value); max = Math.max(max, s.value); }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  if (max - min < 1e-6) { const pad = Math.max(1, Math.abs(min) * 0.1); return { min: min - pad, max: max + pad }; }
  return { min, max };
}
