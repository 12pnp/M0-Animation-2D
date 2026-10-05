import type { Attachment, Skeleton } from "@/model/skeleton";
import { type AttachmentRef, replaceAttachment } from "./attachments";
import { EditRefused, type Edit } from "./history";
import { editableMesh, normaliseWeights } from "./mesh";
import { type Bind, bindAt, type BoneWorlds, decodeBinds, encodeBinds, type Frame, frameFor, isWeighted, positions, rewriteDeform, round } from "./meshLayout";

/**
 * Weight edits (E4-PLAN step 6; Format-Json-Atlas.md §8.9): binding a mesh to bones, changing a
 * vertex's weights, weighting again by distance, unbinding. All on the setup pose, whose bones'
 * world matrices the caller gives; every vertex keeps its place there, and deform keys keep the
 * offsets they gave there.
 */

function boneIndex(s: Skeleton, name: string): number {
  const i = (s.bones ?? []).findIndex((b) => b.name === name);
  if (i < 0) throw new EditRefused(`There is no bone "${name}".`);
  return i;
}

/** The bones a weighted mesh follows, by index, in the order they first appear. */
export function meshBones(a: Attachment): number[] {
  if (!isWeighted(a)) return [];
  return [...new Set(decodeBinds(a.vertices!).flatMap((b) => b.map((x) => x.bone)))];
}

/** The distance from world (x, y) to a bone's segment, origin to tip, on the setup pose. */
function boneDistance(s: Skeleton, bones: BoneWorlds, bone: number, x: number, y: number): number {
  const m = bones[bone]!, len = s.bones![bone]!.length ?? 0;
  const x0 = m[4]!, y0 = m[5]!, dx = m[0]! * len, dy = m[2]! * len, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

/** Weights by distance: each bone 1 / (d + 1)⁴, then the four heaviest, normalised. */
export function distanceWeights(s: Skeleton, bones: BoneWorlds, chosen: readonly number[], x: number, y: number): { bone: number; w: number }[] {
  return normaliseWeights(chosen.map((bone) => ({ bone, w: 1 / (boneDistance(s, bones, bone, x, y) + 1) ** 4 })));
}

/** A slot-space point in the world, through the slot's bone. */
const world = (f: Frame, x: number, y: number): [number, number] => [f.slot[0]! * x + f.slot[1]! * y + f.slot[4]!, f.slot[2]! * x + f.slot[3]! * y + f.slot[5]!];

/** The mesh with each vertex bound as `weigh` says, at its setup place; deform keys kept. */
function rebind(s: Skeleton, r: AttachmentRef, a: Attachment, f: Frame, weigh: (v: number, wx: number, wy: number, old: readonly Bind[] | null) => { bone: number; w: number }[]): Skeleton {
  const pos = positions(a, f), old = isWeighted(a) ? decodeBinds(a.vertices!) : null;
  const binds = Array.from({ length: pos.length / 2 }, (_, v) => {
    const x = pos[v * 2]!, y = pos[v * 2 + 1]!, [wx, wy] = world(f, x, y), was = old?.[v] ?? null;
    const ws = weigh(v, wx, wy, was);
    // Unchanged weights keep the binds as written, so an untouched vertex is not rewritten.
    if (was && was.length === ws.length && was.every((b, k) => b.bone === ws[k]!.bone && b.w === ws[k]!.w)) return was;
    return bindAt(f, ws, x, y);
  });
  const next: Attachment = { ...a, vertices: encodeBinds(binds) };
  return rewriteDeform(replaceAttachment(s, r, next), r, a, next, f, Array.from({ length: pos.length / 2 }, (_, v) => v));
}

/** Bind the mesh to `boneNames` with weights by distance (a weighted mesh is bound afresh). */
export function bindMesh(r: AttachmentRef, boneNames: readonly string[], bones: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r), f = frameFor(s, r, a, bones)!;
    if (!boneNames.length) throw new EditRefused("Choose at least one bone to bind the mesh to.");
    const chosen = [...new Set(boneNames)].map((n) => boneIndex(s, n));
    return rebind(s, r, a, f, (_v, wx, wy) => distanceWeights(s, bones, chosen, wx, wy));
  };
}

/** Weight the given vertices (all when omitted) again by distance, over the bones the mesh follows. */
export function autoWeights(r: AttachmentRef, bones: BoneWorlds, vertices?: readonly number[]): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r);
    if (!isWeighted(a)) throw new EditRefused(`"${r.key}" is not bound to bones; bind it first.`);
    const f = frameFor(s, r, a, bones)!, chosen = meshBones(a), only = vertices ? new Set(vertices) : null;
    const out = rebind(s, r, a, f, (v, wx, wy, old) => (only && !only.has(v) ? old!.map((b) => ({ bone: b.bone, w: b.w })) : distanceWeights(s, bones, chosen, wx, wy)));
    return sameVertices(out, s, r) ? s : out;
  };
}

/** Add `bone` to the bones the mesh follows and weight it again by distance; remove one the same way. */
export function setMeshBone(r: AttachmentRef, bone: string, on: boolean, bones: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r), i = boneIndex(s, bone), now = meshBones(a);
    if (now.includes(i) === on) return s;
    const next = on ? [...now, i] : now.filter((b) => b !== i);
    if (!next.length) throw new EditRefused("A bound mesh follows at least one bone; Unbind frees it.");
    return bindMesh(r, next.map((b) => s.bones![b]!.name), bones)(s);
  };
}

/** Unbind the mesh: each vertex in the slot's bone space where the setup pose has it. */
export function unbindMesh(r: AttachmentRef, bones: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r);
    if (!isWeighted(a)) return s;
    const f = frameFor(s, r, a, bones)!;
    const pos = positions(a, f), next: Attachment = { ...a, vertices: pos.map((n) => round(n, 4)) };
    return rewriteDeform(replaceAttachment(s, r, next), r, a, next, f, Array.from({ length: pos.length / 2 }, (_, v) => v));
  };
}

/**
 * Set `bone`'s weight on vertex `v` to `w` (0..1); the vertex's other bones share the rest in
 * their old proportion. 0 takes the bone off the vertex (not its last bone); a bone not yet on it
 * joins it.
 */
export function setWeight(r: AttachmentRef, v: number, bone: string, w: number, bones: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r);
    if (!isWeighted(a)) throw new EditRefused(`"${r.key}" is not bound to bones; bind it first.`);
    if (!(w >= 0 && w <= 1)) throw new EditRefused("A weight is between 0 and 1.");
    const binds = decodeBinds(a.vertices!);
    if (!(v >= 0 && v < binds.length)) throw new EditRefused(`The mesh has no vertex ${v}.`);
    const i = boneIndex(s, bone), mine = binds[v]!, others = mine.filter((b) => b.bone !== i);
    const rest = others.reduce((n, b) => n + b.w, 0);
    if (w === 0 && !others.length) throw new EditRefused(`"${bone}" is this vertex's only bone; give another bone weight first.`);
    if (w < 1 && !(rest > 0)) throw new EditRefused(`No other bone holds this vertex to take the rest; add one first.`);
    const ws = [...(w > 0 ? [{ bone: i, w }] : []), ...others.map((b) => ({ bone: b.bone, w: (b.w / rest) * (1 - w) }))];
    const f = frameFor(s, r, a, bones)!;
    const out = rebind(s, r, a, f, (n, _x, _y, old) => (n === v ? normaliseWeights(ws) : old!.map((b) => ({ bone: b.bone, w: b.w }))));
    return sameVertices(out, s, r) ? s : out;
  };
}

/** Whether the mesh at `r` has the same vertices in both documents (an edit that changed nothing). */
function sameVertices(a: Skeleton, b: Skeleton, r: AttachmentRef): boolean {
  const x = editableMesh(a, r).vertices!, y = editableMesh(b, r).vertices!;
  return x.length === y.length && x.every((n, i) => n === y[i]);
}
