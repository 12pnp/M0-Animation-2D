import type { ImageRegion } from "./regions";
import { type Json, num, nums, parseColor } from "./rigJson";
import { type Sequence, type RegionData, DEG_RAD, type Frame, type MeshData, type PathData, type BoxData, type PointData, type ClippingData } from "./rigTypes";

/** The sequence an attachment declares, or null. */
export function readSequence(a: Json): Sequence | null {
  if (!a.sequence || typeof a.sequence !== "object") return null;
  const q = a.sequence as Json;
  return { count: Math.max(1, num(q.count, 1)), start: num(q.start, 1), digits: num(q.digits, 0), setup: num(q.setup, 0) };
}
/** The region path each frame shows: the path itself, or one per sequence frame. */
export function framePaths(path: string, sequence: Sequence | null): string[] {
  if (!sequence) return [path];
  return Array.from({ length: sequence.count }, (_, i) => path + String(sequence.start + i).padStart(sequence.digits, "0"));
}
/**
 * A region attachment. Each frame's corners are in the bone's space: the
 * attachment is `width` × `height` about its centre (`x`, `y`), turned by
 * `rotation` and scaled; the atlas region may hold only the trimmed part of
 * the original image, placed at its offsets (y from the bottom) and stretched
 * by the attachment's size over the original's.
 */
export function readRegion(key: string, a: Json, regions: Map<string, ImageRegion>): RegionData {
  const name = typeof a.name === "string" ? a.name : key;
  const path = typeof a.path === "string" ? a.path : name;
  const sequence = readSequence(a);
  const width = num(a.width, 32), height = num(a.height, 32);
  const sx = num(a.scaleX, 1), sy = num(a.scaleY, 1);
  const rad = num(a.rotation, 0) * DEG_RAD;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const x = num(a.x, 0), y = num(a.y, 0);

  const frames = framePaths(path, sequence).map((p): Frame => {
    const region = regions.get(p) ?? null;
    let left = -width / 2, bottom = -height / 2, right = width / 2, top = height / 2;
    if (region && region.originalWidth > 0 && region.originalHeight > 0) {
      const kx = width / region.originalWidth, ky = height / region.originalHeight;
      left += region.offsetX * kx;
      bottom += region.offsetY * ky;
      right = left + region.width * kx;
      top = bottom + region.height * ky;
    }
    const corners = new Float64Array(8);
    const local = [left, bottom, right, bottom, right, top, left, top];
    for (let i = 0; i < 8; i += 2) {
      const lx = local[i]! * sx, ly = local[i + 1]! * sy;
      corners[i] = x + lx * cos - ly * sin;
      corners[i + 1] = y + lx * sin + ly * cos;
    }
    // The trimmed pixels' corners in the same order, as image UVs (v down).
    const uvs = new Float32Array(8);
    if (region) {
      const ow = region.originalWidth || region.width, oh = region.originalHeight || region.height;
      const u0 = region.offsetX / ow, u1 = (region.offsetX + region.width) / ow;
      const v1 = (oh - region.offsetY) / oh, v0 = v1 - region.height / oh;
      pageUVs(region, [u0, v1, u1, v1, u1, v0, u0, v0], uvs);
    }
    return { region, corners, uvs };
  });
  const out: RegionData = { kind: "region", name, color: parseColor(a.color), frames, sequence, timeline: null!, timelineSlots: [] };
  out.timeline = out;
  return out;
}
/**
 * Image UVs (0..1 over the whole, untrimmed image, v down) to page UVs: into
 * the trimmed pixels' box, then turned as the packer turned the region.
 */
function pageUVs(region: ImageRegion | null, image: ArrayLike<number>, out: Float32Array): void {
  if (!region || region.page.width <= 0 || region.page.height <= 0) return;
  const pw = region.page.width, ph = region.page.height;
  const ow = region.originalWidth || region.width, oh = region.originalHeight || region.height;
  // The trimmed box's top left in the image, y down.
  const left = region.offsetX, top = oh - region.offsetY - region.height;
  for (let i = 0; i < image.length; i += 2) {
    const tx = image[i]! * ow - left, ty = image[i + 1]! * oh - top;
    let px: number, py: number;
    switch (region.degrees) {
      case 90: px = region.x + ty; py = region.y + region.width - tx; break;
      case 180: px = region.x + region.width - tx; py = region.y + region.height - ty; break;
      case 270: px = region.x + region.height - ty; py = region.y + tx; break;
      default: px = region.x + tx; py = region.y + ty;
    }
    out[i] = px / pw;
    out[i + 1] = py / ph;
  }
}
/**
 * A mesh: `vertices` holds 2 numbers per vertex unless it is longer than
 * `uvs`, in which case it is weighted — per vertex a bone count, then bone,
 * x, y, weight for each.
 */
export function readMesh(key: string, a: Json, regions: Map<string, ImageRegion>): MeshData {
  const name = typeof a.name === "string" ? a.name : key;
  const path = typeof a.path === "string" ? a.path : name;
  const sequence = readSequence(a);
  const regionUVs = Float64Array.from(nums(a.uvs), Math.fround);
  const raw = nums(a.vertices);
  const vertexCount = Math.floor(regionUVs.length / 2);
  const weighted = raw.length > regionUVs.length;
  let deformLength = vertexCount * 2;
  if (weighted) deformLength = weightedLength(raw) ?? 0;
  const mesh: MeshData = {
    kind: "mesh", name, color: parseColor(a.color), sequence, timeline: null!, timelineSlots: [],
    frames: framePaths(path, sequence).map((p) => ({ region: regions.get(p) ?? null, corners: new Float64Array(0), uvs: new Float32Array(regionUVs.length) })),
    vertexCount, weighted,
    // Weighted streams keep their bone counts and indices exact.
    vertices: weighted ? weightedStream(raw) : Float64Array.from(raw, Math.fround),
    deformLength, regionUVs, triangles: meshTriangles(nums(a.triangles), Math.floor(regionUVs.length / 2)),
  };
  mesh.timeline = mesh;
  for (const f of mesh.frames) pageUVs(f.region, regionUVs, f.uvs);
  return mesh;
}
/** A path attachment: `vertexCount` vertices, weighted when `vertices` is
 *  longer than two numbers each. */
export function readPath(key: string, a: Json): PathData {
  const name = typeof a.name === "string" ? a.name : key;
  const raw = nums(a.vertices);
  const vertexCount = num(a.vertexCount, raw.length / 2);
  const weighted = raw.length > vertexCount * 2;
  let deformLength = vertexCount * 2;
  if (weighted) deformLength = weightedLength(raw) ?? 0;
  const path: PathData = {
    kind: "path", name, color: parseColor(a.color), frames: [], sequence: null, timeline: null!,
    vertexCount, weighted, vertices: weighted ? weightedStream(raw) : Float64Array.from(raw, Math.fround), deformLength,
    closed: a.closed === true, constantSpeed: a.constantSpeed !== false,
    lengths: nums(a.lengths).map(Math.fround),
  };
  path.timeline = path;
  return path;
}
/** The vertex stream of a path or clipping polygon: weighted when longer
 *  than two numbers per vertex. */
function vertexStream(raw: number[], vertexCount: number) {
  const weighted = raw.length > vertexCount * 2;
  let deformLength = vertexCount * 2;
  if (weighted) deformLength = weightedLength(raw) ?? 0;
  return { weighted, deformLength, vertices: weighted ? weightedStream(raw) : Float64Array.from(raw, Math.fround) };
}
export function readBox(key: string, a: Json): BoxData {
  const raw = nums(a.vertices);
  const vertexCount = num(a.vertexCount, raw.length / 2);
  const box: BoxData = {
    kind: "box", name: typeof a.name === "string" ? a.name : key, color: parseColor(a.color),
    frames: [], sequence: null, timeline: null!, vertexCount, ...vertexStream(raw, vertexCount),
  };
  box.timeline = box;
  return box;
}
export function readPoint(key: string, a: Json): PointData {
  const point: PointData = {
    kind: "point", name: typeof a.name === "string" ? a.name : key, color: parseColor(a.color),
    frames: [], sequence: null, timeline: null!, x: num(a.x, 0), y: num(a.y, 0), rotation: num(a.rotation, 0),
  };
  point.timeline = point;
  return point;
}
export function readClipping(key: string, a: Json, slotIndex: Map<string, number>): ClippingData {
  const raw = nums(a.vertices);
  const vertexCount = num(a.vertexCount, raw.length / 2);
  const clip: ClippingData = {
    kind: "clipping", name: typeof a.name === "string" ? a.name : key, color: parseColor(a.color),
    frames: [], sequence: null, timeline: null!, vertexCount, ...vertexStream(raw, vertexCount),
    end: typeof a.end === "string" ? slotIndex.get(a.end) ?? -1 : -1, inverse: a.inverse === true,
  };
  clip.timeline = clip;
  return clip;
}
/** A weighted vertex stream with x, y and weight in 32-bit floats; the
 *  bone counts and indices stay whole. */
/**
 * A weighted vertex stream's deform length (two numbers an influence), or null when it is
 * malformed: a bone count that is not a whole number above 0, or influences running past the end.
 * Walking a malformed one hung (a negative count) or read past it (E7-PLAN step 5).
 */
export function weightedLength(raw: readonly number[]): number | null {
  let length = 0;
  for (let i = 0; i < raw.length;) {
    const n = raw[i]!;
    if (!(Number.isInteger(n) && n > 0 && i + 1 + n * 4 <= raw.length)) return null;
    length += n * 2;
    i += 1 + n * 4;
  }
  return length;
}
/** A mesh's triangles: whole ones, every index within its vertices; a broken list draws nothing (E7-PLAN step 5). */
function meshTriangles(t: readonly number[], vertexCount: number): Uint32Array {
  const ok = t.length % 3 === 0 && t.every((i) => Number.isInteger(i) && i >= 0 && i < vertexCount);
  return ok ? Uint32Array.from(t) : new Uint32Array(0);
}
function weightedStream(raw: number[]): Float64Array {
  if (weightedLength(raw) === null) return new Float64Array(0);
  const out = Float64Array.from(raw);
  for (let i = 0; i < out.length;) {
    const n = out[i++]!;
    for (let j = 0; j < n; j++, i += 4) {
      out[i + 1] = Math.fround(out[i + 1]!);
      out[i + 2] = Math.fround(out[i + 2]!);
      out[i + 3] = Math.fround(out[i + 3]!);
    }
  }
  return out;
}
/** A linked mesh: its source's geometry with its own image, and the
 *  source's deform keys when `timelines`. */
export function linkMesh(mesh: MeshData, source: MeshData, timelines: boolean): void {
  mesh.vertexCount = source.vertexCount;
  mesh.weighted = source.weighted;
  mesh.vertices = source.vertices;
  mesh.deformLength = source.deformLength;
  mesh.regionUVs = source.regionUVs;
  mesh.triangles = source.triangles;
  mesh.frames = mesh.frames.map((f) => {
    const uvs = new Float32Array(source.regionUVs.length);
    pageUVs(f.region, source.regionUVs, uvs);
    return { ...f, uvs };
  });
  mesh.timeline = timelines ? source.timeline : mesh;
}
