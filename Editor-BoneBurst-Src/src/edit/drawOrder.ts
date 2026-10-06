import type { Animation, DrawOrderOffset, Key } from "@/model/skeleton";

/**
 * Draw order keys hold offsets from the setup order (Format-Json-Atlas.md §11.11–11.12), so a
 * change to the slots — added, deleted, renamed or reordered — changes what every key means.
 * These keep the meaning: a key's order is rebuilt by name from the old slots, then written as
 * offsets against the new ones.
 */

/** The slots in the order a key draws them, by name (§11.11's order array). */
export function orderOf(slots: readonly string[], offsets: readonly DrawOrderOffset[] | undefined): string[] {
  const n = slots.length;
  if (!offsets) return [...slots];
  const order = new Array<number>(n).fill(-1);
  const unchanged: number[] = [];
  let orig = 0;
  for (const o of offsets) {
    const pos = o.slot === undefined ? -1 : slots.indexOf(o.slot);
    if (pos < 0) continue;
    while (orig !== pos) unchanged.push(orig++);
    const at = orig + (o.offset ?? 0);
    if (at >= 0 && at < n) order[at] = orig;
    orig++;
  }
  while (orig < n) unchanged.push(orig++);
  for (let i = n - 1; i >= 0; i--) if (order[i] === -1) order[i] = unchanged.pop() ?? -1;
  return order.filter((i) => i >= 0).map((i) => slots[i]!);
}

/** Offsets that draw `slots` in `order` (a permutation of them): every slot not at its own place,
 *  ascending by setup position. */
export function offsetsFor(slots: readonly string[], order: readonly string[]): DrawOrderOffset[] {
  const out: DrawOrderOffset[] = [];
  slots.forEach((slot, i) => {
    const p = order.indexOf(slot);
    if (p >= 0 && p !== i) out.push({ slot, offset: p - i, extra: new Map() });
  });
  return out;
}

/**
 * `order` (old slots, by name) as an order of `next`: names gone are dropped, renamed ones
 * followed, and slots new to `next` placed just after the slot before them in `next`'s setup order.
 */
function carry(order: readonly string[], next: readonly string[], rename: ReadonlyMap<string, string>): string[] {
  const kept = order.map((s) => rename.get(s) ?? s).filter((s) => next.includes(s));
  for (const [i, s] of next.entries()) {
    if (kept.includes(s)) continue;
    const before = next.slice(0, i).reverse().find((x) => kept.includes(x));
    kept.splice(before === undefined ? 0 : kept.indexOf(before) + 1, 0, s);
  }
  return kept;
}

function rekey(keys: readonly Key[], from: readonly string[], to: readonly string[], rename: ReadonlyMap<string, string>): Key[] {
  return keys.map((k) => {
    if (k.offsets === undefined) return k;
    return { ...k, offsets: offsetsFor(to, carry(orderOf(from, k.offsets), to, rename)) } as Key;
  });
}

/** The animation's draw order and draw order folder keys for slots going from `from` to `to`
 *  (setup order, by name); `rename` maps old names to new. */
export function remapDrawOrder(a: Animation, from: readonly string[], to: readonly string[], rename: ReadonlyMap<string, string> = new Map()): Animation {
  if (!a.drawOrder && !a.drawOrderFolder) return a;
  let out = a;
  if (a.drawOrder) out = { ...out, drawOrder: rekey(a.drawOrder, from, to, rename) };
  if (a.drawOrderFolder) {
    const folders = a.drawOrderFolder.flatMap((f) => {
      const old = f.slots ?? [];
      // The folder's slots, in the new setup order (§11.12: they are listed in setup order).
      const names = old.map((s) => rename.get(s) ?? s).filter((s) => to.includes(s)).sort((x, y) => to.indexOf(x) - to.indexOf(y));
      if (!names.length) return [];
      return [{ ...f, slots: names, ...(f.keys ? { keys: rekey(f.keys, old, names, rename) } : {}) }];
    });
    if (folders.length) out = { ...out, drawOrderFolder: folders };
    else { const { drawOrderFolder: _, ...rest } = out; out = rest as Animation; }
  }
  return out;
}

/** The slots' order (back to front) at `time` in `a`: the last draw order key at or before it, else the setup order. */
export function drawOrderAt(a: Animation, slots: readonly string[], time: number): string[] {
  const k = [...(a.drawOrder ?? [])].reverse().find((x) => (x.time ?? 0) <= time + 1e-5);
  return orderOf(slots, k?.offsets);
}

/**
 * `order` with the slots in `front` (front first) moved into the places they hold in it, in that
 * order; every other slot keeps its place (E5 step 4: key_draw_order).
 */
export function reorderFront(order: readonly string[], front: readonly string[]): string[] {
  const places = order.map((s, i) => (front.includes(s) ? i : -1)).filter((i) => i >= 0);
  const out = [...order];
  // Places ascend back to front, so the front-most of `front` takes the last place.
  [...front].reverse().forEach((s, j) => { out[places[j]!] = s; });
  return out;
}
