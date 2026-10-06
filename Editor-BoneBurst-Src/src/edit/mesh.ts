import { attachmentType, type Attachment, type Skeleton } from "@/model/skeleton";
import { type AttachmentRef, findAttachment, replaceAttachment } from "./attachments";
import { EditRefused, type Edit } from "./history";
import { type Bind, bindAt, type BoneWorlds, decodeBinds, encodeBinds, type Frame, frameFor, isWeighted, positions, rewriteDeform, round, type Source } from "./meshLayout";
import { triangulate } from "./triangulate";
import { refuseNonFinite } from "./finite";

/**
 * Mesh geometry edits (E4-PLAN steps 5–6; Format-Json-Atlas.md §8.4, §8.9, §11.10). Positions
 * are in the slot's bone space on the setup pose; `uvs` are u,v over the untrimmed image; the
 * first `hull` vertices are the outline in order. A weighted mesh needs the setup bones' world
 * matrices (`bones`) to place its vertices. Deform keys keep their setup-pose meaning: a move
 * leaves them as they are, adding or deleting a vertex rewrites them (the mesh's own and its
 * linked meshes').
 */

/** The corners of a region's image in its bone's space, with their UVs: the region as a mesh. */
export function regionCorners(a: Attachment): { xy: number[]; uvs: number[] } {
  const w = a.width ?? 0, h = a.height ?? 0, sx = a.scaleX ?? 1, sy = a.scaleY ?? 1;
  const r = ((a.rotation ?? 0) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  // Bottom-left, bottom-right, top-right, top-left; v runs down the image.
  const local = [[-w / 2, -h / 2, 0, 1], [w / 2, -h / 2, 1, 1], [w / 2, h / 2, 1, 0], [-w / 2, h / 2, 0, 0]] as const;
  const xy: number[] = [], uvs: number[] = [];
  for (const [lx, ly, u, v] of local) {
    const px = lx * sx, py = ly * sy;
    xy.push((a.x ?? 0) + px * cos - py * sin, (a.y ?? 0) + px * sin + py * cos);
    uvs.push(u, v);
  }
  return { xy, uvs };
}

/** A region turned into a mesh that draws the same: four outline vertices, two triangles. */
export function regionToMesh(r: AttachmentRef): Edit<Skeleton> {
  return (s) => {
    const a = findAttachment(s, r);
    if (!a) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
    if (attachmentType(a) !== "region") throw new EditRefused(`"${r.key}" is a ${attachmentType(a)}, not a region.`);
    const { xy, uvs } = regionCorners(a);
    const { x: _x, y: _y, rotation: _r, scaleX: _sx, scaleY: _sy, type: _t, ...rest } = a;
    const mesh: Attachment = { ...rest, type: "mesh", uvs, triangles: triangulate(xy, 4).triangles, vertices: xy, hull: 4 };
    return replaceAttachment(s, r, mesh);
  };
}

/** The editable mesh at `r`, or the reason it is not one. */
export function editableMesh(s: Skeleton, r: AttachmentRef): Attachment {
  const a = findAttachment(s, r);
  if (!a) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
  const type = attachmentType(a);
  if (type !== "mesh" && type !== "linkedmesh") throw new EditRefused(`"${r.key}" is a ${type}; only meshes have vertices to edit here.`);
  if (a.source !== undefined) throw new EditRefused(`"${r.key}" is linked to "${a.source}": edit that mesh's vertices.`);
  if (!a.uvs || !a.vertices || !a.triangles) throw new EditRefused(`"${r.key}" is missing its vertices.`);
  return a;
}

/** The mesh, where its vertices are, and its frame (null for an unweighted mesh without bones). */
function meshAt(s: Skeleton, r: AttachmentRef, bones: BoneWorlds | undefined): { a: Attachment; f: Frame | null; pos: number[] } {
  const a = editableMesh(s, r), f = frameFor(s, r, a, bones);
  return { a, f, pos: positions(a, f) };
}

/** A triangle `i` belongs to, as its three vertex indices; null when it is in none. */
function triangleOf(a: Attachment, i: number): [number, number, number] | null {
  const t = a.triangles!;
  for (let k = 0; k + 2 < t.length; k += 3) if (t[k] === i || t[k + 1] === i || t[k + 2] === i) return [t[k]!, t[k + 1]!, t[k + 2]!];
  return null;
}

/** Barycentric weights of (x, y) in the triangle, or null for a flat one. */
function weights(xy: readonly number[], [a, b, c]: readonly [number, number, number], x: number, y: number): [number, number, number] | null {
  const ax = xy[a * 2]!, ay = xy[a * 2 + 1]!, bx = xy[b * 2]!, by = xy[b * 2 + 1]!, cx = xy[c * 2]!, cy = xy[c * 2 + 1]!;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  return [u, v, 1 - u - v];
}

/** The triangle holding (x, y) among `pos` (the mesh's positions; its unweighted vertices by default), with the point's weights in it. */
export function triangleAt(a: Attachment, x: number, y: number, pos: readonly number[] = a.vertices!): { tri: [number, number, number]; w: [number, number, number] } | null {
  const t = a.triangles!;
  for (let k = 0; k + 2 < t.length; k += 3) {
    const tri: [number, number, number] = [t[k]!, t[k + 1]!, t[k + 2]!];
    const w = weights(pos, tri, x, y);
    if (w && w.every((n) => n >= -1e-9)) return { tri, w };
  }
  return null;
}

/** Vertices 0..n-1 kept as they are. */
const keep = (n: number): Source[] => Array.from({ length: n }, (_, v) => v);

const mix = (values: readonly number[], tri: readonly number[], w: readonly number[], c: 0 | 1) =>
  tri.reduce((sum, v, k) => sum + values[v * 2 + c]! * w[k]!, 0);

/**
 * Bone weights blended from several vertices' binds (`parts`: binds and how much each counts):
 * the four heaviest bones kept, any under 0.01 dropped, normalised, to four decimals.
 */
export function blendWeights(parts: readonly { binds: readonly Bind[]; t: number }[]): { bone: number; w: number }[] {
  const sum = new Map<number, number>();
  for (const { binds, t } of parts) for (const b of binds) sum.set(b.bone, (sum.get(b.bone) ?? 0) + b.w * t);
  return normaliseWeights([...sum].map(([bone, w]) => ({ bone, w })));
}

/** The four heaviest, those under 0.01 dropped (the heaviest always kept), summing to 1, to four decimals. */
export function normaliseWeights(ws: readonly { bone: number; w: number }[]): { bone: number; w: number }[] {
  const sorted = [...ws].filter((x) => x.w > 0).sort((p, q) => q.w - p.w || p.bone - q.bone).slice(0, 4);
  // The 0.01 cut is on each bone's share, not its raw weight.
  const all = sorted.reduce((n, x) => n + x.w, 0);
  const kept = sorted.filter((x, i) => i === 0 || x.w / all >= 0.01);
  const total = kept.reduce((n, x) => n + x.w, 0);
  if (!kept.length || !(total > 0)) throw new EditRefused("A vertex needs a bone with weight.");
  const out = kept.map((x) => ({ bone: x.bone, w: round(x.w / total, 4) }));
  // Rounding leaves the sum a hair off 1: the heaviest takes the difference.
  out[0] = { bone: out[0]!.bone, w: round(1 - out.slice(1).reduce((n, x) => n + x.w, 0), 4) };
  return out;
}

/**
 * Move vertex `i` to (x, y). With `keepImage` the vertex's UV follows it through its triangle's
 * map from position to UV, so the image stays where it was; without, the image stretches with
 * it. A weighted vertex keeps its weights and is bound again where it lands.
 */
export function moveVertex(r: AttachmentRef, i: number, x: number, y: number, keepImage = true, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite("The vertex", { x, y });
    const { a, f, pos } = meshAt(s, r, bones), n = a.uvs!.length / 2;
    if (!(i >= 0 && i < n)) throw new EditRefused(`The mesh has no vertex ${i}.`);
    if (round(pos[i * 2]!, 4) === round(x, 4) && round(pos[i * 2 + 1]!, 4) === round(y, 4)) return s;
    const uvs = [...a.uvs!];
    const tri = keepImage ? triangleOf(a, i) : null;
    const w = tri && weights(pos, tri, x, y);
    if (tri && w) {
      uvs[i * 2] = mix(a.uvs!, tri, w, 0);
      uvs[i * 2 + 1] = mix(a.uvs!, tri, w, 1);
    }
    let vertices: number[];
    if (isWeighted(a)) {
      const binds = decodeBinds(a.vertices!);
      binds[i] = bindAt(f!, binds[i]!, x, y);
      vertices = encodeBinds(binds);
    } else {
      vertices = [...a.vertices!];
      vertices[i * 2] = x; vertices[i * 2 + 1] = y;
    }
    return replaceAttachment(s, r, { ...a, vertices, uvs });
  };
}

/**
 * The mesh with new vertices (positions `pos`, written `vertices`, `uvs`, `hull`), triangulated
 * again; its deform keys carried vertex by vertex from `sources`. `edges` dropped.
 */
function reshape(s: Skeleton, r: AttachmentRef, a: Attachment, f: Frame | null, pos: number[], vertices: number[], uvs: number[], hull: number, sources: Source[]): Skeleton {
  const { edges: _, ...rest } = a;
  const next: Attachment = { ...rest, vertices, uvs, hull, triangles: triangulate(pos, hull).triangles };
  return rewriteDeform(replaceAttachment(s, r, next), r, a, next, f, sources);
}

/** Add a vertex at (x, y) inside the mesh; its UV, weights and deform offsets come from the triangle it lands in. */
export function addVertex(r: AttachmentRef, x: number, y: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite("The vertex", { x, y });
    const { a, f, pos } = meshAt(s, r, bones);
    const at = triangleAt(a, x, y, pos);
    if (!at) throw new EditRefused("A new vertex goes inside the mesh; click on its outline to extend it.");
    const { tri, w } = at;
    const uvs = [...a.uvs!, mix(a.uvs!, tri, w, 0), mix(a.uvs!, tri, w, 1)];
    let vertices: number[];
    if (isWeighted(a)) {
      const binds = decodeBinds(a.vertices!);
      binds.push(bindAt(f!, blendWeights(tri.map((v, k) => ({ binds: binds[v]!, t: w[k]! }))), x, y));
      vertices = encodeBinds(binds);
    } else vertices = [...a.vertices!, x, y];
    return reshape(s, r, a, f, [...pos, x, y], vertices, uvs, a.hull ?? 0, [...keep(pos.length / 2), tri.map((v, k) => [v, w[k]!] as const)]);
  };
}

/** Split the outline edge from outline vertex `k` to the next at `t` (0..1): a new outline vertex. */
export function addHullVertex(r: AttachmentRef, k: number, t: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const { a, f, pos } = meshAt(s, r, bones), hull = a.hull ?? 0;
    if (!(k >= 0 && k < hull)) throw new EditRefused(`The outline has no vertex ${k}.`);
    const j = (k + 1) % hull, at = k + 1;
    const lerp = (v: readonly number[], c: 0 | 1) => v[k * 2 + c]! + (v[j * 2 + c]! - v[k * 2 + c]!) * t;
    const insert = (v: readonly number[], x: number, y: number) => [...v.slice(0, at * 2), x, y, ...v.slice(at * 2)];
    const x = round(lerp(pos, 0), 2), y = round(lerp(pos, 1), 2);
    const uvs = insert(a.uvs!, lerp(a.uvs!, 0), lerp(a.uvs!, 1));
    let vertices: number[];
    if (isWeighted(a)) {
      const binds = decodeBinds(a.vertices!);
      binds.splice(at, 0, bindAt(f!, blendWeights([{ binds: binds[k]!, t: 1 - t }, { binds: binds[j]!, t }]), x, y));
      vertices = encodeBinds(binds);
    } else vertices = insert(a.vertices!, x, y);
    const sources: Source[] = keep(pos.length / 2);
    sources.splice(at, 0, [[k, 1 - t], [j, t]]);
    return reshape(s, r, a, f, insert(pos, x, y), vertices, uvs, hull + 1, sources);
  };
}

/** Delete vertex `i`. Refused when the outline would keep fewer than three vertices. */
export function deleteVertex(r: AttachmentRef, i: number, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const { a, f, pos } = meshAt(s, r, bones), hull = a.hull ?? 0, n = a.uvs!.length / 2;
    if (!(i >= 0 && i < n)) throw new EditRefused(`The mesh has no vertex ${i}.`);
    if (i < hull && hull <= 3) throw new EditRefused("A mesh's outline needs at least three vertices.");
    const drop = (v: readonly number[]) => [...v.slice(0, i * 2), ...v.slice(i * 2 + 2)];
    const vertices = isWeighted(a) ? encodeBinds(decodeBinds(a.vertices!).filter((_, v) => v !== i)) : drop(a.vertices!);
    return reshape(s, r, a, f, drop(pos), vertices, drop(a.uvs!), i < hull ? hull - 1 : hull, keep(n).filter((v) => v !== i));
  };
}

/** Triangulate the mesh again from its outline and inner vertices. */
export function retriangulate(r: AttachmentRef, bones?: BoneWorlds): Edit<Skeleton> {
  return (s) => {
    const { a, pos } = meshAt(s, r, bones);
    const { triangles } = triangulate(pos, a.hull ?? 0);
    if (triangles.length === a.triangles!.length && triangles.every((v, k) => v === a.triangles![k])) return s;
    const { edges: _, ...rest } = a;
    return replaceAttachment(s, r, { ...rest, triangles });
  };
}

/** Inner vertices outside the outline (in no triangle once triangulated), given its positions. */
export function verticesOutside(a: Attachment, pos: readonly number[] = a.vertices ?? []): number[] {
  return triangulate(pos, a.hull ?? 0).outside;
}
