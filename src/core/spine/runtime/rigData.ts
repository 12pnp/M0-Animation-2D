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
 * the bone, attachment, colour and draw order timelines. Whatever else a file
 * holds is listed in `unsupported`, so the preview can say so instead of
 * silently drawing something else.
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

export interface RegionData {
  kind: "region";
  name: string;
  /** The atlas region; null when the atlas lacks it (drawn as nothing). */
  region: AtlasRegion | null;
  color: Rgba;
  /** The four corners in the bone's space (y up), counter-clockwise from the
   *  bottom left: x0 y0 … x3 y3. */
  corners: Float64Array;
  /** The page UVs of those corners, 0..1, v down. */
  uvs: Float32Array;
}

export type AttachmentData = RegionData;

export interface SkinData {
  name: string;
  /** slot index → attachment key → attachment. */
  attachments: Map<number, Map<string, AttachmentData>>;
}

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
  | { kind: "drawOrder"; times: number[]; orders: Array<number[] | null> };

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
    if (b.skin) unsupported.add("bones only in some skins");
    const bone: BoneData = {
      index: bones.length, name, parent: typeof b.parent === "string" ? boneIndex.get(b.parent) ?? -1 : -1,
      length: num(b.length, 0),
      x: num(b.x, 0), y: num(b.y, 0), rotation: num(b.rotation, 0),
      scaleX: num(b.scaleX, 1), scaleY: num(b.scaleY, 1), shearX: num(b.shearX, 0), shearY: num(b.shearY, 0),
      inherit,
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
  for (const sk of list(file.skins)) {
    const skin: SkinData = { name: String(sk.name), attachments: new Map() };
    for (const [slotName, entries] of Object.entries(obj(sk.attachments))) {
      const slot = slotIndex.get(slotName);
      if (slot === undefined) continue;
      const byKey = new Map<string, AttachmentData>();
      for (const [key, raw] of Object.entries(obj(entries))) {
        const a = obj(raw);
        const type = typeof a.type === "string" ? a.type : "region";
        if (type !== "region") { unsupported.add(`${type} attachments`); continue; }
        if (a.sequence) unsupported.add("sequences");
        byKey.set(key, readRegion(key, a, regions));
      }
      skin.attachments.set(slot, byKey);
    }
    skins.push(skin);
  }

  const animations: AnimationData[] = [];
  for (const [name, raw] of Object.entries(obj(file.animations))) {
    animations.push(readAnimation(name, obj(raw), boneIndex, slotIndex, slots.length, unsupported));
  }

  return {
    bones, slots, skins, animations,
    fps: num(obj(file.skeleton).fps, 30),
    unsupported: [...unsupported].sort(),
  };
}

/**
 * The region's corners in the bone's space. The attachment is `width` ×
 * `height` about its centre (`x`, `y`), turned by `rotation` and scaled; the
 * atlas region may hold only the trimmed part of the original image, placed
 * at its offsets (y from the bottom) and stretched by the attachment's size
 * over the original's.
 */
function readRegion(key: string, a: Json, regions: Map<string, AtlasRegion>): RegionData {
  const name = typeof a.name === "string" ? a.name : key;
  const path = typeof a.path === "string" ? a.path : name;
  const region = regions.get(path) ?? null;
  const width = num(a.width, 32), height = num(a.height, 32);
  const sx = num(a.scaleX, 1), sy = num(a.scaleY, 1);
  const rad = num(a.rotation, 0) * DEG_RAD;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const x = num(a.x, 0), y = num(a.y, 0);

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

  const uvs = new Float32Array(8);
  if (region && region.page.width > 0 && region.page.height > 0) {
    const pw = region.page.width, ph = region.page.height;
    if (region.degrees === 90) {
      // Packed turned a quarter clockwise: the region's width runs down the
      // page, its height across.
      const u0 = region.x / pw, v0 = region.y / ph;
      const u1 = (region.x + region.height) / pw, v1 = (region.y + region.width) / ph;
      uvs.set([u1, v1, u1, v0, u0, v0, u0, v1]);
    } else {
      const u0 = region.x / pw, v0 = region.y / ph;
      const u1 = (region.x + region.width) / pw, v1 = (region.y + region.height) / ph;
      // Bottom left, bottom right, top right, top left; v runs down the page.
      uvs.set([u0, v1, u1, v1, u1, v0, u0, v0]);
    }
  }
  return { kind: "region", name, region, color: parseColor(a.color), corners, uvs };
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
  slotCount: number, unsupported: Set<string>,
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
          kind: "attachment", slot, times: keys.map((k) => num(k.time, 0)),
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
      kind: "drawOrder", times: drawOrder.map((k) => num(k.time, 0)),
      orders: drawOrder.map((k) => (Array.isArray(k.offsets) ? orderFromOffsets(list(k.offsets), slotIndex, slotCount) : null)),
    });
  }

  if (list(raw.events).length) unsupported.add("events");
  for (const group of ["ik", "transform", "path", "physics", "slider", "attachments"]) {
    if (Object.keys(obj(raw[group])).length) unsupported.add(group === "attachments" ? "deform and sequence keys" : `${group} keys`);
  }

  return { name, duration: lastTime(raw), timelines };
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
