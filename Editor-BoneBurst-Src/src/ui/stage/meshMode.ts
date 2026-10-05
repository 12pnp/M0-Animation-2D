import { type AttachmentRef, findAttachment } from "@/edit/attachments";
import { editableMesh } from "@/edit/mesh";
import { EditRefused } from "@/edit/history";
import { type Bind, type BoneWorlds, decodeBinds, isWeighted } from "@/edit/meshLayout";
import { attachmentType, type Skeleton } from "@/model/skeleton";
import { boneMatrix, type Posed } from "./posed";
import type { Point } from "./gizmo";

/**
 * The stage's mesh mode (E4-PLAN step 5): the selected mesh's vertices in the world, and what a
 * press lands on. No DOM: `tests/mesh.test.ts` checks the picking.
 */

export interface MeshView {
  readonly ref: AttachmentRef;
  /** World x,y per vertex. */
  readonly world: number[];
  readonly triangles: readonly number[];
  readonly hull: number;
  /** The slot's bone's world matrix: bone space ↔ world. */
  readonly bone: readonly number[];
  /** Why the vertices cannot be edited, or null when they can. */
  readonly locked: string | null;
  /** Each vertex's bones and weights, for a weighted mesh. */
  readonly binds: readonly (readonly Bind[])[] | null;
  /** Animate mode (E4 step 11): the pose at the playhead the vertices are shown in, for keying deforms. */
  readonly animated?: { readonly bones: BoneWorlds; readonly slotBone: number; readonly deform: readonly number[] | null };
}

/**
 * The selected mesh in Animate mode: drawn where its vertices are at the playhead, when its slot
 * shows it there; otherwise null with the reason.
 */
export function animatedMeshView(doc: Skeleton, p: Posed, ref: AttachmentRef, shownSkin: string | null): { view: MeshView | null; reason: string | null } {
  const a = findAttachment(doc, ref);
  if (!a || !["mesh", "linkedmesh"].includes(attachmentType(a))) return { view: null, reason: null };
  const slot = p.rig.data.slots.findIndex((x) => x.name === ref.slot);
  // What the slot shows: its key now, looked up in the shown skin, then the default one.
  const fromSkin = shownSkin !== null && findAttachment(doc, { skin: shownSkin, slot: ref.slot, key: ref.key }) ? shownSkin : "default";
  if (slot < 0 || p.rig.attachment[slot] !== ref.key || fromSkin !== ref.skin) return { view: null, reason: `"${ref.key}" is not shown in its slot at this frame; show it there to key its vertices.` };
  const data = p.rig.attachmentOf(slot);
  if (!data || data.kind !== "mesh") return { view: null, reason: null };
  const base = meshView(doc, p, ref);
  if (!base) return { view: null, reason: null };
  const world = new Float64Array(base.world.length);
  p.rig.vertexWorld(slot, data, 0, world.length, world, 0);
  const bones: BoneWorlds = (doc.bones ?? []).map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
  const slotBone = (doc.bones ?? []).findIndex((b) => b.name === doc.slots!.find((x) => x.name === ref.slot)!.bone);
  const d = p.rig.deform[slot];
  const locked = a.source !== undefined ? `"${ref.key}" is linked to "${a.source}": key that mesh's deforms.` : null;
  return { view: { ...base, world: [...world], locked, animated: { bones, slotBone, deform: d ? [...d] : null } }, reason: null };
}

/** Vertex `i`'s weight for bone index `bone` (0 when the bone does not hold it). */
export function weightOf(view: MeshView, i: number, bone: number): number {
  return view.binds?.[i]?.find((b) => b.bone === bone)?.w ?? 0;
}

/** The selected attachment as the stage shows it in mesh mode, or null when it is not a mesh. */
export function meshView(doc: Skeleton, p: Posed, ref: AttachmentRef): MeshView | null {
  let a = findAttachment(doc, ref);
  if (!a || !["mesh", "linkedmesh"].includes(attachmentType(a))) return null;
  // A linked mesh shows its source's vertices.
  if (a.source !== undefined) a = findAttachment(doc, { skin: a.skin ?? "default", slot: a.slot ?? ref.slot, key: a.source });
  if (!a?.uvs || !a.vertices) return null;
  const slot = doc.slots?.find((x) => x.name === ref.slot);
  const index = slot ? p.bones.get(slot.bone) : undefined;
  if (index === undefined) return null;
  const m = boneMatrix(p, index), world: number[] = [], v = a.vertices;
  if (v.length === a.uvs.length) {
    for (let i = 0; i < v.length; i += 2) world.push(m[0] * v[i]! + m[1] * v[i + 1]! + m[4], m[2] * v[i]! + m[3] * v[i + 1]! + m[5]);
  } else {
    // Weighted (§8.9): each vertex is the weighted sum of its bones' placements of it.
    for (let i = 0; i < v.length;) {
      let x = 0, y = 0;
      const n = v[i++]!;
      for (let k = 0; k < n; k++, i += 4) {
        const b = boneMatrix(p, v[i]!), bx = v[i + 1]!, by = v[i + 2]!, w = v[i + 3]!;
        x += (b[0] * bx + b[1] * by + b[4]) * w;
        y += (b[2] * bx + b[3] * by + b[5]) * w;
      }
      world.push(x, y);
    }
  }
  let locked: string | null = null;
  try { editableMesh(doc, ref); } catch (err) { if (!(err instanceof EditRefused)) throw err; locked = err.message; }
  return { ref, world, triangles: a.triangles ?? [], hull: a.hull ?? 0, bone: m, locked, binds: isWeighted(a) ? decodeBinds(a.vertices) : null };
}

/** A world point in the slot's bone space, to two decimals as a drag writes it. */
export function toBone(view: MeshView, [x, y]: Point): [number, number] {
  const [a, b, c, d, wx, wy] = view.bone as [number, number, number, number, number, number];
  const det = a * d - b * c, dx = x - wx, dy = y - wy;
  const r = (n: number) => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };
  return [r((d * dx - b * dy) / det), r((a * dy - c * dx) / det)];
}

/** What a press at screen point `s` lands on, given each vertex on screen. */
export type MeshHit = { kind: "vertex"; index: number } | { kind: "edge"; after: number; t: number } | { kind: "inside" } | null;

export function hitMesh(screen: readonly number[], triangles: readonly number[], hull: number, sx: number, sy: number, radius = 7): MeshHit {
  let best = -1, bestD = radius;
  for (let i = 0; i < screen.length / 2; i++) {
    const d = Math.hypot(screen[i * 2]! - sx, screen[i * 2 + 1]! - sy);
    if (d <= bestD) { best = i; bestD = d; }
  }
  if (best >= 0) return { kind: "vertex", index: best };
  let edge: { after: number; t: number } | null = null, edgeD = radius - 1;
  for (let k = 0; k < hull; k++) {
    const j = (k + 1) % hull;
    const x0 = screen[k * 2]!, y0 = screen[k * 2 + 1]!, x1 = screen[j * 2]!, y1 = screen[j * 2 + 1]!;
    const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const t = ((sx - x0) * dx + (sy - y0) * dy) / l2;
    if (t <= 0 || t >= 1) continue;
    const d = Math.hypot(sx - (x0 + t * dx), sy - (y0 + t * dy));
    if (d <= edgeD) { edge = { after: k, t }; edgeD = d; }
  }
  if (edge) return { kind: "edge", ...edge };
  for (let k = 0; k + 2 < triangles.length; k += 3) {
    const [a, b, c] = [triangles[k]!, triangles[k + 1]!, triangles[k + 2]!];
    const s1 = side(screen, a, b, sx, sy), s2 = side(screen, b, c, sx, sy), s3 = side(screen, c, a, sx, sy);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return { kind: "inside" };
  }
  return null;
}

function side(p: readonly number[], a: number, b: number, x: number, y: number): number {
  return (p[b * 2]! - p[a * 2]!) * (y - p[a * 2 + 1]!) - (p[b * 2 + 1]! - p[a * 2 + 1]!) * (x - p[a * 2]!);
}
