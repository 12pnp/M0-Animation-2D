import { applyTween, type TweenSpec } from "@/core/math/easing";

/**
 * Key lists: a sorted array of keys, one per frame, each tweening to the next
 * by its own `tween` (none: stepped). IK, transform-constraint, constraint
 * channel, deform and sequence keys are all such lists; this is what they
 * share. Draw order keys move by their own rule (`moveDrawOrderKeys`), and
 * events allow several keys on one frame (`core/doc/events.ts`).
 */

export interface ListKey { frame: number; tween?: TweenSpec }

/** The tweens a key in such a list can be given from a menu or a tool. */
export type KeyTween = "linear" | "stepped" | "smooth";

/** Spine's "smooth" ease: a symmetric ease in and out. */
export const SMOOTH_CURVE: readonly number[] = [0.42, 0, 0.58, 1];

export function keyTweenSpec(t: KeyTween): TweenSpec | undefined {
  return t === "stepped" ? { kind: "none" } : t === "smooth" ? { kind: "curve", curve: SMOOTH_CURVE } : undefined;
}

export function keyTweenOf(k: ListKey): KeyTween {
  return k.tween?.kind === "none" ? "stepped" : k.tween?.kind === "curve" ? "smooth" : "linear";
}

/**
 * The key in force at `frame` (fractional between frames) and how far it has
 * tweened toward the next: `b` undefined holds `a` (the last key, or a
 * stepped one). Null before the first key.
 */
export function keySpan<K extends ListKey>(keys: readonly K[] | undefined, frame: number): { a: K; b: K | undefined; e: number } | null {
  if (!keys?.length || frame < keys[0]!.frame) return null;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.frame <= frame) i++;
  const a = keys[i]!, b = keys[i + 1];
  if (!b || a.tween?.kind === "none") return { a, b: undefined, e: 0 };
  const span = b.frame - a.frame;
  return { a, b, e: applyTween(a.tween ?? { kind: "linear" }, (frame - a.frame) / span, span) };
}

/** `keys` with `make(the key at frame)` at `frame`, sorted. */
export function withKeyAt<K extends ListKey>(keys: readonly K[], frame: number, make: (at: K | undefined) => K): K[] {
  const key = make(keys.find((k) => k.frame === frame));
  return [...keys.filter((k) => k.frame !== frame), key].sort((a, b) => a.frame - b.frame);
}

/** The keys at `frames` moved by `delta` frames (not before 0), replacing
 *  keys they land on; keys pushed together at frame 0 keep the later. */
export function moveKeys<K extends ListKey>(keys: readonly K[], frames: readonly number[], delta: number): K[] {
  const moving = new Set(frames);
  const moved = new Map<number, K>();
  for (const k of keys) if (moving.has(k.frame)) moved.set(Math.max(0, k.frame + delta), { ...k, frame: Math.max(0, k.frame + delta) });
  return [...keys.filter((k) => !moving.has(k.frame) && !moved.has(k.frame)), ...moved.values()].sort((a, b) => a.frame - b.frame);
}

export function deleteKeys<K extends ListKey>(keys: readonly K[], frames: readonly number[]): K[] {
  const gone = new Set(frames);
  return keys.filter((k) => !gone.has(k.frame));
}

/** The keys at `frames` tweening to the next key by `tween` (undefined: linear). */
export function withKeyTween<K extends ListKey>(keys: readonly K[], frames: readonly number[], tween: KeyTween | TweenSpec | undefined): K[] {
  const at = new Set(frames);
  if (typeof tween === "string") tween = keyTweenSpec(tween);
  return keys.map((k) => {
    if (!at.has(k.frame)) return k;
    const { tween: _, ...rest } = k;
    return (tween ? { ...rest, tween } : rest) as K;
  });
}
