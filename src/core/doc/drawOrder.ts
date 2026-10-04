import type { NodeId } from "./ids";
import type { Animation, DrawOrderKey, SymbolItem } from "./types";

/**
 * Draw order keys, as Spine's Draw order row has them: from a key's frame on,
 * the symbol's drawing layers draw in that key's order. A key holds a whole
 * order (back to front), not Spine's offsets, so it survives layers being
 * added, removed or restacked; offsets exist only in the file
 * (`toOffsets`, `fromOffsets`).
 */

/** The layers that draw, back to front: the stack bottom up, without groups
 *  and bones, which draw nothing. */
export function drawingLayers(sym: SymbolItem): NodeId[] {
  return [...sym.layers].reverse()
    .map((l) => sym.nodes[l.nodeId])
    .filter((n) => !!n && n.kind !== "group" && n.kind !== "bone")
    .map((n) => n!.id);
}

/**
 * `order` over `setup`: ids no longer drawing are dropped, and a drawing
 * layer the order does not list goes back beside the layer below it in the
 * setup order (or to the back), so a new layer appears where it was stacked.
 */
export function withOrder(order: readonly NodeId[], setup: readonly NodeId[]): NodeId[] {
  const known = new Set(setup);
  const out = order.filter((id, i) => known.has(id) && order.indexOf(id) === i);
  const placed = new Set(out);
  setup.forEach((id, i) => {
    if (placed.has(id)) return;
    const below = i > 0 ? out.indexOf(setup[i - 1]!) : -1;
    out.splice(below + 1, 0, id);
    placed.add(id);
  });
  return out;
}

/** The key in force at `frame`: the last at or before it. */
export function drawOrderKeyAt(anim: Animation | null | undefined, frame: number): DrawOrderKey | null {
  let found: DrawOrderKey | null = null;
  for (const k of anim?.drawOrder ?? []) {
    if (k.frame <= frame) found = k;
    else break;
  }
  return found;
}

/**
 * The drawing layers in units that move as one, back to front: a mask and the
 * layers it clips are one (Spine clips from the mask's slot to the last
 * clipped one, so they stay together); every other layer is its own.
 */
export function drawUnits(sym: SymbolItem): NodeId[][] {
  const setup = drawingLayers(sym);
  const maskOf = new Map<NodeId, NodeId>();
  for (const l of sym.layers) {
    const mask = l.maskedBy ? sym.layers.find((m) => m.id === l.maskedBy) : undefined;
    if (mask) { maskOf.set(l.nodeId, mask.nodeId); maskOf.set(mask.nodeId, mask.nodeId); }
  }
  const units: NodeId[][] = [];
  const byMask = new Map<NodeId, NodeId[]>();
  for (const id of setup) {
    const mask = maskOf.get(id);
    if (!mask) { units.push([id]); continue; }
    let unit = byMask.get(mask);
    if (!unit) { unit = []; byMask.set(mask, unit); units.push(unit); }
    unit.push(id);
  }
  return units;
}

/**
 * The drawing layers' order at `frame`, back to front: the key's order, each
 * unit (`drawUnits`) where the first of its layers is in it and in its own
 * setup order inside.
 */
export function orderAt(sym: SymbolItem, anim: Animation | null | undefined, frame: number): NodeId[] {
  const units = drawUnits(sym);
  const key = drawOrderKeyAt(anim, frame);
  if (!key?.order) return units.flat();
  const rank = new Map(withOrder(key.order, units.flat()).map((id, i) => [id, i]));
  const at = (u: NodeId[]) => Math.min(...u.map((id) => rank.get(id)!));
  return [...units].sort((a, b) => at(a) - at(b)).flat();
}

/**
 * Spine's encoding of an order: for each slot whose place differs from its
 * setup place, in setup order, how far it moved. Every moved slot is listed,
 * so the slots left out fill the remaining places in setup order, which is
 * what `SkeletonJson` does with them. Empty when nothing moved.
 */
export function toOffsets<T>(order: readonly T[], setup: readonly T[]): Array<{ item: T; offset: number }> {
  const at = new Map(order.map((s, i) => [s, i]));
  const out: Array<{ item: T; offset: number }> = [];
  setup.forEach((s, i) => {
    const j = at.get(s);
    if (j !== undefined && j !== i) out.push({ item: s, offset: j - i });
  });
  return out;
}

/** `SkeletonJson`'s reading of offsets over the setup order. Null when they
 *  do not make an order (two slots on one place, one off the end). */
export function fromOffsets<T>(offsets: ReadonlyArray<{ item: T; offset: number }>, setup: readonly T[]): T[] | null {
  const n = setup.length;
  const index = new Map(setup.map((s, i) => [s, i]));
  const draw: number[] = new Array(n).fill(-1);
  const unchanged: number[] = [];
  let original = 0;
  const sorted = [...offsets].filter((o) => index.has(o.item)).sort((a, b) => index.get(a.item)! - index.get(b.item)!);
  for (const o of sorted) {
    const slot = index.get(o.item)!;
    while (original !== slot) unchanged.push(original++);
    const to = original + o.offset;
    if (to < 0 || to >= n || draw[to] !== -1) return null;
    draw[to] = original++;
  }
  while (original < n) unchanged.push(original++);
  for (let i = n - 1; i >= 0; i--) if (draw[i] === -1) draw[i] = unchanged.pop()!;
  return draw.map((i) => setup[i]!);
}

export type Reorder = "forward" | "backward" | "front" | "back";

/** `ids` moved one place toward the front or back, or all the way, keeping
 *  their order among themselves. */
export function reordered(order: readonly NodeId[], ids: readonly NodeId[], how: Reorder): NodeId[] {
  const pick = new Set(ids);
  const moving = order.filter((id) => pick.has(id));
  if (!moving.length) return [...order];
  const rest = order.filter((id) => !pick.has(id));
  if (how === "front") return [...rest, ...moving];
  if (how === "back") return [...moving, ...rest];
  const out = [...order];
  // One step: each picked layer swaps with the unpicked neighbour on that side.
  if (how === "forward") {
    for (let i = out.length - 2; i >= 0; i--) {
      if (pick.has(out[i]!) && !pick.has(out[i + 1]!)) [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (pick.has(out[i]!) && !pick.has(out[i - 1]!)) [out[i], out[i - 1]] = [out[i - 1]!, out[i]!];
    }
  }
  return out;
}

/** The keys with one at `frame` holding `order`, replacing any there. An
 *  order that is the setup order is stored as no order. */
export function withDrawOrderKey(
  keys: readonly DrawOrderKey[], frame: number, order: readonly NodeId[] | null, setup: readonly NodeId[],
): DrawOrderKey[] {
  const out = keys.filter((k) => k.frame !== frame);
  out.push(order && !sameOrder(order, setup) ? { frame, order: [...order] } : { frame });
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

export function sameOrder(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The keys at `frames` moved by `delta` frames, onto any key already there. */
export function moveDrawOrderKeys(keys: readonly DrawOrderKey[], frames: readonly number[], delta: number): DrawOrderKey[] {
  const pick = new Set(frames);
  const moved = keys.filter((k) => pick.has(k.frame)).map((k) => ({ ...k, frame: Math.max(0, k.frame + delta) }));
  const landed = new Set(moved.map((k) => k.frame));
  return [...keys.filter((k) => !pick.has(k.frame) && !landed.has(k.frame)), ...moved].sort((a, b) => a.frame - b.frame);
}

export function deleteDrawOrderKeys(keys: readonly DrawOrderKey[], frames: readonly number[]): DrawOrderKey[] {
  const pick = new Set(frames);
  return keys.filter((k) => !pick.has(k.frame));
}

/** What a reorder of the selection moves: its drawing layers, and for a
 *  bone or group the drawing layers that hang directly on it. */
export function reorderTargets(sym: SymbolItem, ids: readonly NodeId[]): NodeId[] {
  const drawing = new Set(drawingLayers(sym));
  const pick = new Set(ids);
  return [...drawing].filter((id) => {
    const n = sym.nodes[id]!;
    return pick.has(id) || (!!n.parentId && pick.has(n.parentId)) || (!!n.slotBone && pick.has(n.slotBone));
  });
}

/**
 * The keys after `ids` are moved `how` at `frame`: the order in force there,
 * reordered, keyed at that frame (Spine keys a draw order change where it is
 * made). Null when nothing would change.
 */
export function reorderAt(
  sym: SymbolItem, anim: Animation, frame: number, ids: readonly NodeId[], how: Reorder,
): DrawOrderKey[] | null {
  const before = orderAt(sym, anim, frame);
  const next = reordered(before, reorderTargets(sym, ids), how);
  if (sameOrder(before, next)) return null;
  return withDrawOrderKey(anim.drawOrder ?? [], frame, next, drawingLayers(sym));
}

/** `order` with `front` (front first) drawing in that order in the places
 *  they hold; every other layer keeps its place. */
export function withFront(order: readonly NodeId[], front: readonly NodeId[]): NodeId[] {
  const pick = new Set(front);
  const places = order.map((id, i) => (pick.has(id) ? i : -1)).filter((i) => i >= 0);
  const backFirst = front.filter((id, i) => order.includes(id) && front.indexOf(id) === i).reverse();
  const out = [...order];
  places.forEach((at, n) => { out[at] = backFirst[n]!; });
  return out;
}
