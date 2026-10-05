import type { BoneBurstInherit } from "./runtime/rigTypes";
export type { BoneBurstInherit };
/**
 * The Spine 4.3 skeleton JSON shapes this editor writes (and, from phase 7,
 * reads).
 *
 * This file is the CONTRACT. Every field, unit and default here was read out
 * of the official runtime's parser (`SkeletonJson.readSkeletonData` in
 * spine-core 4.3.13), not from documentation: the format's names and
 * defaults, no code of it (docs/PREVIEW-RUNTIME-PLAN.md ▸ Risks). The notes record what fails
 * SILENTLY when it is guessed wrong. What the editor writes is typed; what
 * an opened file carries through untouched (meshes, paths, physics, sliders,
 * deform keys …) is `BoneBurstRaw`, checked only for the names it references
 * (`carry.ts`).
 */

/** JSON the editor carries without modelling it. */
export type BoneBurstRaw = Record<string, unknown>;

/**
 * spine-unity accepts a JSON file when the MAJOR.MINOR of `skeleton.spine`
 * matches its own (`SkeletonDataCompatibility`); spine-core does not check.
 */
export const BONEBURST_VERSION = "4.3.0";

export interface BoneBurstSkeletonFile {
  skeleton: BoneBurstHeader;
  /**
   * PARENTS BEFORE CHILDREN. The parser resolves `parent` against the bones
   * read so far, and a parent it cannot find yet is not an error: the bone
   * silently becomes a root.
   */
  bones: BoneBurstBone[];
  /** Draw order, BACK TO FRONT: slot 0 is drawn first. */
  slots?: BoneBurstSlot[];
  /** Every constraint type in one list, told apart by `type` (4.3 layout). */
  constraints?: BoneBurstConstraint[];
  skins?: BoneBurstSkin[];
  /** Keyed by event name. */
  events?: Record<string, BoneBurstEventData>;
  /** Keyed by animation name. */
  animations?: Record<string, BoneBurstAnimation>;
}

export interface BoneBurstHeader {
  spine: string;
  /** REQUIRED by spine-csharp 4.3.40 (`SkeletonJson` reads it without a
   *  default and throws), though spine-core does not care. */
  hash?: string;
  /** Bounds of the setup pose, for tools; the runtime does not use them. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** The editor's frame rate. Metadata only: every time is in SECONDS. */
  fps?: number;
  images?: string;
  /** Carried from an opened file: audio, referenceScale … */
  [field: string]: unknown;
}

/**
 * A bone's LOCAL transform. Y points UP. Angles in degrees; nothing wraps
 * them. The local matrix is
 *   a = cos(rotation + shearX)·scaleX    b = cos(rotation + 90 + shearY)·scaleY
 *   c = sin(rotation + shearX)·scaleX    d = sin(rotation + 90 + shearY)·scaleY
 * (column (a, c) is the x axis), from `BonePose.updateWorldTransform`.
 */
export interface BoneBurstBoneTransform {
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  shearX?: number;
  shearY?: number;
}

/**
 * Enum strings (`inherit`, `blend`) are read by upper-casing the first
 * letter and indexing the enum: a misspelling becomes undefined, not an
 * error. `BoneBurstInherit` is the runtime's (`runtime/rigTypes.ts`).
 */
export interface BoneBurstBone extends BoneBurstBoneTransform {
  name: string;
  parent?: string;
  length?: number;
  /** Absent = "normal": the full parent matrix, which is what Flash does. */
  inherit?: BoneBurstInherit;
  /** Editor-only colour, "rrggbbaa". */
  color?: string;
  /** Only in the skins that list it. */
  skin?: boolean;
}

/** The four blend modes the runtime has. */
export type BoneBurstBlendMode = "normal" | "additive" | "multiply" | "screen";

export interface BoneBurstSlot {
  name: string;
  /** Must exist: an unknown bone throws. */
  bone: string;
  /** "rrggbbaa" (alpha optional), channels 0..255 → 0..1. Absent = white. */
  color?: string;
  /** Two-colour tint: "rrggbb". Absent = no dark colour, single-colour tint. */
  dark?: string;
  /** Attachment shown in the setup pose, by its key in the skin. Absent = none. */
  attachment?: string;
  blend?: BoneBurstBlendMode;
  visible?: boolean;
}

/** The IK the editor writes, or any constraint carried from an opened file. */
export type BoneBurstConstraint = BoneBurstIkConstraint | BoneBurstTransformConstraint | (BoneBurstRaw & { type: string; name: string });

/** Spine 4.3's transform constraint: `bones` follow `source` through
 *  `properties` (source property → target properties). */
export interface BoneBurstTransformConstraint {
  type: "transform";
  name: string;
  bones: string[];
  source: string;
  localSource?: boolean;
  localTarget?: boolean;
  additive?: boolean;
  clamp?: boolean;
  properties?: Record<string, { offset?: number; to?: Record<string, { offset?: number; max?: number; scale?: number }> }>;
  rotation?: number; x?: number; y?: number; scaleX?: number; scaleY?: number; shearY?: number;
  mixRotate?: number; mixX?: number; mixY?: number; mixScaleX?: number; mixScaleY?: number; mixShearY?: number;
  skin?: boolean;
  [field: string]: unknown;
}

/** A transform constraint key: the six mixes, absolute. */
export interface BoneBurstTransformKey {
  time?: number;
  mixRotate?: number; mixX?: number; mixY?: number; mixScaleX?: number; mixScaleY?: number; mixShearY?: number;
  curve?: BoneBurstCurve;
}

export interface BoneBurstIkConstraint {
  type: "ik";
  name: string;
  /** One bone (look-at) or two (parent, child). Unknown names throw. */
  bones: string[];
  target: string;
  /** 0..1, absent = 1. */
  mix?: number;
  softness?: number;
  /** Absent = true. */
  bendPositive?: boolean;
  compress?: boolean;
  stretch?: boolean;
  /** 4.3: how scale y follows a stretch or compress. Absent = "none". */
  scaleY?: "none" | "uniform" | "volume";
  /** Only in the skins that list it. */
  skin?: boolean;
}

export interface BoneBurstSkin {
  /** "default" is the skin the skeleton starts with. */
  name: string;
  /** slot name → attachment key → attachment. */
  attachments?: Record<string, Record<string, BoneBurstAttachment>>;
  /** Bones and constraints only this skin enables, by name, constraints
   *  one list per kind. */
  bones?: string[];
  ik?: string[];
  transform?: string[];
  path?: string[];
  physics?: string[];
  slider?: string[];
  color?: string;
}

/** Mesh, linked mesh, path, point and bounding box attachments arrive only
 *  from opened files, carried as they came. */
export type BoneBurstAttachment = BoneBurstRegionAttachment | BoneBurstClippingAttachment | BoneBurstRaw;

/**
 * An image. `x`/`y` place the image's CENTRE in the bone's space (y up);
 * `rotation` and scales apply about that centre.
 */
export interface BoneBurstRegionAttachment {
  /** Absent = "region". */
  type?: "region";
  /** Absent = the attachment's key. */
  name?: string;
  /** The atlas region to draw. Absent = `name`. */
  path?: string;
  x?: number;
  y?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  /** REQUIRED: the parser has no default, and absent reads as NaN. The
   *  UNTRIMMED size; the atlas region's offsets place the trimmed pixels. */
  width: number;
  height: number;
  color?: string;
}

/**
 * Clips every slot from its own slot up to `end` (inclusive) in draw order,
 * or to the last slot when `end` is absent. A polygon, not an alpha mask.
 */
export interface BoneBurstClippingAttachment {
  type: "clipping";
  name?: string;
  end?: string;
  /** Unweighted: `vertices` is `vertexCount` x/y pairs in the bone's space. */
  vertexCount: number;
  vertices: number[];
  convex?: boolean;
  inverse?: boolean;
  color?: string;
}

export interface BoneBurstEventData {
  int?: number;
  float?: number;
  string?: string;
  audio?: string;
  volume?: number;
  balance?: number;
}

/**
 * The curve on a key shapes the interval that key STARTS. Absent = linear.
 * Otherwise four numbers per value channel, in the timeline's own order
 * (translate: x then y; rgba: r, g, b, a): `cx1, cy1, cx2, cy2` of a cubic
 * bezier in ABSOLUTE units, seconds and the stored (relative) value, not
 * 0..1.
 */
export type BoneBurstCurve = "stepped" | number[];

export interface BoneBurstKey {
  /** Seconds. Absent = 0. */
  time?: number;
  curve?: BoneBurstCurve;
}

/** RELATIVE to the setup value: pose = setup + value. Absent value = 0. */
export interface BoneBurstRotateKey extends BoneBurstKey { value?: number }
/** Relative, as rotate. */
export interface BoneBurstTranslateKey extends BoneBurstKey { x?: number; y?: number }
/** MULTIPLICATIVE: pose = setup × value, so a setup scale of 0 cannot be
 *  animated at all. Absent = 1. */
export interface BoneBurstScaleKey extends BoneBurstKey { x?: number; y?: number }
/** Relative, as rotate. */
export interface BoneBurstShearKey extends BoneBurstKey { x?: number; y?: number }

export interface BoneBurstBoneTimelines {
  rotate?: BoneBurstRotateKey[];
  translate?: BoneBurstTranslateKey[];
  scale?: BoneBurstScaleKey[];
  shear?: BoneBurstShearKey[];
  /** Carried from an opened file: translatex, inherit … */
  [timeline: string]: unknown;
}

/** No curve: attachments switch. `name` null hides the slot's attachment. */
export interface BoneBurstAttachmentKey { time?: number; name: string | null }
export interface BoneBurstRgbaKey extends BoneBurstKey { color: string }
export interface BoneBurstRgba2Key extends BoneBurstKey { light: string; dark: string }

/** Any other key name throws. */
export interface BoneBurstSlotTimelines {
  attachment?: BoneBurstAttachmentKey[];
  rgba?: BoneBurstRgbaKey[];
  rgba2?: BoneBurstRgba2Key[];
  /** Carried from an opened file: sequence … */
  [timeline: string]: unknown;
}

/** Absolute, not relative. Curve channels: mix, softness. */
export interface BoneBurstIkKey extends BoneBurstKey {
  mix?: number;
  softness?: number;
  bendPositive?: boolean;
  compress?: boolean;
  stretch?: boolean;
}

/** Absent `offsets` = the setup draw order. */
export interface BoneBurstDrawOrderKey {
  time?: number;
  offsets?: Array<{ slot: string; offset: number }>;
}

export interface BoneBurstEventKey {
  time?: number;
  name: string;
  int?: number;
  float?: number;
  string?: string;
  volume?: number;
  balance?: number;
}

/**
 * The DURATION is the time of the last key on any timeline; the format has
 * no field for it. An animation that ends on a hold is shorter in the
 * runtime than in the editor unless a key sits at the end.
 */
export interface BoneBurstAnimation {
  bones?: Record<string, BoneBurstBoneTimelines>;
  slots?: Record<string, BoneBurstSlotTimelines>;
  ik?: Record<string, BoneBurstIkKey[]>;
  drawOrder?: BoneBurstDrawOrderKey[];
  events?: BoneBurstEventKey[];
  /** Carried from an opened file: attachments (deform, sequence),
   *  transform, path, physics and slider keys. */
  [group: string]: unknown;
}
