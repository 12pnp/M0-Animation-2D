import type { NodeId } from "@/core/doc/ids";
import type { Animation, DeformKey, DisplayRef } from "@/core/doc/types";
import { keySpan, withKeyAt } from "@/core/doc/keyList";

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
  const s = keySpan(deformKeysOf(anim, typeof target === "string" ? { nodeId: target, skin: null, index: 0 } : target), frame);
  if (!s) return null;
  const { a, b, e } = s;
  if (!b) return [...a.offsets];
  return a.offsets.map((v, k) => v + ((b.offsets[k] ?? 0) - v) * e);
}

/** `keys` with a key at `frame` holding `offsets`; a key there keeps its tween. */
export function withDeformKey(keys: readonly DeformKey[], frame: number, offsets: readonly number[]): DeformKey[] {
  return withKeyAt(keys, frame, (at): DeformKey => ({ ...at, frame, offsets: offsets.map((v) => Math.round(v * 1000) / 1000) }));
}
