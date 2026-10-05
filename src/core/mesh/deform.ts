import { applyTween } from "@/core/math/easing";
import type { NodeId } from "@/core/doc/ids";
import type { Animation, DeformKey } from "@/core/doc/types";
import { type IkTween, SMOOTH_CURVE } from "@/core/doc/ikKeys";

/**
 * Deform keys (ARCHITECTURE ▸ Meshes): each point's offset, per mesh node,
 * as Spine's `deform` timeline. Before the first key the mesh is as made;
 * from a key on the offsets tween to the next key by the key's tween.
 */

/** The offsets at `frame` (fractional between frames); null: none. */
export function deformAt(anim: Animation | null | undefined, nodeId: NodeId, frame: number): number[] | null {
  const keys = anim?.deforms?.[nodeId];
  if (!keys?.length || frame < keys[0]!.frame) return null;
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]!.frame <= frame) i++;
  const a = keys[i]!, b = keys[i + 1];
  if (!b || a.tween?.kind === "none") return [...a.offsets];
  const span = b.frame - a.frame;
  const e = applyTween(a.tween ?? { kind: "linear" }, (frame - a.frame) / span, span);
  return a.offsets.map((v, k) => v + ((b.offsets[k] ?? 0) - v) * e);
}

/** `keys` with a key at `frame` holding `offsets`; a key there keeps its tween. */
export function withDeformKey(keys: readonly DeformKey[], frame: number, offsets: readonly number[]): DeformKey[] {
  const at = keys.find((k) => k.frame === frame);
  const key: DeformKey = { ...at, frame, offsets: offsets.map((v) => Math.round(v * 1000) / 1000) };
  return [...keys.filter((k) => k.frame !== frame), key].sort((a, b) => a.frame - b.frame);
}

/** The keys at `frames` moved by `delta` frames (not before 0), replacing
 *  keys they land on; keys pushed together keep the later. */
export function moveDeformKeys(keys: readonly DeformKey[], frames: readonly number[], delta: number): DeformKey[] {
  const moving = new Set(frames);
  const moved = new Map<number, DeformKey>();
  for (const k of keys) if (moving.has(k.frame)) moved.set(Math.max(0, k.frame + delta), { ...k, frame: Math.max(0, k.frame + delta) });
  return [...keys.filter((k) => !moving.has(k.frame) && !moved.has(k.frame)), ...moved.values()].sort((a, b) => a.frame - b.frame);
}

export function deleteDeformKeys(keys: readonly DeformKey[], frames: readonly number[]): DeformKey[] {
  const gone = new Set(frames);
  return keys.filter((k) => !gone.has(k.frame));
}

/** Every key with offsets for `count` points: a mesh that gained or lost
 *  points keeps the offsets of the points it still has (by index). */
export function fitDeforms(keys: readonly DeformKey[], count: number): DeformKey[] {
  return keys.map((k) => ({ ...k, offsets: Array.from({ length: count * 2 }, (_, i) => k.offsets[i] ?? 0) }));
}

export function deformTweenOf(k: DeformKey): IkTween {
  return k.tween?.kind === "none" ? "stepped" : k.tween?.kind === "curve" ? "smooth" : "linear";
}

/** The keys at `frames` tweening to the next key by `tween`. */
export function withDeformTween(keys: readonly DeformKey[], frames: readonly number[], tween: IkTween): DeformKey[] {
  const at = new Set(frames);
  return keys.map((k) => {
    if (!at.has(k.frame)) return k;
    const { tween: _, ...rest } = k;
    return tween === "stepped" ? { ...rest, tween: { kind: "none" } } : tween === "smooth" ? { ...rest, tween: { kind: "curve", curve: SMOOTH_CURVE } } : rest;
  });
}
