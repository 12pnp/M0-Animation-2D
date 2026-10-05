import type { BoneBurstInherit } from "../types";
import type { Atlas, AtlasRegion } from "./atlasRead";
import { boneburstPolyline } from "@/core/math/easing";

/**
 * A Spine 4.3 skeleton JSON read into the BoneBurst runtime's model
 * (docs/PREVIEW-RUNTIME-PLAN.md). Written from the format, held to
 * spine-core by `tests/spineRuntime.test.ts`; nothing here is taken from
 * spine-core's source.
 *
 * P0 covers bones, slots, region attachments, skins and
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
  inherit: BoneBurstInherit;
  /** Only active while a shown skin lists it (or a bone under it). */
  skinRequired: boolean;
}

export type BlendMode = "normal" | "additive" | "multiply" | "screen";

export interface SlotData {
  index: number;
  name: string;
  bone: number;
  color: Rgba;
  /** Two-colour tint's dark colour (r g b), or null for a single tint. */
  dark: [number, number, number] | null;
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
  /** Slots besides its own where its deform and sequence keys also play:
   *  those of meshes linked to it from another slot. */
  timelineSlots: number[];
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

/** A path: a bezier through its vertices (an in-handle, a point, an
 *  out-handle each), weighted or not, drawn as nothing. */
export interface PathData {
  kind: "path";
  name: string;
  color: Rgba;
  frames: Frame[];
  sequence: null;
  timeline: AttachmentData;
  vertexCount: number;
  weighted: boolean;
  vertices: Float64Array;
  deformLength: number;
  closed: boolean;
  constantSpeed: boolean;
  /** Each curve's length, from the setup pose, used when not constant speed. */
  lengths: number[];
}

/** A clipping polygon: the slots from its own to `end` draw only inside it
 *  (outside, when `inverse`). Weighted or not, as a mesh. */
export interface ClippingData {
  kind: "clipping";
  name: string;
  color: Rgba;
  frames: Frame[];
  sequence: null;
  timeline: AttachmentData;
  vertexCount: number;
  weighted: boolean;
  vertices: Float64Array;
  deformLength: number;
  /** The last slot clipped, or -1 for every slot after it. */
  end: number;
  inverse: boolean;
}

/** A bounding box: a polygon for hit tests, weighted or not, drawn as nothing. */
export interface BoxData {
  kind: "box";
  name: string;
  color: Rgba;
  frames: Frame[];
  sequence: null;
  timeline: AttachmentData;
  vertexCount: number;
  weighted: boolean;
  vertices: Float64Array;
  deformLength: number;
}

/** A point: a position and an angle in the bone's space, drawn as nothing. */
export interface PointData {
  kind: "point";
  name: string;
  color: Rgba;
  frames: Frame[];
  sequence: null;
  timeline: AttachmentData;
  x: number;
  y: number;
  rotation: number;
}

export type AttachmentData = RegionData | MeshData | PathData | ClippingData | BoxData | PointData;

export interface SkinData {
  name: string;
  /** slot index → attachment key → attachment. */
  attachments: Map<number, Map<string, AttachmentData>>;
  /** The skin-required bones it enables. */
  bones: number[];
  /** The skin-required constraints it enables, by index in `RigData.constraints`. */
  constraints: number[];
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

/** A timeline of ours, from one of the file's (`unit`), whose property ids
 *  (`ids`) decide how it mixes with another animation's (`Track`). */
export type Timeline = TimelineBody & { unit: number; ids: string[] };

export type TimelineBody =
  | { kind: "bone"; bone: number; prop: BoneProp; channel: Channel }
  /** One colour channel of a slot: 0 r, 1 g, 2 b, 3 a; 4 5 6 the dark colour's r g b. */
  | { kind: "color"; slot: number; index: number; channel: Channel }
  | { kind: "attachment"; slot: number; times: number[]; names: Array<string | null> }
  /** Each key's draw order as slot indices back to front; null = the setup order. */
  | { kind: "drawOrder"; times: number[]; orders: Array<number[] | null> }
  /** A mesh's vertices per key: absolute positions when unweighted, offsets
   *  added to each bone influence when weighted. `curves` run 0..1 between keys. */
  | { kind: "deform"; slot: number; attachment: MeshData | PathData | ClippingData | BoxData; times: number[]; curves: Interval[]; vertices: Float64Array[] }
  /** An IK constraint's values from each key on: mix and softness curved, the rest held. */
  | { kind: "ik"; constraint: number; times: number[]; mix: Channel; softness: Channel; bendPositive: boolean[]; compress: boolean[]; stretch: boolean[] }
  /** Events, fired as the track passes their keys (`Track`). */
  | { kind: "event"; times: number[]; events: EventFire[] }
  /** A physics value, curved, absolute (mass mixed as mass, then inverted);
   *  `constraint` -1 sets every constraint whose value is global. */
  | { kind: "physics"; constraint: number; prop: PhysicsProp; times: number[]; channel: Channel }
  /** Physics resets as the track passes these keys. */
  | { kind: "physicsReset"; constraint: number; times: number[] }
  /** A slider's time or mix, curved, absolute. */
  | { kind: "sliderTime" | "sliderMix"; constraint: number; times: number[]; channel: Channel }
  /** A path constraint's position, spacing, or mixes (rotate, x, y), curved. */
  | { kind: "pathPosition" | "pathSpacing"; constraint: number; times: number[]; channel: Channel }
  | { kind: "pathMix"; constraint: number; times: number[]; rotate: Channel; x: Channel; y: Channel }
  /** A transform constraint's six mixes, curved. */
  | { kind: "transform"; constraint: number; times: number[]; mixes: Record<TransformProp, Channel> }
  /** A bone's inherit mode from each key on. */
  | { kind: "inherit"; bone: number; times: number[]; modes: BoneBurstInherit[] }
  /** Which sequence frame a slot shows, from each key on. */
  | { kind: "sequence"; slot: number; attachment: AttachmentData; times: number[]; modes: SequenceMode[]; indices: number[]; delays: number[] };

export interface AnimationData {
  name: string;
  /** Seconds: the last key's time on any timeline, supported or not. */
  duration: number;
  timelines: Timeline[];
  /** How many of the file's timelines `timelines` came from. */
  units: number;
  /** Every property id its timelines set. */
  ids: Set<string>;
}

/** How an IK stretch or squash carries to the bone's y scale. */
export type IkScaleY = "none" | "uniform" | "volume";

export interface IkData {
  kind: "ik";
  name: string;
  /** One bone, or a parent and its child. */
  bones: number[];
  target: number;
  mix: number;
  softness: number;
  bendPositive: boolean;
  compress: boolean;
  stretch: boolean;
  scaleY: IkScaleY;
  /** Only active while a shown skin lists it. */
  skinRequired: boolean;
}

/** The six bone properties a transform constraint reads and drives. */
export type TransformProp = "rotate" | "x" | "y" | "scaleX" | "scaleY" | "shearY";
export const TRANSFORM_PROPS: readonly TransformProp[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];

/** The six mixes, one per driven property. */
export type TransformMix = Record<TransformProp, number>;

export interface TransformData {
  kind: "transform";
  name: string;
  bones: number[];
  source: number;
  localSource: boolean;
  localTarget: boolean;
  additive: boolean;
  clamp: boolean;
  /** Added to the source's value of each property before it is read. */
  offsets: Record<TransformProp, number>;
  /** Each source property, less its offset, drives target properties: each
   *  `offset + value × scale`, clamped toward `max` when `clamp`. */
  properties: Array<{ from: TransformProp; offset: number; to: Array<{ prop: TransformProp; offset: number; max: number; scale: number }> }>;
  mix: TransformMix;
  skinRequired: boolean;
}

export interface PathConstraintData {
  kind: "path";
  name: string;
  bones: number[];
  /** The slot whose path attachment the bones follow. */
  slot: number;
  positionMode: "fixed" | "percent";
  spacingMode: "length" | "fixed" | "percent" | "proportional";
  rotateMode: "tangent" | "chain" | "chainScale";
  /** Degrees added to each bone's turn. */
  offsetRotation: number;
  position: number;
  spacing: number;
  mixRotate: number;
  mixX: number;
  mixY: number;
  skinRequired: boolean;
}

/**
 * Spine 4.3's slider: it plays an animation at a time — its own, or read off
 * a bone's property: `to + (value − from) × scale` — mixed in by `mix`,
 * from the current pose or added. Measured against spine-core: the property
 * is read as a transform constraint reads it (no offsets); a time below 0 is
 * 0, except that a bone-driven time that loops wraps into the animation,
 * negative ones included; `max` changes nothing played.
 */
export interface SliderData {
  kind: "slider";
  name: string;
  /** Index in `RigData.animations`. */
  animation: number;
  /** The bone whose property sets the time, or -1. */
  bone: number;
  property: TransformProp;
  local: boolean;
  from: number;
  to: number;
  scale: number;
  loop: boolean;
  additive: boolean;
  time: number;
  mix: number;
  skinRequired: boolean;
  /** The bones its animation keys, to rebuild after it. */
  bones: number[];
}

/** The values a physics constraint's keys can set. */
export type PhysicsProp = "inertia" | "strength" | "damping" | "mass" | "wind" | "gravity" | "mix";
export const PHYSICS_PROPS: readonly PhysicsProp[] = ["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"];

/**
 * Spine 4.3's physics constraint: a bone's position, rotation, x scale and x
 * shear (weighted by `x` … `shearX`) lag behind and spring back, simulated in
 * fixed steps of `step` seconds (`physics.ts`). Defaults are 4.3's (inertia
 * 0.5, damping 0.85), read off spine-core.
 */
export interface PhysicsData {
  kind: "physics";
  name: string;
  bone: number;
  x: number;
  y: number;
  rotate: number;
  scaleX: number;
  shearX: number;
  /** The most the bone's movement can add to an offset per second. */
  limit: number;
  step: number;
  inertia: number;
  strength: number;
  damping: number;
  /** 1 / mass, as spine-core keeps it. */
  massInverse: number;
  wind: number;
  gravity: number;
  mix: number;
  /** Which values a key for every constraint at once (an unnamed timeline) sets. */
  global: Record<PhysicsProp, boolean>;
  skinRequired: boolean;
}

/** Every constraint, in the order they apply. */
export type ConstraintData = IkData | TransformData | PathConstraintData | SliderData | PhysicsData;

/**
 * A transform constraint's mixes, as spine-core 4.3.13 reads them (measured):
 * only for the properties its map drives, absent ones 1 — but y's mix is read
 * only when x is driven (absent: x's), and scale y's only when scale x is
 * (absent: scale x's), so a map that drives y and not x leaves y's mix 0.
 */
function constraintMixes(k: Json, driven: ReadonlySet<TransformProp>): TransformMix {
  const m: TransformMix = { rotate: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 };
  if (driven.has("rotate")) m.rotate = num(k.mixRotate, 1);
  if (driven.has("x")) { m.x = num(k.mixX, 1); m.y = num(k.mixY, m.x); }
  if (driven.has("scaleX")) { m.scaleX = num(k.mixScaleX, 1); m.scaleY = num(k.mixScaleY, m.scaleX); }
  if (driven.has("shearY")) m.shearY = num(k.mixShearY, 1);
  return m;
}

/** A transform key's mixes: absent ones 1, except y, which takes x's
 *  (scale y does not take scale x's; measured). */
function keyMixes(k: Json): TransformMix {
  const x = num(k.mixX, 1);
  return {
    rotate: num(k.mixRotate, 1), x, y: num(k.mixY, x),
    scaleX: num(k.mixScaleX, 1), scaleY: num(k.mixScaleY, 1), shearY: num(k.mixShearY, 1),
  };
}

/** An event as a key fires it: the key's values over the event's own. */
export interface EventFire {
  name: string;
  int: number;
  float: number;
  string: string;
  audio: string | null;
  volume: number;
  balance: number;
}

export interface RigData {
  bones: BoneData[];
  slots: SlotData[];
  /** In the order they apply: the file's. */
  constraints: ConstraintData[];
  skins: SkinData[];
  animations: AnimationData[];
  /** The editor's frame rate, or 0 when the file has none. */
  fps: number;
  /** Pixels per unit physics forces are given in (`skeleton.referenceScale`). */
  referenceScale: number;
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
    const inherit = (typeof b.inherit === "string" ? b.inherit : "normal") as BoneBurstInherit;
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
    const slot: SlotData = {
      index: slots.length, name: String(s.name), bone, color: parseColor(s.color),
      dark: typeof s.dark === "string" ? parseColor(s.dark).slice(0, 3) as [number, number, number] : null,
      attachment: typeof s.attachment === "string" ? s.attachment : null,
      blend: (["additive", "multiply", "screen"].includes(s.blend as string) ? s.blend : "normal") as BlendMode,
    };
    slotIndex.set(slot.name, slot.index);
    slots.push(slot);
  }

  const constraints: ConstraintData[] = [];
  const constraintIndex = new Map<string, number>();
  // A slider names its animation, which is read later.
  const sliderAnimations = new Map<number, string>();
  // 4.3 lists every constraint in one array, in order; older files kept one
  // list per kind.
  const declared: Json[] = [
    ...list(file.constraints),
    ...["ik", "transform", "path", "physics", "slider"].flatMap((type) => list(file[type]).map((k): Json => ({ type, ...k }))),
  ];
  for (const k of declared) {
    const type = typeof k.type === "string" ? k.type : "ik";
    const name = String(k.name);
    if (type === "ik") {
      const bonesOf = (Array.isArray(k.bones) ? k.bones : []).map((n) => boneIndex.get(String(n)));
      const target = boneIndex.get(String(k.target));
      if (target === undefined || !bonesOf.length || bonesOf.some((b) => b === undefined)) { unsupported.add("IK with unknown bones"); continue; }
      constraintIndex.set(name, constraints.length);
      constraints.push({
        kind: "ik", name, bones: bonesOf as number[], target,
        mix: num(k.mix, 1), softness: num(k.softness, 0), bendPositive: k.bendPositive !== false,
        compress: k.compress === true, stretch: k.stretch === true,
        scaleY: (k.scaleY === "uniform" || k.scaleY === "volume" ? k.scaleY : k.uniform === true ? "uniform" : "none") as IkScaleY,
        skinRequired: k.skin === true,
      });
    } else if (type === "transform") {
      const bonesOf = (Array.isArray(k.bones) ? k.bones : []).map((n) => boneIndex.get(String(n)));
      const source = boneIndex.get(String(k.source ?? k.target));
      if (source === undefined || bonesOf.some((b) => b === undefined)) { unsupported.add("transform constraints with unknown bones"); continue; }
      constraintIndex.set(name, constraints.length);
      const props = obj(k.properties);
      const driven = new Set<TransformProp>(Object.values(props).flatMap((f) => Object.keys(obj(obj(f).to)) as TransformProp[]));
      constraints.push({
        kind: "transform", name, bones: bonesOf as number[], source,
        localSource: k.localSource === true, localTarget: k.localTarget === true,
        additive: k.additive === true, clamp: k.clamp === true,
        offsets: {
          rotate: num(k.rotation, 0), x: num(k.x, 0), y: num(k.y, 0),
          scaleX: num(k.scaleX, 0), scaleY: num(k.scaleY, 0), shearY: num(k.shearY, 0),
        },
        properties: TRANSFORM_PROPS.filter((from) => from in props).map((from) => {
          const f = obj(props[from]);
          const to = obj(f.to);
          return {
            from, offset: num(f.offset, 0),
            to: TRANSFORM_PROPS.filter((p) => p in to).map((prop) => {
              const t = obj(to[prop]);
              return { prop, offset: num(t.offset, 0), max: num(t.max, 1), scale: num(t.scale, 1) };
            }),
          };
        }),
        mix: constraintMixes(k, driven),
        skinRequired: k.skin === true,
      });
    } else if (type === "path") {
      const bonesOf = (Array.isArray(k.bones) ? k.bones : []).map((n) => boneIndex.get(String(n)));
      const slot = slotIndex.get(String(k.slot));
      if (slot === undefined || bonesOf.some((b) => b === undefined)) { unsupported.add("path constraints with unknown bones"); continue; }
      constraintIndex.set(name, constraints.length);
      const mixX = num(k.mixX, 1);
      constraints.push({
        kind: "path", name, bones: bonesOf as number[], slot,
        positionMode: k.positionMode === "fixed" ? "fixed" : "percent",
        spacingMode: (["fixed", "percent", "proportional"].includes(k.spacingMode as string) ? k.spacingMode : "length") as PathConstraintData["spacingMode"],
        rotateMode: (["chain", "chainScale"].includes(k.rotateMode as string) ? k.rotateMode : "tangent") as PathConstraintData["rotateMode"],
        offsetRotation: num(k.rotation, 0), position: num(k.position, 0), spacing: num(k.spacing, 0),
        mixRotate: num(k.mixRotate, 1), mixX, mixY: num(k.mixY, mixX),
        skinRequired: k.skin === true,
      });
    } else if (type === "physics") {
      const bone = boneIndex.get(String(k.bone));
      if (bone === undefined) { unsupported.add("physics with unknown bones"); continue; }
      constraintIndex.set(name, constraints.length);
      constraints.push({
        kind: "physics", name, bone,
        x: num(k.x, 0), y: num(k.y, 0), rotate: num(k.rotate, 0), scaleX: num(k.scaleX, 0), shearX: num(k.shearX, 0),
        limit: num(k.limit, 5000), step: 1 / num(k.fps, 60),
        inertia: num(k.inertia, 0.5), strength: num(k.strength, 100), damping: num(k.damping, 0.85),
        massInverse: 1 / num(k.mass, 1), wind: num(k.wind, 0), gravity: num(k.gravity, 0), mix: num(k.mix, 1),
        global: Object.fromEntries(PHYSICS_PROPS.map((p) => [p, k[`${p}Global`] === true])) as Record<PhysicsProp, boolean>,
        skinRequired: k.skin === true,
      });
    } else if (type === "slider") {
      const bone = typeof k.bone === "string" ? boneIndex.get(k.bone) : undefined;
      if (typeof k.bone === "string" && bone === undefined) { unsupported.add("sliders with unknown bones"); continue; }
      constraintIndex.set(name, constraints.length);
      constraints.push({
        kind: "slider", name, animation: -1, bone: bone ?? -1,
        property: (TRANSFORM_PROPS as readonly string[]).includes(k.property as string) ? k.property as TransformProp : "rotate",
        local: k.local === true, from: num(k.from, 0), to: num(k.to, 0), scale: num(k.scale, 1),
        loop: k.loop === true, additive: k.additive === true, time: num(k.time, 0), mix: num(k.mix, 1),
        skinRequired: k.skin === true, bones: [],
      });
      sliderAnimations.set(constraints.length - 1, String(k.animation));
    } else {
      unsupported.add(`${type} constraints`);
    }
  }

  const regions = new Map<string, AtlasRegion>();
  for (const r of atlas.regions) if (!regions.has(r.name)) regions.set(r.name, r);

  const skins: SkinData[] = [];
  // A linked mesh takes its source's geometry, which may be in a skin read later.
  const linked: Array<{ mesh: MeshData; a: Json; skin: string; slot: number; sourceSlot: number | undefined }> = [];
  for (const sk of list(file.skins)) {
    const skin: SkinData = {
      name: String(sk.name), attachments: new Map(),
      bones: (Array.isArray(sk.bones) ? sk.bones : []).map((n) => boneIndex.get(String(n))).filter((i): i is number => i !== undefined),
      constraints: ["ik", "transform", "path", "physics", "slider"]
        .flatMap((kind) => (Array.isArray(sk[kind]) ? sk[kind] as unknown[] : []))
        .map((n) => constraintIndex.get(String(n))).filter((i): i is number => i !== undefined),
    };
    for (const [slotName, entries] of Object.entries(obj(sk.attachments))) {
      const slot = slotIndex.get(slotName);
      if (slot === undefined) continue;
      const byKey = new Map<string, AttachmentData>();
      for (const [key, raw] of Object.entries(obj(entries))) {
        const a = obj(raw);
        const type = typeof a.type === "string" ? a.type : "region";
        // A mesh is linked when it names a `source`, whatever its type says
        // (Format-Json-Atlas.md §8.4); the source may sit in another `slot`.
        const isLinked = (type === "mesh" || type === "linkedmesh") && typeof a.source === "string";
        if (isLinked) {
          const mesh = readMesh(key, { ...a, vertices: [], uvs: [], triangles: [] }, regions);
          const sourceSlot = typeof a.slot === "string" ? slotIndex.get(a.slot) : slot;
          linked.push({ mesh, a, skin: typeof a.skin === "string" ? a.skin : "default", slot, sourceSlot });
          byKey.set(key, mesh);
        } else if (type === "region") byKey.set(key, readRegion(key, a, regions));
        else if (type === "mesh") byKey.set(key, readMesh(key, a, regions));
        else if (type === "path") byKey.set(key, readPath(key, a));
        else if (type === "clipping") byKey.set(key, readClipping(key, a, slotIndex));
        else if (type === "boundingbox") byKey.set(key, readBox(key, a));
        else if (type === "point") byKey.set(key, readPoint(key, a));
        else if (type === "linkedmesh") unsupported.add("linked meshes without a source");
        else unsupported.add(`${type} attachments`);
      }
      skin.attachments.set(slot, byKey);
    }
    skins.push(skin);
  }
  for (const { mesh, a, skin, slot, sourceSlot } of linked) {
    const source = sourceSlot === undefined ? undefined : skins.find((s) => s.name === skin)?.attachments.get(sourceSlot)?.get(String(a.source));
    if (source?.kind !== "mesh") { unsupported.add("linked meshes without their source"); continue; }
    linkMesh(mesh, source, a.timelines !== false);
    // Its source's keys play in this slot too (§9 step 6).
    if (a.timelines !== false && slot !== sourceSlot && !source.timelineSlots.includes(slot)) source.timelineSlots.push(slot);
  }

  const eventData = new Map<string, EventFire>();
  for (const [name, raw] of Object.entries(obj(file.events))) {
    const e = obj(raw);
    eventData.set(name, {
      name, int: num(e.int, 0), float: num(e.float, 0), string: typeof e.string === "string" ? e.string : "",
      audio: typeof e.audio === "string" ? e.audio : null, volume: num(e.volume, 1), balance: num(e.balance, 0),
    });
  }

  const animations: AnimationData[] = [];
  for (const [name, raw] of Object.entries(obj(file.animations))) {
    animations.push(readAnimation(name, obj(raw), boneIndex, slotIndex, constraintIndex, slots.length, skins, eventData, unsupported));
  }

  for (const [i, animName] of sliderAnimations) {
    const k = constraints[i] as SliderData;
    k.animation = animations.findIndex((a) => a.name === animName);
    if (k.animation < 0) { unsupported.add("sliders without their animation"); continue; }
    k.bones = [...new Set(animations[k.animation]!.timelines.flatMap((t) => (t.kind === "bone" || t.kind === "inherit" ? [t.bone] : [])))];
  }

  return {
    bones, slots, constraints, skins, animations,
    // Absent stays 0, as the runtime leaves it; the preview falls back to 24.
    fps: num(obj(file.skeleton).fps, 0),
    referenceScale: num(obj(file.skeleton).referenceScale, 100),
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
  const out: RegionData = { kind: "region", name, color: parseColor(a.color), frames, sequence, timeline: null!, timelineSlots: [] };
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
    kind: "mesh", name, color: parseColor(a.color), sequence, timeline: null!, timelineSlots: [],
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

/** A path attachment: `vertexCount` vertices, weighted when `vertices` is
 *  longer than two numbers each. */
function readPath(key: string, a: Json): PathData {
  const name = typeof a.name === "string" ? a.name : key;
  const raw = (a.vertices as number[] | undefined) ?? [];
  const vertexCount = num(a.vertexCount, raw.length / 2);
  const weighted = raw.length > vertexCount * 2;
  let deformLength = vertexCount * 2;
  if (weighted) {
    deformLength = 0;
    for (let i = 0; i < raw.length;) { const n = raw[i]!; deformLength += n * 2; i += 1 + n * 4; }
  }
  const path: PathData = {
    kind: "path", name, color: parseColor(a.color), frames: [], sequence: null, timeline: null!,
    vertexCount, weighted, vertices: weighted ? weightedStream(raw) : Float64Array.from(raw, Math.fround), deformLength,
    closed: a.closed === true, constantSpeed: a.constantSpeed !== false,
    lengths: ((a.lengths as number[] | undefined) ?? []).map(Math.fround),
  };
  path.timeline = path;
  return path;
}

/** The vertex stream of a path or clipping polygon: weighted when longer
 *  than two numbers per vertex. */
function vertexStream(raw: number[], vertexCount: number) {
  const weighted = raw.length > vertexCount * 2;
  let deformLength = vertexCount * 2;
  if (weighted) {
    deformLength = 0;
    for (let i = 0; i < raw.length;) { const n = raw[i]!; deformLength += n * 2; i += 1 + n * 4; }
  }
  return { weighted, deformLength, vertices: weighted ? weightedStream(raw) : Float64Array.from(raw, Math.fround) };
}

function readBox(key: string, a: Json): BoxData {
  const raw = (a.vertices as number[] | undefined) ?? [];
  const vertexCount = num(a.vertexCount, raw.length / 2);
  const box: BoxData = {
    kind: "box", name: typeof a.name === "string" ? a.name : key, color: parseColor(a.color),
    frames: [], sequence: null, timeline: null!, vertexCount, ...vertexStream(raw, vertexCount),
  };
  box.timeline = box;
  return box;
}

function readPoint(key: string, a: Json): PointData {
  const point: PointData = {
    kind: "point", name: typeof a.name === "string" ? a.name : key, color: parseColor(a.color),
    frames: [], sequence: null, timeline: null!, x: num(a.x, 0), y: num(a.y, 0), rotation: num(a.rotation, 0),
  };
  point.timeline = point;
  return point;
}

function readClipping(key: string, a: Json, slotIndex: Map<string, number>): ClippingData {
  const raw = (a.vertices as number[] | undefined) ?? [];
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
      // As the runtime stores key times: 32-bit, so a loop wraps where it does.
      if (e && typeof e === "object" && !Array.isArray(e)) t = Math.max(t, Math.fround(num((e as Json).time, 0)));
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
function channels(keys: Json[], count: number, pick: (k: Json, i: number, at: number) => number): Channel[] {
  const out: Channel[] = [];
  // The runtime keeps key times, values and its curve polylines in 32-bit
  // floats; matching that is what holds the pose to it within rounding.
  const f = Math.fround;
  for (let c = 0; c < count; c++) {
    const times = keys.map((k) => f(num(k.time, 0)));
    const values = keys.map((k, at) => f(pick(k, c, at)));
    const curves = keys.map((k, i): Interval => {
      const next = i + 1 < keys.length;
      if (!next || k.curve === undefined) return null;
      if (k.curve === "stepped") return "stepped";
      if (!Array.isArray(k.curve)) return null;
      const cv = k.curve as number[];
      return boneburstPolyline({
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

/** A stable number per attachment, for the property ids of its deform and sequence keys. */
const attachmentIds = new WeakMap<object, number>();
let nextAttachmentId = 1;
function attachmentId(a: object): number {
  let id = attachmentIds.get(a);
  if (id === undefined) attachmentIds.set(a, (id = nextAttachmentId++));
  return id;
}

/** The property ids a bone timeline kind sets, as the mix's hold modes count them. */
const BONE_IDS: Record<string, string[]> = {
  rotate: ["r"], translate: ["x", "y"], translatex: ["x"], translatey: ["y"],
  scale: ["sx", "sy"], scalex: ["sx"], scaley: ["sy"], shear: ["hx", "hy"], shearx: ["hx"], sheary: ["hy"],
};

/** The animation sections `readAnimation` plays. */
const PLAYED_SECTIONS = new Set(["bones", "slots", "ik", "transform", "path", "physics", "slider", "attachments", "drawOrder", "draworder", "events"]);

function readAnimation(
  name: string, raw: Json, boneIndex: Map<string, number>, slotIndex: Map<string, number>,
  constraintIndex: Map<string, number>, slotCount: number, skins: SkinData[],
  eventData: Map<string, EventFire>, unsupported: Set<string>,
): AnimationData {
  const timelines: Timeline[] = [];
  // Each of the file's timelines is one unit, which may be several of ours
  // (one per value channel); a unit's property ids decide its hold mode.
  let units = 0, sealed = 0;
  const seal = (ids: string[]) => {
    const unit = units++;
    for (let i = sealed; i < timelines.length; i++) Object.assign(timelines[i]!, { unit, ids });
    sealed = timelines.length;
  };
  const push = (t: TimelineBody) => timelines.push(t as Timeline);

  // In spine-core's order: slots, bones, constraints, attachments, draw order, events.
  for (const [slotName, groups] of Object.entries(obj(raw.slots))) {
    const slot = slotIndex.get(slotName);
    if (slot === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "attachment") {
        push({
          kind: "attachment", slot, times: keys.map((k) => Math.fround(num(k.time, 0))),
          names: keys.map((k) => (typeof k.name === "string" ? k.name : null)),
        });
        seal([`attachment ${slot}`]);
      } else if (kind === "rgba" || kind === "rgb") {
        const n = kind === "rgba" ? 4 : 3;
        const chans = channels(keys, n, (k, i) => parseColor(k.color)[i]!);
        chans.forEach((channel, index) => push({ kind: "color", slot, index, channel }));
        seal(kind === "rgba" ? [`rgb ${slot}`, `alpha ${slot}`] : [`rgb ${slot}`]);
      } else if (kind === "rgba2" || kind === "rgb2") {
        // The light colour's channels, then the dark's r g b.
        const light = kind === "rgba2" ? 4 : 3;
        const chans = channels(keys, light + 3, (k, i) => (i < light ? parseColor(k.light)[i]! : parseColor(k.dark)[i - light]!));
        chans.forEach((channel, i) => push({ kind: "color", slot, index: i < light ? i : 4 + i - light, channel }));
        seal(kind === "rgba2" ? [`rgb ${slot}`, `alpha ${slot}`, `rgb2 ${slot}`] : [`rgb ${slot}`, `rgb2 ${slot}`]);
      } else if (kind === "alpha") {
        const [channel] = channels(keys, 1, (k) => num(k.value, 1));
        push({ kind: "color", slot, index: 3, channel: channel! });
        seal([`alpha ${slot}`]);
      } else {
        unsupported.add(`${kind} keys`);
      }
    }
  }

  for (const [boneName, groups] of Object.entries(obj(raw.bones))) {
    const bone = boneIndex.get(boneName);
    if (bone === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "inherit") {
        push({
          kind: "inherit", bone, times: keys.map((k) => Math.fround(num(k.time, 0))),
          modes: keys.map((k) => (typeof k.inherit === "string" ? k.inherit : "normal") as BoneBurstInherit),
        });
        seal([`inherit ${bone}`]);
        continue;
      }
      const spec = BONE_TIMELINES[kind];
      if (!spec) { unsupported.add(`${kind} keys`); continue; }
      const chans = channels(keys, spec.props.length, (k, i) => num(k[spec.fields[i]!], spec.neutral));
      spec.props.forEach((prop, i) => push({ kind: "bone", bone, prop, channel: chans[i]! }));
      seal(BONE_IDS[kind]!.map((id) => `${id} ${bone}`));
    }
  }

  for (const [constraintName, keysRaw] of Object.entries(obj(raw.ik))) {
    const constraint = constraintIndex.get(constraintName);
    const keys = list(keysRaw);
    if (constraint === undefined || !keys.length) continue;
    // Absolute values; a key without one takes the default, not the setup value.
    const [mix, softness] = channels(keys, 2, (k, i) => (i === 0 ? num(k.mix, 1) : num(k.softness, 0)));
    push({
      kind: "ik", constraint, times: mix!.times, mix: mix!, softness: softness!,
      bendPositive: keys.map((k) => k.bendPositive !== false),
      compress: keys.map((k) => k.compress === true),
      stretch: keys.map((k) => k.stretch === true),
    });
    seal([`ik ${constraint}`]);
  }

  for (const [constraintName, keysRaw] of Object.entries(obj(raw.transform))) {
    const constraint = constraintIndex.get(constraintName);
    const keys = list(keysRaw);
    if (constraint === undefined || !keys.length) continue;
    const mixes = keys.map(keyMixes);
    const chans = channels(keys, 6, (_, i, at) => mixes[at]![TRANSFORM_PROPS[i]!]);
    push({
      kind: "transform", constraint, times: chans[0]!.times,
      mixes: Object.fromEntries(TRANSFORM_PROPS.map((p, i) => [p, chans[i]!])) as Record<TransformProp, Channel>,
    });
    seal([`transform ${constraint}`]);
  }

  for (const [constraintName, groups] of Object.entries(obj(raw.path))) {
    const constraint = constraintIndex.get(constraintName);
    if (constraint === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "position" || kind === "spacing") {
        const [channel] = channels(keys, 1, (k) => num(k.value, 0));
        push({ kind: kind === "position" ? "pathPosition" : "pathSpacing", constraint, times: channel!.times, channel: channel! });
        seal([`path ${kind} ${constraint}`]);
      } else if (kind === "mix") {
        const [rotate, x, y] = channels(keys, 3, (k, i) => {
          const mx = num(k.mixX, 1);
          return i === 0 ? num(k.mixRotate, 1) : i === 1 ? mx : num(k.mixY, mx);
        });
        push({ kind: "pathMix", constraint, times: rotate!.times, rotate: rotate!, x: x!, y: y! });
        seal([`path mix ${constraint}`]);
      } else unsupported.add(`path ${kind} keys`);
    }
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
          if (kind === "deform" && attachment.kind !== "region" && attachment.kind !== "point") {
            push(readDeform(slot, attachment, keys));
            seal([`deform ${slot} ${attachmentId(attachment)}`]);
          } else if (kind === "sequence") {
            // A key without a delay keeps the one before it; mode and index
            // do not carry (measured against spine-core).
            let delay = 0;
            const delays = keys.map((k) => (delay = typeof k.delay === "number" ? Math.fround(k.delay) : delay));
            push({
              kind: "sequence", slot, attachment, times: keys.map((k) => Math.fround(num(k.time, 0))),
              modes: keys.map((k) => (typeof k.mode === "string" ? k.mode : "hold") as SequenceMode),
              indices: keys.map((k) => num(k.index, 0)),
              delays,
            });
            seal([`sequence ${slot} ${attachmentId(attachment)}`]);
          } else unsupported.add(`${kind} keys`);
        }
      }
    }
  }

  // Sections this runtime does not play are said, never dropped silently:
  // 4.3's draw order folders (Timelines.md §3.7) are not played yet.
  for (const section of Object.keys(raw)) if (!PLAYED_SECTIONS.has(section)) unsupported.add(`${section} keys`);

  const drawOrder = list(raw.drawOrder ?? raw.draworder);
  if (drawOrder.length) {
    push({
      kind: "drawOrder", times: drawOrder.map((k) => Math.fround(num(k.time, 0))),
      orders: drawOrder.map((k) => (Array.isArray(k.offsets) ? orderFromOffsets(list(k.offsets), slotIndex, slotCount) : null)),
    });
    seal(["drawOrder"]);
  }

  const events = list(raw.events).filter((k) => eventData.has(String(k.name)));
  if (events.length) {
    push({
      kind: "event", times: events.map((k) => Math.fround(num(k.time, 0))),
      events: events.map((k): EventFire => {
        const e = eventData.get(String(k.name))!;
        return {
          name: e.name, int: num(k.int, e.int), float: num(k.float, e.float),
          string: typeof k.string === "string" ? k.string : e.string, audio: e.audio,
          // Volume and balance only for an event with audio; 0 otherwise (measured).
          volume: e.audio ? num(k.volume, e.volume) : 0, balance: e.audio ? num(k.balance, e.balance) : 0,
        };
      }),
    });
    seal(["event"]);
  }
  for (const [constraintName, groups] of Object.entries(obj(raw.slider))) {
    const constraint = constraintIndex.get(constraintName);
    if (constraint === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind !== "time" && kind !== "mix") { unsupported.add(`slider ${kind} keys`); continue; }
      const [channel] = channels(keys, 1, (k) => num(k.value, kind === "mix" ? 1 : 0));
      push({ kind: kind === "time" ? "sliderTime" : "sliderMix", constraint, times: channel!.times, channel: channel! });
      seal([`slider ${kind} ${constraint}`]);
    }
  }
  for (const [constraintName, groups] of Object.entries(obj(raw.physics))) {
    // An unnamed timeline sets every constraint whose value is global.
    const constraint = constraintName === "" ? -1 : constraintIndex.get(constraintName);
    if (constraint === undefined) continue;
    for (const [kind, keysRaw] of Object.entries(obj(groups))) {
      const keys = list(keysRaw);
      if (!keys.length) continue;
      if (kind === "reset") {
        push({ kind: "physicsReset", constraint, times: keys.map((k) => Math.fround(num(k.time, 0))) });
        seal([`physics reset ${constraint}`]);
      } else if ((PHYSICS_PROPS as readonly string[]).includes(kind)) {
        // Mass keys hold the mass; the pose keeps 1 / mass (`Rig.applyTimeline`).
        const [channel] = channels(keys, 1, (k) => num(k.value, 0));
        push({ kind: "physics", constraint, prop: kind as PhysicsProp, times: channel!.times, channel: channel! });
        seal([`physics ${kind} ${constraint}`]);
      } else unsupported.add(`physics ${kind} keys`);
    }
  }

  return { name, duration: lastTime(raw), timelines, units, ids: new Set(timelines.flatMap((t) => t.ids)) };
}

/**
 * A deform timeline. A key lists vertex values from `offset`, the rest 0; an
 * unweighted mesh's key is stored as the setup vertices plus those values (so
 * the pose reads it as positions), a weighted one's as the values alone. As
 * the runtime does, both in 32-bit floats.
 */
function readDeform(slot: number, mesh: MeshData | PathData | ClippingData | BoxData, keys: Json[]): TimelineBody {
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
    return boneburstPolyline({
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
