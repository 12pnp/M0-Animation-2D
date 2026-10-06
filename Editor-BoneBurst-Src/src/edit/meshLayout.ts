import type { Animation, Attachment, Key, Skeleton } from "@/model/skeleton";
import type { AttachmentRef } from "./attachments";
import { EditRefused } from "./history";

/**
 * A mesh's vertex layout (Format-Json-Atlas.md §8.9) and what the geometry and weight edits
 * share: unweighted x,y pairs in the slot's bone space, or per vertex its bones with a bind
 * position and a weight each. Positions here are always in the slot's bone space on the setup
 * pose, so an unweighted mesh needs no bone matrices; a weighted one needs the setup pose's.
 */

/** Each bone's world matrix on the setup pose, [a, b, c, d, x, y], by the skeleton's bone index. */
export type BoneWorlds = readonly (readonly number[])[];

/** One bone's hold on a vertex: the vertex in that bone's space, and its weight. */
export interface Bind { readonly bone: number; readonly x: number; readonly y: number; readonly w: number }

export const isWeighted = (a: Attachment) => !!a.vertices && !!a.uvs && a.vertices.length !== a.uvs.length;

/** A weighted `vertices` array as each vertex's binds. */
export function decodeBinds(v: readonly number[]): Bind[][] {
  const out: Bind[][] = [];
  for (let i = 0; i < v.length;) {
    const n = v[i++]!, binds: Bind[] = [];
    for (let k = 0; k < n; k++, i += 4) binds.push({ bone: v[i]!, x: v[i + 1]!, y: v[i + 2]!, w: v[i + 3]! });
    out.push(binds);
  }
  return out;
}

export function encodeBinds(binds: readonly (readonly Bind[])[]): number[] {
  return binds.flatMap((b) => [b.length, ...b.flatMap((x) => [x.bone, x.x, x.y, x.w])]);
}

/** Where things are, for a mesh: its slot's bone and the setup bones (null for an unweighted mesh). */
export interface Frame {
  readonly slot: readonly number[];
  readonly bones: BoneWorlds;
}

/** The frame of the mesh at `r`; refused when it is weighted and no setup bones were given. */
export function frameFor(s: Skeleton, r: AttachmentRef, a: Attachment, bones: BoneWorlds | undefined): Frame | null {
  if (!isWeighted(a) && !bones) return null;
  if (!bones) throw new EditRefused(`"${r.key}" is bound to bones; its vertices are edited on the setup pose.`);
  const slotBone = s.slots?.find((x) => x.name === r.slot)?.bone;
  const i = (s.bones ?? []).findIndex((b) => b.name === slotBone);
  if (i < 0 || !bones[i]) throw new EditRefused(`The slot "${r.slot}" has no bone.`);
  // A bone posed as all zeros (not active in the skin shown) or scaled to zero has no inverse: its
  // vertices came out NaN, or silently at its origin (E7-PLAN step 4). The slot's bone, and every
  // bone a weighted mesh is bound to, must be usable.
  const used = isWeighted(a) ? [i, ...new Set(decodeBinds(a.vertices!).flatMap((b) => b.map((x) => x.bone)))] : [i];
  for (const k of used) {
    const m = bones[k];
    if (!m || !m.every(Number.isFinite) || Math.abs(m[0]! * m[3]! - m[1]! * m[2]!) < 1e-12) {
      throw new EditRefused(`"${r.key}" cannot be edited here: its bone "${s.bones?.[k]?.name ?? k}" is not active in the skin shown, or scaled to zero.${r.skin !== "default" ? ` Show the skin "${r.skin}" to edit it.` : ""}`);
    }
  }
  return { slot: bones[i]!, bones };
}

const apply = (m: readonly number[], x: number, y: number): [number, number] => [m[0]! * x + m[1]! * y + m[4]!, m[2]! * x + m[3]! * y + m[5]!];

/** A world point in the space of the bone with world matrix `m`. */
export function toLocal(m: readonly number[], x: number, y: number): [number, number] {
  const [a, b, c, d, wx, wy] = m as [number, number, number, number, number, number], det = a * d - b * c, dx = x - wx, dy = y - wy;
  return [(d * dx - b * dy) / det, (a * dy - c * dx) / det];
}

/** A direction (no translation) through the inverse of `m`'s linear part. */
function linearInverse(m: readonly number[], x: number, y: number): [number, number] {
  const [a, b, c, d] = m as [number, number, number, number], det = a * d - b * c;
  return [(d * x - b * y) / det, (a * y - c * x) / det];
}

/** Every vertex in the slot's bone space on the setup pose. */
export function positions(a: Attachment, f: Frame | null): number[] {
  if (!isWeighted(a)) return [...a.vertices!];
  const out: number[] = [];
  for (const binds of decodeBinds(a.vertices!)) {
    let x = 0, y = 0;
    for (const b of binds) { const [wx, wy] = apply(f!.bones[b.bone]!, b.x, b.y); x += wx * b.w; y += wy * b.w; }
    out.push(...toLocal(f!.slot, x, y));
  }
  return out;
}

/** Binds with the given bones and weights, placed at slot-space (x, y) on the setup pose. */
export function bindAt(f: Frame, weights: readonly { bone: number; w: number }[], x: number, y: number): Bind[] {
  const [wx, wy] = apply(f.slot, x, y);
  return weights.map(({ bone, w }) => { const [bx, by] = toLocal(f.bones[bone]!, wx, wy); return { bone, x: round(bx, 4), y: round(by, 4), w }; });
}

/** Each vertex's slice of a deform key's offsets (flat, in `a`'s layout): x,y per bind, or one x,y. */
function perVertex(a: Attachment, flat: readonly number[]): number[][] {
  if (!isWeighted(a)) return Array.from({ length: a.vertices!.length / 2 }, (_, v) => [flat[v * 2] ?? 0, flat[v * 2 + 1] ?? 0]);
  let k = 0;
  return decodeBinds(a.vertices!).map((binds) => { const out = flat.slice(k, k + binds.length * 2); k += binds.length * 2; return [...out]; });
}

/**
 * One vertex's deform offset in the slot's bone space on the setup pose: an unweighted mesh's is
 * that already; a weighted one's is the weighted sum of its binds' offsets turned by their bones
 * (§11.10).
 */
function toSlot(binds: readonly Bind[] | null, offsets: readonly number[], f: Frame | null): [number, number] {
  if (!binds) return [offsets[0] ?? 0, offsets[1] ?? 0];
  let x = 0, y = 0;
  binds.forEach((b, k) => {
    const m = f!.bones[b.bone]!, ox = offsets[k * 2] ?? 0, oy = offsets[k * 2 + 1] ?? 0;
    x += (m[0]! * ox + m[1]! * oy) * b.w;
    y += (m[2]! * ox + m[3]! * oy) * b.w;
  });
  return linearInverse(f!.slot, x, y);
}

/** A slot-space offset written for one vertex: each bind gets it in its bone's space. */
function fromSlot(binds: readonly Bind[] | null, x: number, y: number, f: Frame | null): number[] {
  if (!binds) return [x, y];
  const s = f!.slot, wx = s[0]! * x + s[1]! * y, wy = s[2]! * x + s[3]! * y;
  return binds.flatMap((b) => linearInverse(f!.bones[b.bone]!, wx, wy));
}

/** The deform array's length in `a`'s layout. */
export const deformLength = (a: Attachment) => (isWeighted(a) ? (decodeBinds(a.vertices!).reduce((n, b) => n + b.length, 0) * 2) : a.vertices!.length);

/** Where a new vertex comes from: an old vertex, or a blend of old ones (index, share). */
export type Source = number | readonly (readonly [number, number])[];

const sameBinds = (p: readonly Bind[] | null, q: readonly Bind[] | null) =>
  p === q || (!!p && !!q && p.length === q.length && p.every((b, k) => b.bone === q[k]!.bone && b.w === q[k]!.w && b.x === q[k]!.x && b.y === q[k]!.y));

/**
 * Rewrite every deform key of the mesh at `r` (and of the linked meshes that take it as their
 * source) from the layout of `before` to that of `after`, vertex by vertex as `sources` says. A
 * vertex whose binds did not change keeps its offsets as written; any other is given the offset
 * its sources gave on the setup pose, in its new binds. Written from the first value that is not
 * 0 to the last.
 */
export function rewriteDeform(s: Skeleton, r: AttachmentRef, before: Attachment, after: Attachment, f: Frame | null, sources: readonly Source[]): Skeleton {
  const oldBinds = isWeighted(before) ? decodeBinds(before.vertices!) : null, newBinds = isWeighted(after) ? decodeBinds(after.vertices!) : null;
  return remapDeform(s, r, deformLength(before), (flat) => {
    const per = perVertex(before, flat);
    return sources.flatMap((src, v) => {
      const mine = newBinds?.[v] ?? null;
      if (typeof src === "number" && sameBinds(oldBinds?.[src] ?? null, mine)) return per[src]!;
      const parts = typeof src === "number" ? [[src, 1] as const] : src;
      let x = 0, y = 0;
      for (const [o, t] of parts) { const [ox, oy] = toSlot(oldBinds?.[o] ?? null, per[o]!, f); x += ox * t; y += oy * t; }
      return fromSlot(mine, x, y, f);
    });
  });
}

function remapDeform(s: Skeleton, r: AttachmentRef, length: number, f: (offsets: number[]) => number[]): Skeleton {
  const targets = new Set([`${r.skin}/${r.slot}/${r.key}`]);
  for (const k of s.skins ?? []) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
    const a = e.attachment;
    if (a.source === r.key && (a.slot ?? ss.slot) === r.slot && (a.skin ?? "default") === r.skin) targets.add(`${k.name}/${ss.slot}/${e.key}`);
  }
  if (!s.animations) return s;
  const key = (k: Key): Key => {
    if (k.vertices === undefined) return k;
    const full = new Array<number>(length).fill(0);
    k.vertices.forEach((v, n) => { const at = (k.offset ?? 0) + n; if (at < length) full[at] = v; });
    const next = f(full).map((v) => (Math.abs(v) < 1e-9 ? 0 : v));
    const first = next.findIndex((v) => v !== 0);
    const { vertices: _v, offset: _o, ...rest } = k;
    if (first < 0) return rest as Key;
    let last = next.length - 1;
    while (next[last] === 0) last--;
    return { ...rest, ...(first ? { offset: first } : {}), vertices: next.slice(first, last + 1) } as Key;
  };
  return {
    ...s,
    animations: s.animations.map((an): Animation => (!an.attachments ? an : {
      ...an,
      attachments: an.attachments.map((st) => ({
        ...st,
        slots: st.slots.map((sl) => ({
          ...sl,
          attachments: sl.attachments.map((g) => (!targets.has(`${st.skin}/${sl.slot}/${g.name}`) ? g : {
            ...g, timelines: g.timelines.map((tl) => (tl.name !== "deform" ? tl : { ...tl, keys: tl.keys.map(key) })),
          })),
        })),
      })),
    })),
  };
}

export function round(n: number, places: number): number {
  const k = 10 ** places, v = Math.round(n * k) / k;
  return v === 0 ? 0 : v;
}
