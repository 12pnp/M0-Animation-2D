import { applyTween } from "@/core/math/easing";
import type { NodeId } from "@/core/doc/ids";
import type { Animation, DeformKey, DisplayRef } from "@/core/doc/types";
import { type IkTween, SMOOTH_CURVE } from "@/core/doc/ikKeys";

/**
 * Deform keys (ARCHITECTURE ▸ Meshes): each point's offset, per mesh node,
 * as Spine's `deform` timeline. Before the first key the mesh is as made;
 * from a key on the offsets tween to the next key by the key's tween.
 */

/**
 * Which mesh display a list of deform keys belongs to: a node's display in a
 * skin (null: the node's own). The default skin's display 0 keeps its keys in
 * `Animation.deforms`, every other in `Animation.displayDeforms`.
 */
export interface DeformTarget { nodeId: NodeId; skin: string | null; index: number }

export function deformKeysOf(anim: Animation | null | undefined, t: DeformTarget): DeformKey[] | undefined {
  if (t.skin === null && t.index === 0) return anim?.deforms?.[t.nodeId];
  return anim?.displayDeforms?.[t.skin ?? "default"]?.[t.nodeId]?.[String(t.index)];
}

/** The animation's deform fields with `t`'s keys replaced (none: removed). */
export function withDeformKeysOf(anim: Animation, t: DeformTarget, keys: DeformKey[] | undefined): Pick<Animation, "deforms" | "displayDeforms"> {
  const out: Pick<Animation, "deforms" | "displayDeforms"> = { deforms: anim.deforms, displayDeforms: anim.displayDeforms };
  if (t.skin === null && t.index === 0) {
    const d = { ...anim.deforms };
    if (keys?.length) d[t.nodeId] = keys; else delete d[t.nodeId];
    out.deforms = Object.keys(d).length ? d : undefined;
    return out;
  }
  const skin = t.skin ?? "default";
  const byNode = { ...anim.displayDeforms?.[skin] };
  const byIndex = { ...byNode[t.nodeId] };
  if (keys?.length) byIndex[String(t.index)] = keys; else delete byIndex[String(t.index)];
  if (Object.keys(byIndex).length) byNode[t.nodeId] = byIndex; else delete byNode[t.nodeId];
  const all = { ...anim.displayDeforms };
  if (Object.keys(byNode).length) all[skin] = byNode; else delete all[skin];
  out.displayDeforms = Object.keys(all).length ? all : undefined;
  return out;
}

/**
 * The keys a display draws with, shown from `skin` (null: the node's own) at
 * `index`: its own mesh's, or a linked mesh's source's (in the skin the link
 * names, else the default skin) unless the link leaves them out. Null: none.
 */
export function drawnDeformTarget(nodeId: NodeId, display: DisplayRef, skin: string | null, index: number): DeformTarget | null {
  if (display.mesh) return { nodeId, skin, index };
  if (display.linked && display.linked.deform !== false) return { nodeId, skin: display.linked.skin ?? null, index: display.linked.to };
  return null;
}

/** `anim` with its deform fields set, absent ones removed. */
export function assignDeforms(anim: Animation, fields: Pick<Animation, "deforms" | "displayDeforms">): void {
  if (fields.deforms) anim.deforms = fields.deforms; else delete anim.deforms;
  if (fields.displayDeforms) anim.displayDeforms = fields.displayDeforms; else delete anim.displayDeforms;
}

/** The offsets at `frame` (fractional between frames); null: none. A node id
 *  alone is its default skin's display 0. */
export function deformAt(anim: Animation | null | undefined, target: NodeId | DeformTarget, frame: number): number[] | null {
  const keys = deformKeysOf(anim, typeof target === "string" ? { nodeId: target, skin: null, index: 0 } : target);
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
