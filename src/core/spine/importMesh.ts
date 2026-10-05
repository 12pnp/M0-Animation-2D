import { apply, applyInverse, invert, mat, type Matrix2D } from "@/core/math/Matrix2D";
import type { NodeId } from "@/core/doc/ids";
import type { DeformKey, MeshData } from "@/core/doc/types";

/**
 * An opened file's mesh as the editor's (ARCHITECTURE ▸ Meshes ▸ Opened
 * meshes), pure: the inverse of `spineVertices` / `spineDeform`. The UVs over
 * the image's size are the points; the vertices, placed back in the slot's
 * space, are the positions (`MeshData.vertices`, left out where they are the
 * points). Null where the model cannot hold the attachment exactly; then it
 * stays carried.
 */

type Raw = Record<string, unknown>;

/** The fields of a mesh attachment the model holds. */
const MESH_FIELDS = new Set(["type", "name", "path", "uvs", "triangles", "vertices", "hull", "width", "height", "edges"]);

export interface MeshContext {
  /** The image the mesh draws: its size in pixels. */
  width: number;
  height: number;
  /** The display's transform point, in the image's pixels. */
  pivot: { x: number; y: number };
  /** The mesh node's world at the setup pose (the slot bone's). */
  node: Matrix2D;
  /** A bone of the file by name: its node and its world at the setup pose. */
  bone(name: string): { id: NodeId; setup: Matrix2D } | undefined;
  /** A bone node's world at the setup pose. */
  setupOf(id: NodeId): Matrix2D | undefined;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The mesh, or null. */
export function meshFromSpine(att: Raw, ctx: MeshContext): MeshData | null {
  if (att.type !== "mesh" || Object.keys(att).some((k) => !MESH_FIELDS.has(k))) return null;
  const uvs = att.uvs, tris = att.triangles, verts = att.vertices;
  if (!Array.isArray(uvs) || !Array.isArray(tris) || !Array.isArray(verts) || uvs.length < 6 || uvs.length % 2 || !uvs.every(finite)) return null;
  const n = uvs.length / 2;
  if (!tris.length || tris.length % 3 || !tris.every((i) => Number.isInteger(i) && i >= 0 && i < n)) return null;
  const points = uvs.map((v, i) => (i % 2 ? v * ctx.height : v * ctx.width));
  const positions: number[] = [];
  let weights: Array<Array<[NodeId, number]>> | undefined;
  let boneOffsets: Array<Array<[number, number]>> | undefined;
  if (verts.length === n * 2) {
    if (!verts.every(finite)) return null;
    for (let i = 0; i < n; i++) positions.push(verts[i * 2]! + ctx.pivot.x, -verts[i * 2 + 1]! + ctx.pivot.y);
  } else {
    weights = [];
    boneOffsets = [];
    let at = 0;
    for (let i = 0; i < n; i++) {
      const count = verts[at++];
      if (!Number.isInteger(count) || count < 1) return null;
      let x = 0, y = 0, total = 0;
      const own: Array<[NodeId, number]> = [];
      const offs: Array<[number, number]> = [];
      for (let j = 0; j < count; j++) {
        const [name, bx, by, w] = [verts[at], verts[at + 1], verts[at + 2], verts[at + 3]];
        at += 4;
        const bone = typeof name === "string" ? ctx.bone(name) : undefined;
        if (!bone || !finite(bx) || !finite(by) || !finite(w)) return null;
        // Each bone's offset is kept as the file has it (`boneOffsets`): its
        // bones need not agree on one setup position. The position is where
        // the setup pose shows the point.
        const p = apply({ x: 0, y: 0 }, bone.setup, bx, 0 - by);
        x += p.x * w; y += p.y * w; total += w;
        own.push([bone.id, w]);
        offs.push([bx, 0 - by]);
      }
      boneOffsets!.push(offs);
      if (!total) return null;
      const local = { x: 0, y: 0 };
      if (!applyInverse(local, ctx.node, x / total, y / total)) return null;
      positions.push(local.x + ctx.pivot.x, local.y + ctx.pivot.y);
      weights.push(own);
    }
    if (at !== verts.length) return null;
  }
  const hull = Number.isInteger(att.hull) && (att.hull as number) >= 3 && (att.hull as number) <= n ? att.hull as number : n;
  const mesh: MeshData = { width: ctx.width, height: ctx.height, points, triangles: [...tris] as number[], hull };
  if (weights) { mesh.weights = weights; mesh.boneOffsets = boneOffsets; }
  if (positions.some((v, i) => Math.abs(v - points[i]!) > 1e-4)) mesh.vertices = positions;
  if (Array.isArray(att.edges) && att.edges.every((v) => Number.isInteger(v))) mesh.edges = [...att.edges] as number[];
  return mesh;
}

/**
 * A file's `deform` timeline for `mesh` as the editor's keys, or null when a
 * key falls between frames or a weighted point's entries do not move it the
 * same way (the model keeps one offset per point).
 */
export function deformKeysFromSpine(raw: unknown, mesh: MeshData, ctx: MeshContext, fps: number): DeformKey[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const n = mesh.points.length / 2;
  // Each point's entries, in file order: one per point unweighted, one per bone weighted.
  const entries = mesh.weights ? mesh.weights.map((w) => w.length) : new Array<number>(n).fill(1);
  const total = entries.reduce((s, c) => s + c, 0) * 2;
  const lin = (m: Matrix2D) => ({ ...m, tx: 0, ty: 0 });
  const nodeInv = mat();
  if (!invert(nodeInv, lin(ctx.node))) return null;
  const keys: DeformKey[] = [];
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k] as Raw;
    if (!r || typeof r !== "object") return null;
    const time = finite(r.time) ? r.time : 0;
    const frame = Math.round(time * fps);
    if (Math.abs(frame - time * fps) > 1e-3) return null;
    const flat = new Array<number>(total).fill(0);
    const start = Number.isInteger(r.offset) ? r.offset as number : 0;
    if (Array.isArray(r.vertices)) {
      if (!r.vertices.every(finite) || start + r.vertices.length > total) return null;
      r.vertices.forEach((v, i) => { flat[start + i] = v as number; });
    }
    const offsets: number[] = [];
    let at = 0;
    for (let i = 0; i < n; i++) {
      if (!mesh.weights) { offsets.push(flat[at]!, 0 - flat[at + 1]!); at += 2; continue; }
      let first: { x: number; y: number } | null = null;
      for (const [bone] of mesh.weights[i]!) {
        const setup = ctx.setupOf(bone);
        if (!setup) return null;
        // An entry in the bone's setup space back into the node's: lin(N⁻¹ · S).
        const w = apply({ x: 0, y: 0 }, lin(setup), flat[at]!, -flat[at + 1]!);
        const d = apply({ x: 0, y: 0 }, nodeInv, w.x, w.y);
        at += 2;
        if (!first) first = d;
        else if (Math.abs(first.x - d.x) > 1e-3 || Math.abs(first.y - d.y) > 1e-3) return null;
      }
      offsets.push(first?.x ?? 0, first?.y ?? 0);
    }
    const key: DeformKey = { frame, offsets };
    const next = raw[k + 1] as Raw | undefined;
    if (r.curve === "stepped") key.tween = { kind: "none" };
    else if (Array.isArray(r.curve) && next) {
      const c = r.curve;
      const t1 = finite(next.time) ? next.time : 0, span = t1 - time;
      if (span <= 0 || c.length < 4 || !c.every(finite)) return null;
      key.tween = { kind: "curve", curve: [(c[0] as number - time) / span, c[1] as number, (c[2] as number - time) / span, c[3] as number] };
    }
    keys.push(key);
  }
  return new Set(keys.map((x) => x.frame)).size === keys.length ? keys : null;
}
