import { keySpan, withKeyAt } from "./keyList";
import type { Animation, IkConstraint, IkKey } from "./types";

/**
 * IK keys (ARCHITECTURE ▸ IK keys): an animation keys a constraint's mix and
 * bend (and softness) the way Spine's `ik` timeline does. Before the first
 * key the constraint's own weight, bend and softness hold; from a key on,
 * the mix and softness tween to the next key by the key's tween and the bend
 * is the key's, stepped. A key without a softness has the constraint's.
 */

export interface IkPose { mix: number; bendPositive: boolean; softness?: number }

/** The mix and bend in force at `frame` (fractional between frames). */
export function ikPoseAt(k: IkConstraint, anim: Animation | null | undefined, frame: number): Required<IkPose> {
  const setup = k.softness ?? 0;
  const s = keySpan(anim?.ik?.[k.id], frame);
  if (!s) return { mix: k.weight, bendPositive: k.bendPositive, softness: setup };
  const { a, b, e } = s;
  const sa = a.softness ?? setup;
  if (!b) return { mix: a.mix, bendPositive: a.bendPositive, softness: sa };
  return { mix: a.mix + (b.mix - a.mix) * e, bendPositive: a.bendPositive, softness: sa + ((b.softness ?? setup) - sa) * e };
}

/**
 * `keys` with a key at `frame` holding `pose`; a key already there keeps its
 * tween, and its softness when `pose` has none. A softness equal to the
 * constraint's own (`setupSoftness`) is left off the key.
 */
export function withIkKey(keys: readonly IkKey[], frame: number, pose: IkPose, setupSoftness = 0): IkKey[] {
  return withKeyAt(keys, frame, (at) => {
    const key: IkKey = { ...at, frame, mix: Math.min(1, Math.max(0, pose.mix)), bendPositive: pose.bendPositive };
    if (pose.softness !== undefined) key.softness = Math.max(0, pose.softness);
    if (key.softness !== undefined && Math.abs(key.softness - setupSoftness) < 1e-9) delete key.softness;
    return key;
  });
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
