import { attachmentType, type Animation, type Attachment, type Key, type Skeleton } from "@/model/skeleton";
import { type AttachmentRef, findAttachment, replaceAttachment } from "./attachments";
import { EditRefused, type Edit } from "./history";
import { triangulate } from "./triangulate";

/**
 * Mesh geometry edits (E4-PLAN step 5; Format-Json-Atlas.md §8.4, §8.9, §11.10) on unweighted
 * meshes: vertices are x,y pairs in the slot's bone space, `uvs` are u,v over the untrimmed
 * image, the first `hull` vertices are the outline in order. Deform keys store offsets from the
 * setup vertices, so a move leaves them as they are; adding or deleting a vertex rewrites them
 * (the mesh's own and its linked meshes').
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
  if (a.vertices.length !== a.uvs.length) throw new EditRefused(`"${r.key}" is bound to bones; editing weighted meshes comes with weights.`);
  return a;
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

/** The triangle holding (x, y), with the point's weights in it. */
export function triangleAt(a: Attachment, x: number, y: number): { tri: [number, number, number]; w: [number, number, number] } | null {
  const t = a.triangles!, xy = a.vertices!;
  for (let k = 0; k + 2 < t.length; k += 3) {
    const tri: [number, number, number] = [t[k]!, t[k + 1]!, t[k + 2]!];
    const w = weights(xy, tri, x, y);
    if (w && w.every((n) => n >= -1e-9)) return { tri, w };
  }
  return null;
}

const mix = (values: readonly number[], tri: readonly number[], w: readonly number[], c: 0 | 1) =>
  tri.reduce((sum, v, k) => sum + values[v * 2 + c]! * w[k]!, 0);

/**
 * Move vertex `i` to (x, y) in bone space. With `keepImage` the vertex's UV follows it through
 * its triangle's map from position to UV, so the image stays where it was; without, the image
 * stretches with it.
 */
export function moveVertex(r: AttachmentRef, i: number, x: number, y: number, keepImage = true): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r), n = a.uvs!.length / 2;
    if (!(i >= 0 && i < n)) throw new EditRefused(`The mesh has no vertex ${i}.`);
    if (a.vertices![i * 2] === x && a.vertices![i * 2 + 1] === y) return s;
    const vertices = [...a.vertices!];
    vertices[i * 2] = x; vertices[i * 2 + 1] = y;
    const uvs = [...a.uvs!];
    const tri = keepImage ? triangleOf(a, i) : null;
    const w = tri && weights(a.vertices!, tri, x, y);
    if (tri && w) {
      uvs[i * 2] = mix(a.uvs!, tri, w, 0);
      uvs[i * 2 + 1] = mix(a.uvs!, tri, w, 1);
    }
    return replaceAttachment(s, r, { ...a, vertices, uvs });
  };
}

/**
 * The mesh with its vertices changed by `change` and triangulated again; every deform key of it
 * and of its linked meshes rewritten by `deform` (old full offsets → new). `edges` dropped.
 */
function reshape(s: Skeleton, r: AttachmentRef, a: Attachment, vertices: number[], uvs: number[], hull: number, deform: (old: number[]) => number[]): Skeleton {
  const { edges: _, ...rest } = a;
  const tri = triangulate(vertices, hull);
  const out = replaceAttachment(s, r, { ...rest, vertices, uvs, hull, triangles: tri.triangles });
  return remapDeform(out, r, a.vertices!.length, deform);
}

/** Add a vertex at (x, y) inside the mesh; its UV and its deform offsets come from the triangle it lands in. */
export function addVertex(r: AttachmentRef, x: number, y: number): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r);
    const at = triangleAt(a, x, y);
    if (!at) throw new EditRefused("A new vertex goes inside the mesh; click on its outline to extend it.");
    const { tri, w } = at;
    const vertices = [...a.vertices!, x, y], uvs = [...a.uvs!, mix(a.uvs!, tri, w, 0), mix(a.uvs!, tri, w, 1)];
    return reshape(s, r, a, vertices, uvs, a.hull ?? 0, (d) => [...d, mix(d, tri, w, 0), mix(d, tri, w, 1)]);
  };
}

/** Split the outline edge from outline vertex `k` to the next at `t` (0..1): a new outline vertex. */
export function addHullVertex(r: AttachmentRef, k: number, t: number): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r), hull = a.hull ?? 0;
    if (!(k >= 0 && k < hull)) throw new EditRefused(`The outline has no vertex ${k}.`);
    const j = (k + 1) % hull, at = k + 1;
    const lerp = (v: readonly number[], c: 0 | 1) => v[k * 2 + c]! + (v[j * 2 + c]! - v[k * 2 + c]!) * t;
    const insert = (v: readonly number[], x: number, y: number) => [...v.slice(0, at * 2), x, y, ...v.slice(at * 2)];
    const vertices = insert(a.vertices!, tidy(lerp(a.vertices!, 0)), tidy(lerp(a.vertices!, 1)));
    const uvs = insert(a.uvs!, lerp(a.uvs!, 0), lerp(a.uvs!, 1));
    return reshape(s, r, a, vertices, uvs, hull + 1, (d) => insert(d, lerp(d, 0), lerp(d, 1)));
  };
}

/** Delete vertex `i`. Refused when the outline would keep fewer than three vertices. */
export function deleteVertex(r: AttachmentRef, i: number): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r), hull = a.hull ?? 0, n = a.uvs!.length / 2;
    if (!(i >= 0 && i < n)) throw new EditRefused(`The mesh has no vertex ${i}.`);
    if (i < hull && hull <= 3) throw new EditRefused("A mesh's outline needs at least three vertices.");
    const drop = (v: readonly number[]) => [...v.slice(0, i * 2), ...v.slice(i * 2 + 2)];
    return reshape(s, r, a, drop(a.vertices!), drop(a.uvs!), i < hull ? hull - 1 : hull, drop);
  };
}

/** Triangulate the mesh again from its outline and inner vertices. */
export function retriangulate(r: AttachmentRef): Edit<Skeleton> {
  return (s) => {
    const a = editableMesh(s, r);
    const { triangles } = triangulate(a.vertices!, a.hull ?? 0);
    if (triangles.length === a.triangles!.length && triangles.every((v, k) => v === a.triangles![k])) return s;
    const { edges: _, ...rest } = a;
    return replaceAttachment(s, r, { ...rest, triangles });
  };
}

/** Inner vertices outside the outline: in no triangle once triangulated. */
export function verticesOutside(a: Attachment): number[] {
  return triangulate(a.vertices ?? [], a.hull ?? 0).outside;
}

/**
 * Every deform key of the mesh at `r` and of the linked meshes that take it as their source,
 * with its offsets (expanded to `length` values, zeros where unwritten) rewritten by `f`, then
 * written back from the first value that is not 0 to the last.
 */
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
    const next = f(full);
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

/** A position as the stage writes it: two decimals, never -0. */
function tidy(n: number): number {
  const v = Math.round(n * 100) / 100;
  return v === 0 ? 0 : v;
}
