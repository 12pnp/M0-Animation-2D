import { boneSide } from "@/core/rig/motion";
import type { ImageFrame } from "@/core/doc/reference";
import type { BoneMark } from "./AgentApi";
import type { BoneBurstLocal } from "@/core/boneburst/transform";
import { type TweenSpec, CURVE_Y_LIMIT, sameEase, easeOf, type ChannelEases } from "@/core/math/easing";
import type { IkKey, IkConstraint, Keyframe } from "@/core/doc/types";
import type { BoneBurstPoint } from "@/core/rig/rigPlan";
import { keyTweenOf } from "@/core/doc/keyList";

/** A tool call the model got wrong: said back to it, not thrown at the user. */
export class AgentError extends Error {}

export type Args = Record<string, unknown>;
export type BoneIn = { name: string; parent?: string; from?: number[]; to?: number[]; x?: number; y?: number; rotation?: number; length?: number };
export type AttachIn = { bone: string; image?: string; layer?: string; name?: string; pivot?: number[]; at?: number[]; rotation?: number; scale?: number };
export type PathKeyIn = { frame: number; x: number; y: number; out?: number[]; in?: number[] };
export type SpineKeyIn = {
  bone: string; frame: number; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number;
  ease?: string | number[]; eases?: Partial<Record<AxisName, string | number[]>>;
};
// + 0: no -0 in what the model reads.
export const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits + 0;
/* ── helpers ── */
export function mark(b: { name: string; from: [number, number]; to: [number, number]; }, view: ImageFrame): BoneMark {
  const side = boneSide(b.name);
  return { name: b.name, from: view.toPixel(...b.from), to: view.toPixel(...b.to), ...(side ? { side } : {}) };
}
export function spine(l: BoneBurstLocal) {
  const out: Record<string, number> = { x: round(l.x), y: round(l.y), rotation: round(l.rotation), scaleX: round(l.scaleX), scaleY: round(l.scaleY) };
  if (l.shearY) out.shearY = round(l.shearY);
  return out;
}
export function tweenOf(ease: string | number[]): TweenSpec {
  if (Array.isArray(ease)) {
    if (ease.length !== 4 || !ease.every((v) => typeof v === "number" && Number.isFinite(v))) throw new AgentError("A bezier ease is four numbers: [x1, y1, x2, y2].");
    const [x1, y1, x2, y2] = ease as [number, number, number, number];
    const x = (v: number) => Math.min(1, Math.max(0, v)), y = (v: number) => Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, v));
    return { kind: "curve", curve: [x(x1), y(y1), x(x2), y(y2)] };
  }
  switch (ease) {
    case "linear": return { kind: "linear" };
    case "hold": return { kind: "none" };
    case "in": return { kind: "ease", value: -1 };
    case "out": return { kind: "ease", value: 1 };
    case "inout": return { kind: "ease", value: 2 };
    default: throw new AgentError(`Unknown ease "${ease}": linear, hold, in, out, inout, or [x1, y1, x2, y2].`);
  }
}
export function easeName(t: TweenSpec): string | number[] {
  return t.kind === "none" ? "hold" : t.kind === "linear" ? "linear"
    : t.kind === "ease" ? (t.value < 0 ? "in" : t.value <= 1 ? "out" : "inout")
      : t.kind === "curve" && t.curve.length === 4 ? t.curve.map((v) => round(v)) : "custom";
}
/** The tools' per-property names: each is the editor's channel of that name. */
export const AXES = ["x", "y", "rotation", "scaleX", "scaleY"] as const;
export type AxisName = (typeof AXES)[number];
/** A key's properties that do not follow its `ease`, with theirs. */
export function axisEases(k: Keyframe): Record<string, string | number[]> | null {
  if (k.tween.kind === "none") return null;
  const out: Record<string, string | number[]> = {};
  for (const ax of AXES) {
    const e = easeOf(k, ax);
    if (!sameEase(e, k.tween)) out[ax] = easeName(e);
  }
  return Object.keys(out).length ? out : null;
}
export function easesOf(raw: unknown, where: string): ChannelEases | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError(`${where}: eases is an object, e.g. {"y": "out"}.`);
  const out: ChannelEases = {};
  for (const [ax, ease] of Object.entries(raw)) {
    if (!(AXES as readonly string[]).includes(ax)) throw new AgentError(`${where}: eases has no property "${ax}" (${AXES.join(", ")}).`);
    const spec = tweenOf(ease as string | number[]);
    if (spec.kind === "none") throw new AgentError(`${where}: "hold" is for the whole key (ease), not one property.`);
    out[ax as AxisName] = spec;
  }
  return Object.keys(out).length ? out : null;
}
export function point(v: unknown, where: string): BoneBurstPoint {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) throw new AgentError(`${where} is two numbers, [x, y].`);
  return [v[0] as number, v[1] as number];
}
export function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new AgentError(`"${key}" is required, as text.`);
  return v;
}
/** An IK key as the AI reads it: the softness only where it is not 0. */
export function ikKeyOut(k: IkConstraint, key: IkKey) {
  const softness = key.softness ?? k.softness ?? 0;
  return { mix: round(key.mix, 3), bendPositive: key.bendPositive, ...(softness ? { softness: round(softness, 3) } : {}), ease: keyTweenOf(key) };
}
export function int(args: Args, key: string, min: number): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new AgentError(`"${key}" must be a whole number of at least ${min}.`);
  return v;
}
export function list<T>(args: Args, key: string): T[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new AgentError(`"${key}" must be a non-empty list.`);
  return v as T[];
}
