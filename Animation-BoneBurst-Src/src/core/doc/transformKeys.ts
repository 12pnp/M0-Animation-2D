import type { TransformData } from "@/core/boneburst/runtime/rigTypes";
import type { NodeId, TcId } from "./ids";
import { type Animation, type SymbolItem, TC_CHANNELS, type TcChannel, type TcFrom, type TcKey, type TcTo, type TransformConstraint } from "./types";
import { keySpan, withKeyAt } from "./keyList";

export type TcMix = Record<TcChannel, number>;

/** What the runtime's solver (`core/boneburst/runtime/transform.ts`) reads off a constraint, but its bones. */
export type TcSolve = Pick<TransformData, "localSource" | "localTarget" | "additive" | "clamp" | "offsets" | "properties">;

/**
 * Transform constraints (ARCHITECTURE ▸ Transform constraints): what the
 * solver reads off one, and its mix keys, as Spine's `transform` timeline
 * keys the six mixes. Before the first key the constraint's own mixes hold;
 * from a key on they tween to the next key by the key's tween.
 */

/** A property mapped to itself, each one (a pre-4.3 constraint's shape). */
export function identityProperties(channels: readonly TcChannel[] = TC_CHANNELS): TcFrom[] {
  return channels.map((c) => ({ from: c, offset: 0, to: [{ to: c, offset: 0, max: 1, scale: 1 }] }));
}

export const FULL_MIX: Readonly<TcMix> = { rotate: 1, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 };

/** What the solver reads off a constraint. */
export function tcSolveOf(k: TransformConstraint): TcSolve {
  const o = k.offsets ?? {};
  return {
    localSource: !!k.localSource,
    localTarget: !!k.localTarget,
    additive: !!k.additive,
    clamp: !!k.clamp,
    offsets: { rotate: o.rotate ?? 0, x: o.x ?? 0, y: o.y ?? 0, scaleX: o.scaleX ?? 0, scaleY: o.scaleY ?? 0, shearY: o.shearY ?? 0 },
    properties: k.properties.map((p) => ({ from: p.from, offset: p.offset, to: p.to.map((t) => ({ prop: t.to, offset: t.offset, max: t.max, scale: t.scale })) })),
  };
}

/* ── the property map (Spine 4.3's `properties`) ── */

/** A new mapping's values: the source's value straight across, no limit to speak of. */
export const NEW_MAPPING = { offset: 0, max: 100, scale: 1 } as const;

/** `props` with `from` driving `to` (added at `NEW_MAPPING` when new), `patch`
 *  applied to that mapping. Sources keep their order; a new one goes last. */
export function withMapping(props: readonly TcFrom[], from: TcChannel, to: TcChannel, patch: Partial<Omit<TcTo, "to">> = {}): TcFrom[] {
  const has = props.some((p) => p.from === from);
  const list = has ? [...props] : [...props, { from, offset: 0, to: [] }];
  return list.map((p) => {
    if (p.from !== from) return p;
    const at = p.to.find((t) => t.to === to);
    const next: TcTo = { ...(at ?? { to, ...NEW_MAPPING }), ...patch, to };
    return { ...p, to: at ? p.to.map((t) => (t.to === to ? next : t)) : [...p.to, next] };
  });
}

/** `props` without `from` driving `to`; a source left driving nothing goes. */
export function withoutMapping(props: readonly TcFrom[], from: TcChannel, to: TcChannel): TcFrom[] {
  return props
    .map((p) => (p.from === from ? { ...p, to: p.to.filter((t) => t.to !== to) } : p))
    .filter((p) => p.to.length > 0);
}

/** `props` with what is added to source property `from` before it is mapped. */
export function withSourceOffset(props: readonly TcFrom[], from: TcChannel, offset: number): TcFrom[] {
  return props.map((p) => (p.from === from ? { ...p, offset } : p));
}

/** Whether every property drives itself, unscaled and unshifted: the map a
 *  constraint made here has, which Properties need not show. */
export function isIdentityMap(props: readonly TcFrom[]): boolean {
  return props.every((p) => p.to.length === 1 && p.to[0]!.to === p.from && p.to[0]!.scale === 1 && !p.to[0]!.offset && !p.offset);
}

/** The target properties some source property maps to: the mixes that matter. */
export function usedMixes(k: TransformConstraint): TcChannel[] {
  const used = new Set(k.properties.flatMap((p) => p.to.map((t) => t.to)));
  return TC_CHANNELS.filter((c) => used.has(c));
}

/** The mixes in force at `frame` (fractional between frames). */
export function tcMixAt(k: TransformConstraint, anim: Animation | null | undefined, frame: number): TcMix {
  const s = keySpan(anim?.transforms?.[k.id], frame);
  if (!s) return { ...k.mix };
  const { a, b, e } = s;
  if (!b) return { ...a.mix };
  const out = { ...a.mix };
  for (const c of TC_CHANNELS) out[c] = a.mix[c] + (b.mix[c] - a.mix[c]) * e;
  return out;
}

/** `keys` with a key at `frame` holding `mix`; a key already there keeps its tween. */
export function withTcKey(keys: readonly TcKey[], frame: number, mix: TcMix): TcKey[] {
  return withKeyAt(keys, frame, (at): TcKey => ({ ...at, frame, mix: { ...mix } }));
}

/** A name not taken by a transform constraint of `sym`: `base`, `base 2`… */
export function uniqueTransformName(sym: SymbolItem, base: string): string {
  const taken = new Set((sym.transforms ?? []).map((k) => k.name));
  const b = base.trim() || "transform";
  if (!taken.has(b)) return b;
  for (let i = 2; ; i++) if (!taken.has(`${b} ${i}`)) return `${b} ${i}`;
}

/**
 * The transform constraint that makes `boneIds` follow `sourceId`, or why
 * not: the source among its own bones, or no bones. Every property maps to
 * itself at full mix with no offsets, so the bones take the source's world
 * transform, as a new constraint does in Spine.
 */
export function transformPlan(
  sym: SymbolItem, boneIds: readonly NodeId[], sourceId: NodeId, id: TcId,
): TransformConstraint | { refused: string } {
  const source = sym.nodes[sourceId];
  if (!source) return { refused: "There is no such source bone." };
  const bones = [...new Set(boneIds)].filter((b) => b !== sourceId && sym.nodes[b]);
  if (boneIds.includes(sourceId) && !bones.length) return { refused: `${source.name} cannot follow itself.` };
  if (!bones.length) return { refused: "Select the bones that are to follow, then choose the source." };
  return {
    id, name: uniqueTransformName(sym, `${source.name}_transform`), boneIds: bones, sourceId,
    mix: { ...FULL_MIX }, properties: identityProperties(),
  };
}
