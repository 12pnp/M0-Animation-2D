import { applyTween, type TweenSpec } from "@/core/math/easing";
import type { IkId } from "./ids";
import type { Animation, IkConstraint, IkKey } from "./types";

/**
 * IK keys (ARCHITECTURE ▸ IK keys): an animation keys a constraint's mix and
 * bend (and softness) the way Spine's `ik` timeline does. Before the first
 * key the constraint's own weight, bend and softness hold; from a key on,
 * the mix and softness tween to the next key by the key's tween and the bend
 * is the key's, stepped. A key without a softness has the constraint's.
 */

export interface IkPose { mix: number; bendPositive: boolean; softness?: number }

/** The tweens an IK key can hold: what Spine's timeline writes for one value. */
export type IkTween = "linear" | "stepped" | "smooth";
export const SMOOTH_CURVE: readonly number[] = [0.42, 0, 0.58, 1];

export function ikTweenOf(k: IkKey): IkTween {
  return k.tween?.kind === "none" ? "stepped" : k.tween?.kind === "curve" ? "smooth" : "linear";
}

function tweenSpec(t: IkTween): TweenSpec | undefined {
  return t === "stepped" ? { kind: "none" } : t === "smooth" ? { kind: "curve", curve: SMOOTH_CURVE } : undefined;
}

/** The mix and bend in force at `frame` (fractional between frames). */
export function ikPoseAt(k: IkConstraint, anim: Animation | null | undefined, frame: number): Required<IkPose> {
  const setup = k.softness ?? 0;
  const keys = anim?.ik?.[k.id];
  if (!keys?.length || frame < keys[0]!.frame) return { mix: k.weight, bendPositive: k.bendPositive, softness: setup };
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.frame <= frame) i++;
  const a = keys[i]!, b = keys[i + 1];
  const sa = a.softness ?? setup;
  if (!b || a.tween?.kind === "none") return { mix: a.mix, bendPositive: a.bendPositive, softness: sa };
  const span = b.frame - a.frame;
  const e = applyTween(a.tween ?? { kind: "linear" }, (frame - a.frame) / span, span);
  return { mix: a.mix + (b.mix - a.mix) * e, bendPositive: a.bendPositive, softness: sa + ((b.softness ?? setup) - sa) * e };
}

/**
 * `keys` with a key at `frame` holding `pose`; a key already there keeps its
 * tween, and its softness when `pose` has none. A softness equal to the
 * constraint's own (`setupSoftness`) is left off the key.
 */
export function withIkKey(keys: readonly IkKey[], frame: number, pose: IkPose, setupSoftness = 0): IkKey[] {
  const at = keys.find((k) => k.frame === frame);
  const key: IkKey = { ...at, frame, mix: Math.min(1, Math.max(0, pose.mix)), bendPositive: pose.bendPositive };
  if (pose.softness !== undefined) key.softness = Math.max(0, pose.softness);
  if (key.softness !== undefined && Math.abs(key.softness - setupSoftness) < 1e-9) delete key.softness;
  return [...keys.filter((k) => k.frame !== frame), key].sort((a, b) => a.frame - b.frame);
}

/** The keys at `frames` moved by `delta` frames, replacing keys they land on. */
export function moveIkKeys(keys: readonly IkKey[], frames: readonly number[], delta: number): IkKey[] {
  const moving = new Set(frames);
  // Keys pushed together at frame 0 keep the later one.
  const moved = new Map<number, IkKey>();
  for (const k of keys) if (moving.has(k.frame)) moved.set(Math.max(0, k.frame + delta), { ...k, frame: Math.max(0, k.frame + delta) });
  return [...keys.filter((k) => !moving.has(k.frame) && !moved.has(k.frame)), ...moved.values()].sort((a, b) => a.frame - b.frame);
}

export function deleteIkKeys(keys: readonly IkKey[], frames: readonly number[]): IkKey[] {
  const gone = new Set(frames);
  return keys.filter((k) => !gone.has(k.frame));
}

/** The keys at `frames` tweening to the next key by `tween`. */
export function withIkTween(keys: readonly IkKey[], frames: readonly number[], tween: IkTween): IkKey[] {
  const at = new Set(frames);
  const spec = tweenSpec(tween);
  return keys.map((k) => {
    if (!at.has(k.frame)) return k;
    const { tween: _, ...rest } = k;
    return spec ? { ...rest, tween: spec } : rest;
  });
}

/** `anim.ik` with the constraint's keys replaced; an empty list drops it. */
export function withIkKeys(
  ik: Readonly<Record<IkId, IkKey[]>> | undefined, id: IkId, keys: IkKey[],
): Record<IkId, IkKey[]> | undefined {
  const out = { ...ik };
  if (keys.length) out[id] = keys;
  else delete out[id];
  return Object.keys(out).length ? out : undefined;
}

/** Screen pixels a vertical drag on an IK row takes to go from mix 0 to 1. */
export const IK_MIX_DRAG_PX = 80;

/** Which way a drag on an IK row goes, once it has gone `threshold` pixels:
 *  sideways moves keys in time (or scrubs), up and down sets the mix. */
export function ikDragAxis(dx: number, dy: number, threshold = 3): "time" | "mix" | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return null;
  return Math.abs(dy) > Math.abs(dx) ? "mix" : "time";
}

/** The keys at `frames` with their mix raised by a drag of `dy` pixels (up is
 *  negative, as on screen), each from its own value in `base`; `fine` (⇧)
 *  goes a quarter as fast. Clamped to 0..1. */
export function withIkMixDragged(base: readonly IkKey[], frames: readonly number[], dy: number, fine = false): IkKey[] {
  const at = new Set(frames);
  const by = (-dy / IK_MIX_DRAG_PX) * (fine ? 0.25 : 1);
  return base.map((k) => (at.has(k.frame) ? { ...k, mix: Math.round(Math.min(1, Math.max(0, k.mix + by)) * 1000) / 1000 } : k));
}
