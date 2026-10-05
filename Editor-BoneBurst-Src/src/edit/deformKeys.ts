import { attachmentType, type Attachment, type Skeleton } from "@/model/skeleton";
import { type AttachmentRef, findAttachment } from "./attachments";
import { EditRefused, type Edit } from "./history";
import { setKey } from "./keys";
import { type BoneWorlds, decodeBinds, isWeighted, round, toLocal } from "./meshLayout";

/**
 * Deform keys (E4-PLAN step 11; Format-Json-Atlas.md §11.10): a mesh's vertices keyed at a time,
 * as offsets from its setup vertices: x,y per vertex for an unweighted mesh, x,y per bone
 * influence for a weighted one. Written from the first value that is not 0 to the last.
 */

/** Key the mesh at `r` with `offsets` (the whole mesh, in its layout) at `time`. */
export function keyDeform(animation: string, r: AttachmentRef, time: number, offsets: readonly number[]): Edit<Skeleton> {
  return (s) => {
    const a = findAttachment(s, r);
    if (!a || !["mesh", "linkedmesh"].includes(attachmentType(a))) throw new EditRefused(`"${r.key}" is not a mesh; only meshes take deform keys.`);
    if (a.source !== undefined) throw new EditRefused(`"${r.key}" is linked to "${a.source}": key that mesh's deforms.`);
    const values = offsets.map((v) => round(v, 4));
    const first = values.findIndex((v) => v !== 0);
    let last = values.length - 1;
    while (last >= 0 && values[last] === 0) last--;
    const fields = first < 0 ? {} : { ...(first ? { offset: first } : {}), vertices: values.slice(first, last + 1) };
    const path = { section: "attachments" as const, skin: r.skin, slot: r.slot, attachment: r.key, timeline: "deform" };
    return setKey(animation, path, time, fields, first < 0 ? ["offset", "vertices"] : first ? [] : ["offset"])(s);
  };
}

/**
 * The mesh's deform offsets with vertex `i` moved to world (`wx`, `wy`), the others as they are.
 * `current` is the slot's deform now (the engine's: positions for an unweighted mesh, per-bind
 * offsets for a weighted one; null for none); `bones` the bones' world matrices now. An unweighted
 * vertex goes where the pointer is in its slot's bone space; a weighted one moves by the same
 * world offset through each of its bones.
 */
export function deformWithVertexAt(a: Attachment, current: ArrayLike<number> | null, bones: BoneWorlds, slotBone: number, i: number, wx: number, wy: number): number[] {
  const setup = a.vertices!;
  if (!isWeighted(a)) {
    const abs = current ? Array.from(current) : [...setup];
    const [lx, ly] = toLocal(bones[slotBone]!, wx, wy);
    abs[i * 2] = lx; abs[i * 2 + 1] = ly;
    return abs.map((v, k) => v - setup[k]!);
  }
  const binds = decodeBinds(setup);
  const total = binds.reduce((n, b) => n + b.length, 0) * 2;
  const off = current ? Array.from(current) : new Array<number>(total).fill(0);
  let k = 0;
  for (let v = 0; v < i; v++) k += binds[v]!.length * 2;
  // Where the vertex is now, and how far it goes.
  let x = 0, y = 0;
  binds[i]!.forEach((b, j) => {
    const m = bones[b.bone]!, bx = b.x + off[k + j * 2]!, by = b.y + off[k + j * 2 + 1]!;
    x += (m[0]! * bx + m[1]! * by + m[4]!) * b.w;
    y += (m[2]! * bx + m[3]! * by + m[5]!) * b.w;
  });
  const dx = wx - x, dy = wy - y;
  binds[i]!.forEach((b, j) => {
    const [a0, b0, c0, d0] = bones[b.bone]! as [number, number, number, number], det = a0 * d0 - b0 * c0;
    off[k + j * 2] = off[k + j * 2]! + (d0 * dx - b0 * dy) / det;
    off[k + j * 2 + 1] = off[k + j * 2 + 1]! + (a0 * dy - c0 * dx) / det;
  });
  return off;
}
