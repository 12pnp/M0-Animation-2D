import type { SpineInherit } from "../types";
import type { Atlas, AtlasRegion } from "./atlasRead";
import { spinePolyline } from "@/core/math/easing";

/**
 * A Spine 4.3 skeleton JSON read into the BoneBurst runtime's model
 * (docs/PREVIEW-RUNTIME-PLAN.md). Written from the format, held to
 * spine-core by `tests/spineRuntime.test.ts`; nothing here is taken from
 * spine-core's source.
 *
 * P0 covers bones (normal inheritance), slots, region attachments, skins and
 * the bone, attachment, colour and draw order timelines; P1 meshes (weighted
 * or not), linked meshes, deform keys, sequences and bones only some skins
 * enable. Whatever else a file holds is listed in `unsupported`, so the
 * preview can say so instead of silently drawing something else.
 */

export type Rgba = [number, number, number, number];

/**
 * Degrees to radians as the runtime converts them: with π written to eight
 * digits (3.1415927), so 90° is π/2 + 2.3e-8 and cos 90° is -2.3e-8, not 0.
 * Measured against spine-core in `tests/spineRuntime.test.ts`; the exact
 * π leaves every matrix off by about 1e-7.
 */
export const DEG_RAD = 3.1415927 / 180;

export interface BoneData {
  index: number;
  name: string;
  /** -1 for a root. */
  parent: number;
  length: number;
  x: number; y: number; rotation: number;
  scaleX: number; scaleY: number; shearX: number; shearY: number;
  inherit: SpineInherit;
  /** Only active while a shown skin lists it (or a bone under it). */
  skinRequired: boolean;
}

export type BlendMode = "normal" | "additive" | "multiply" | "screen";

export interface SlotData {
  index: number;
  name: string;
  bone: number;
  color: Rgba;
  /** The attachment key shown in the setup pose. */
  attachment: string | null;
  blend: BlendMode;
}

/** One image an attachment can show; a sequence has one per frame. */
export interface Frame {
  /** The atlas region; null when the atlas lacks it (drawn as nothing). */
  region: AtlasRegion | null;
  /** A region attachment's corners in the bone's space (y up): bottom left,
   *  bottom right, top right, top left. Empty for a mesh. */
  corners: Float64Array;
  /** Page UVs, 0..1, v down: a region's four corners, or each mesh vertex. */
  uvs: Float32Array;
}

/** Frames drawn from one path, numbered `start`, `start + 1` … padded to `digits`. */
export interface Sequence { count: number; start: number; digits: number; setup: number }

interface AttachmentBase {
  name: string;
  color: Rgba;
  /** One frame, or one per sequence frame. */
  frames: Frame[];
  sequence: Sequence | null;
  /** Whose deform and sequence keys this attachment plays: itself, or a
   *  linked mesh's source. */
  timeline: AttachmentData;
}

export interface RegionData extends AttachmentBase { kind: "region" }

export interface MeshData extends AttachmentBase {
  kind: "mesh";
  vertexCount: number;
  weighted: boolean;
  /** Unweighted: x y per vertex in the bone's space. Weighted: per vertex its
   *  bone count, then bone index, x, y and weight for each bone. */
  vertices: Float64Array;
  /** A deform key's length: 2 per vertex, or 2 per bone influence when weighted. */
  deformLength: number;
  /** The image's own UVs (0..1 over the whole image, v down), per vertex. */
  regionUVs: Float64Array;
  triangles: Uint32Array;
}

export type AttachmentData = RegionData | MeshData;

export interface SkinData {
  name: string;
  /** slot index → attachment key → attachment. */
  attachments: Map<number, Map<string, AttachmentData>>;
  /** The skin-required bones it enables. */
  bones: number[];
}

export type SequenceMode = "hold" | "once" | "loop" | "pingpong" | "onceReverse" | "loopReverse" | "pingpongReverse";

/** How a key's interval runs to the next key: linear, held, or the runtime's
 *  ten-segment polyline of the bezier, as [t0,v0, t1,v1, …]. */
export type Interval = null | "stepped" | Float64Array;

export interface Channel {
  times: number[];
  values: number[];
  /** One per key; the last is unused. */
  curves: Interval[];
}

export type BoneProp = "rotate" | "x" | "y" | "scaleX" | "scaleY" | "shearX" | "shearY";

export type Timeline =
  | { kind: "bone"; bone: number; prop: BoneProp; channel: Channel }
  /** One colour channel of a slot: 0 r, 1 g, 2 b, 3 a. */
  | { kind: "color"; slot: number; index: number; channel: Channel }
  | { kind: "attachment"; slot: number; times: number[]; names: Array<string | null> }
  /** Each key's draw order as slot indices back to front; null = the setup order. */
  | { kind: "drawOrder"; times: number[]; orders: Array<number[] | null> }
  /** A mesh's vertices per key: absolute positions when unweighted, offsets
   *  added to each bone influence when weighted. `curves` run 0..1 between keys. */
  | { kind: "deform"; slot: number; attachment: MeshData; times: number[]; curves: Interval[]; vertices: Float64Array[] }
  /** Which sequence frame a slot shows, from each key on. */
  | { kind: "sequence"; slot: number; attachment: AttachmentData; times: number[]; modes: SequenceMode[]; indices: number[]; delays: number[] };

export interface AnimationData {
  name: string;
  /** Seconds: the last key's time on any timeline, supported or not. */
  duration: number;
  timelines: Timeline[];
}

export interface RigData {
  bones: BoneData[];
  slots: SlotData[];
  skins: SkinData[];
  animations: AnimationData[];
  /** The editor's frame rate, or 0 when the file has none. */
  fps: number;
  /** What the file uses that this runtime does not play yet, for the preview to show. */
  unsupported: string[];
}

type Json = Record<string, unknown>;
const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** "rrggbbaa" or "rrggbb" as 0..1 channels; alpha 1 when absent. */
export function parseColor(hex: unknown, fallback: Rgba = [1, 1, 1, 1]): Rgba {
  if (typeof hex !== "string" || hex.length < 6) return [...fallback] as Rgba;
  const c = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [c(0), c(2), c(4), hex.length >= 8 ? c(6) : 1];
}

export function readRig(json: unknown, atlas: Atlas): RigData {
  const file = obj(json);
  const unsupported = new Set<string>();

  const bones: BoneData[] = [];
  const boneIndex = new Map<string, number>();
  for (const b of list(file.bones)) {
    const name = String(b.name);
    const inherit = (typeof b.inherit === "string" ? b.inherit : "normal") as SpineInherit;
    if (inherit !== "normal") unsupported.add(`inherit mode "${inherit}"`);
    const bone: BoneData = {
      index: bones.length, name, parent: typeof b.parent === "string" ? boneIndex.get(b.parent) ?? -1 : -1,
      length: num(b.length, 0),
      x: num(b.x, 0), y: num(b.y, 0), rotation: num(b.rotation, 0),
      scaleX: num(b.scaleX, 1), scaleY: num(b.scaleY, 1), shearX: num(b.shearX, 0), shearY: num(b.shearY, 0),
      inherit, skinRequired: b.skin === true,
    };
    boneIndex.set(name, bone.index);
    bones.push(bone);
  }

  const slots: SlotData[] = [];
  const slotIndex = new Map<string, number>();
  for (const s of list(file.slots)) {
    const bone = boneIndex.get(String(s.bone));
    if (bone === undefined) throw new Error(`Slot "${String(s.name)}" names a bone "${String(s.bone)}" the skeleton lacks.`);
    if (typeof s.dark === "string") unsupported.add("two-colour tint");
    const slot: SlotData = {
      index: slots.length, name: String(s.name), bone, color: parseColor(s.color),
      attachment: typeof s.attachment === "string" ? s.attachment : null,
      blend: (["additive", "multiply", "screen"].includes(s.blend as string) ? s.blend : "normal") as BlendMode,
    };
    slotIndex.set(slot.name, slot.index);
    slots.push(slot);
  }

  if (list(file.constraints).length) {
    for (const k of list(file.constraints)) unsupported.add(`${String(k.type ?? "ik")} constraints`);
  }
  for (const kind of ["ik", "transform", "path", "physics", "slider"]) {
    if (list(file[kind]).length) unsupported.add(`${kind} constraints`);
  }

  const regions = new Map<string, AtlasRegion>();
  for (const r of atlas.regions) if (!regions.has(r.name)) regions.set(r.name, r);

  const skins: SkinData[] = [];
  // A linked mesh takes its source's geometry, which may be in a skin read later.
  const linked: Array<{ mesh: MeshData; a: Json; skin: string; slot: number }> = [];
  for (const sk of list(file.skins)) {
    const skin: SkinData = {
      name: String(sk.name), attachments: new Map(),
      bones: (Array.isArray(sk.bones) ? sk.bones : []).map((n) => boneIndex.get(String(n))).filter((i): i is number => i !== undefined),
    };
    for (const [slotName, entries] of Object.entries(obj(sk.attachments))) {
      const slot = slotIndex.get(slotName);
      if (slot === undefined) continue;
      const byKey = new Map<string, AttachmentData>();
      for (const [key, raw] of Object.entries(obj(entries))) {
        const a = obj(raw);
        const type = typeof a.type === "string" ? a.type : "region";
        if (type === "region") byKey.set(key, readRegion(key, a, regions));
        else if (type === "mesh") byKey.set(key, readMesh(key, a, regions));
        else if (type === "linkedmesh") {
          const mesh = readMesh(key, { ...a, vertices: [], uvs: [], triangles: [] }, regions);
          linked.push({ mesh, a, skin: typeof a.skin === "string" ? a.skin : "default", slot });
          byKey.set(key, mesh);
        } else unsupported.add(`${type} attachments`);
      }
      skin.attachments.set(slot, byKey);
    }
    skins.push(skin);
  }
  for (const { mesh, a, skin, slot } of linked) {
    const source = skins.find((s) => s.name === skin)?.attachments.get(slot)?.get(String(a.source ?? a.parent));
    if (source?.kind !== "mesh") { unsupported.add("linked meshes without their source"); continue; }
    linkMesh(mesh, source, a.timelines !== false);
  }

  const animations: AnimationData[] = [];
  for (const [name, raw] of Object.entries(obj(file.animations))) {
    animations.push(readAnimation(name, obj(raw), boneIndex, slotIndex, slots.length, skins, unsupported));
  }

  return {
    bones, slots, skins, animations,
    // Absent stays 0, as the runtime leaves it; the preview falls back to 24.
    fps: num(obj(file.skeleton).fps, 0),
    unsupported: [...unsupported].sort(),
  };
}

/** The sequence an attachment declares, or null. */
function readSequence(a: Json): Sequence | null {
  if (!a.sequence || typeof a.sequence !== "object") return null;
  const q = a.sequence as Json;
  return { count: Math.max(1, num(q.count, 1)), start: num(q.start, 1), digits: num(q.digits, 0), setup: num(q.setup, 0) };
}

/** The region path each frame shows: the path itself, or one per sequence frame. */
function framePaths(path: string, sequence: Sequence | null): string[] {
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
function readRegion(key: string, a: Json, regions: Map<string, AtlasRegion>): RegionData {
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
  const out: RegionData = { kind: "region", name, color: parseColor(a.color), frames, sequence, timeline: null! };
  out.timeline = out;
  return out;
}

/**
 * Image UVs (0..1 over the whole, untrimmed image, v down) to page UVs: into
 * the trimmed pixels' box, then turned as the packer turned the region.
 */
function pageUVs(region: AtlasRegion | null, image: ArrayLike<number>, out: Float32Array): void {
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
function readMesh(key: string, a: Json, regions: Map<string, AtlasRegion>): MeshData {
  const name = typeof a.name === "string" ? a.name : key;
  const path = typeof a.path === "string" ? a.path : name;
  const sequence = readSequence(a);
  const regionUVs = Float64Array.from((a.uvs as number[] | undefined) ?? [], Math.fround);
  const raw = (a.vertices as number[] | undefined) ?? [];
  const vertexCount = regionUVs.length / 2;
  const weighted = raw.length > regionUVs.length;
  let deformLength = vertexCount * 2;
  if (weighted) {
    deformLength = 0;
    for (let i = 0; i < raw.length;) { const n = raw[i]!; deformLength += n * 2; i += 1 + n * 4; }
  }
  const mesh: MeshData = {
    kind: "mesh", name, color: parseColor(a.color), sequence, timeline: null!,
    frames: framePaths(path, sequence).map((p) => ({ region: regions.get(p) ?? null, corners: new Float64Array(0), uvs: new Float32Array(regionUVs.length) })),
    vertexCount, weighted,
    // Weighted streams keep their bone counts and indices exact.
    vertices: weighted ? weightedStream(raw) : Float64Array.from(raw, Math.fround),
    deformLength, regionUVs, triangles: Uint32Array.from((a.triangles as number[] | undefined) ?? []),
  };
  mesh.timeline = mesh;
  for (const f of mesh.frames) pageUVs(f.region, regionUVs, f.uvs);
  return mesh;
}

/** A weighted vertex stream with x, y and weight in 32-bit floats; the
 *  bone counts and indices stay whole. */
function weightedStream(raw: number[]): Float64Array {
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
function linkMesh(mesh: MeshData, source: MeshData, timelines: boolean): void {
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

/** The latest key time anywhere under `v`: every timeline counts toward the
 *  duration, including the ones this runtime does not play. */
function lastTime(v: unknown): number {
  if (Array.isArray(v)) {
    let t = 0;
    for (const e of v) {
      if (e && typeof e === "object" && !Array.isArray(e)) t = Math.max(t, num((e as Json).time, 0));
      t = Math.max(t, lastTime(e));
    }
    return t;
  }
  if (v && typeof v === "object") {
    let t = 0;
    for (const e of Object.values(v as Json)) if (e && typeof e === "object") t = Math.max(t, lastTime(e));
    return t;
  }
  return 0;
}

/** The scalar channels of a timeline's keys: `pick(key, i)` reads channel
 *  `i`; the key's curve holds four numbers per channel, in order. */
function channels(keys: Json[], count: number, pick: (k: Json, i: number) => number): Channel[] {
  const out: Channel[] = [];
  // The runtime keeps key times, values and its curve polylines in 32-bit
  // floats; matching that is what holds the pose to it within rounding.
  const f = Math.fround;
  for (let c = 0; c < count; c++) {
    const times = keys.map((k) => f(num(k.time, 0)));
    const values = keys.map((k) => f(pick(k, c)));
    const curves = keys.map((k, i): Interval => {
      const next = i + 1 < keys.length;
      if (!next || k.curve === undefined) return null;
      if (k.curve === "stepped") return "stepped";
      if (!Array.isArray(k.curve)) return null;
      const cv = k.curve as number[];
      return spinePolyline({
        x0: times[i]!, y0: values[i]!,
        c1x: num(cv[c * 4], times[i]!), c1y: num(cv[c * 4 + 1], values[i]!),
        c2x: num(cv[c * 4 + 2], times[i + 1]!), c2y: num(cv[c * 4 + 3], values[i + 1]!),
        x1: times[i + 1]!, y1: values[i + 1]!,
      }).map(f);
    });
    out.push({ times, values, curves });
  }
  return out;
}

const BONE_TIMELINES: Record<string, { props: BoneProp[]; fields: string[]; neutral: number }> = {
  rotate: { props: ["rotate"], fields: ["value"], neutral: 0 },
  translate: { props: ["x", "y"], fields: ["x", "y"], neutral: 0 },
  translatex: { props: ["x"], fields: ["value"], neutral: 0 },
  translatey: { props: ["y"], fields: ["value"], neutral: 0 },
  scale: { props: ["scaleX", "scaleY"], fields: ["x", "y"], neutral: 1 },
  scalex: { props: ["scaleX"], fields: ["value"], neutral: 1 },
  scaley: { props: ["scaleY"], fields: ["value"], neutral: 1 },
  shear: { props: ["shearX", "shearY"], fields: ["x", "y"], neutral: 0 },
  shearx: { props: ["shearX"], fields: ["value"], neutral: 0 },
  sheary: { props: ["shearY"], fields: ["value"], neutral: 0 },
};

function readAnimation(
  name: string, raw: Json, boneIndex: Map<string, number>, slotIndex: Map<string, number>,
  slotCount: number, skins: SkinData[], unsupported: Set<string>,
): AnimationData {
  const timelines: Timeline[] = [];

  for (const [boneName, groups] of Object.entries(obj(raw.bones))) {
    const bone = boneIndex.get(boneName);
    if (bone === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      const spec = BONE_TIMELINES[kind];
      if (!spec) { unsupported.add(`${kind} keys`); continue; }
      const chans = channels(keys, spec.props.length, (k, i) => num(k[spec.fields[i]!], spec.neutral));
      spec.props.forEach((prop, i) => timelines.push({ kind: "bone", bone, prop, channel: chans[i]! }));
    }
  }

  for (const [slotName, groups] of Object.entries(obj(raw.slots))) {
    const slot = slotIndex.get(slotName);
    if (slot === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "attachment") {
        timelines.push({
          kind: "attachment", slot, times: keys.map((k) => Math.fround(num(k.time, 0))),
          names: keys.map((k) => (typeof k.name === "string" ? k.name : null)),
        });
      } else if (kind === "rgba" || kind === "rgb") {
        const n = kind === "rgba" ? 4 : 3;
        const chans = channels(keys, n, (k, i) => parseColor(k.color)[i]!);
        chans.forEach((channel, index) => timelines.push({ kind: "color", slot, index, channel }));
      } else if (kind === "alpha") {
        const [channel] = channels(keys, 1, (k) => num(k.value, 1));
        timelines.push({ kind: "color", slot, index: 3, channel: channel! });
      } else {
        unsupported.add(`${kind} keys`);
      }
    }
  }

  const drawOrder = list(raw.drawOrder ?? raw.draworder);
  if (drawOrder.length) {
    timelines.push({
      kind: "drawOrder", times: drawOrder.map((k) => Math.fround(num(k.time, 0))),
      orders: drawOrder.map((k) => (Array.isArray(k.offsets) ? orderFromOffsets(list(k.offsets), slotIndex, slotCount) : null)),
    });
  }

  for (const [skinName, bySlot] of Object.entries(obj(raw.attachments))) {
    const skin = skins.find((s) => s.name === skinName);
    for (const [slotName, byAttachment] of Object.entries(obj(bySlot))) {
      const slot = slotIndex.get(slotName);
      if (!skin || slot === undefined) continue;
      for (const [key, groups] of Object.entries(obj(byAttachment))) {
        const attachment = skin.attachments.get(slot)?.get(key);
        if (!attachment) continue;
        for (const [kind, keysRaw] of Object.entries(obj(groups))) {
          const keys = list(keysRaw);
          if (!keys.length) continue;
          if (kind === "deform" && attachment.kind === "mesh") timelines.push(readDeform(slot, attachment, keys));
          else if (kind === "sequence") {
            // A key without a delay keeps the one before it; mode and index
            // do not carry (measured against spine-core).
            let delay = 0;
            const delays = keys.map((k) => (delay = typeof k.delay === "number" ? Math.fround(k.delay) : delay));
            timelines.push({
              kind: "sequence", slot, attachment, times: keys.map((k) => Math.fround(num(k.time, 0))),
              modes: keys.map((k) => (typeof k.mode === "string" ? k.mode : "hold") as SequenceMode),
              indices: keys.map((k) => num(k.index, 0)),
              delays,
            });
          } else unsupported.add(`${kind} keys`);
        }
      }
    }
  }

  if (list(raw.events).length) unsupported.add("events");
  for (const group of ["ik", "transform", "path", "physics", "slider"]) {
    if (Object.keys(obj(raw[group])).length) unsupported.add(`${group} keys`);
  }

  return { name, duration: lastTime(raw), timelines };
}

/**
 * A deform timeline. A key lists vertex values from `offset`, the rest 0; an
 * unweighted mesh's key is stored as the setup vertices plus those values (so
 * the pose reads it as positions), a weighted one's as the values alone. As
 * the runtime does, both in 32-bit floats.
 */
function readDeform(slot: number, mesh: MeshData, keys: Json[]): Timeline {
  const times = keys.map((k) => Math.fround(num(k.time, 0)));
  const vertices = keys.map((k) => {
    const out = new Float64Array(mesh.deformLength);
    if (!mesh.weighted) out.set(mesh.vertices.subarray(0, mesh.deformLength));
    const values = (k.vertices as number[] | undefined) ?? [];
    const at = num(k.offset, 0);
    for (let i = 0; i < values.length && at + i < out.length; i++) out[at + i] = out[at + i]! + values[i]!;
    return out.map(Math.fround);
  });
  const curves = keys.map((k, i): Interval => {
    if (i + 1 >= keys.length || k.curve === undefined) return null;
    if (k.curve === "stepped") return "stepped";
    if (!Array.isArray(k.curve)) return null;
    const cv = k.curve as number[];
    return spinePolyline({
      x0: times[i]!, y0: 0, c1x: num(cv[0], times[i]!), c1y: num(cv[1], 0),
      c2x: num(cv[2], times[i + 1]!), c2y: num(cv[3], 1), x1: times[i + 1]!, y1: 1,
    }).map(Math.fround);
  });
  return { kind: "deform", slot, attachment: mesh, times, curves, vertices };
}

/**
 * A draw order key: each listed slot moves `offset` places from where the
 * setup order has it; every other slot keeps its setup order in the places
 * left.
 */
export function orderFromOffsets(offsets: Json[], slotIndex: Map<string, number>, count: number): number[] {
  const order = new Array<number>(count).fill(-1);
  const moved = new Set<number>();
  for (const o of offsets) {
    const slot = slotIndex.get(String(o.slot));
    if (slot === undefined) continue;
    const at = slot + num(o.offset, 0);
    if (at >= 0 && at < count) { order[at] = slot; moved.add(slot); }
  }
  let next = 0;
  for (let slot = 0; slot < count; slot++) {
    if (moved.has(slot)) continue;
    while (order[next] !== -1) next++;
    order[next++] = slot;
  }
  return order;
}
