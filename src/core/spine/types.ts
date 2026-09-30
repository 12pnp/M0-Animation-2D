/**
 * The Spine 4.3 skeleton JSON shapes this editor writes (and, from phase 7,
 * reads).
 *
 * This file is the CONTRACT. Every field, unit and default here was read out
 * of the runtime's own parser (`SkeletonJson.readSkeletonData` in
 * @esotericsoftware/spine-core 4.3.13, the core of the spine-pixi-v8 build
 * the preview runs), not from documentation. The notes record what fails
 * SILENTLY when it is guessed wrong. What the editor writes is typed; what
 * an opened file carries through untouched (meshes, paths, physics, sliders,
 * deform keys …) is `SpineRaw`, checked only for the names it references
 * (`carry.ts`).
 */

/** JSON the editor carries without modelling it. */
export type SpineRaw = Record<string, unknown>;

/**
 * spine-unity accepts a JSON file when the MAJOR.MINOR of `skeleton.spine`
 * matches its own (`SkeletonDataCompatibility`); spine-core does not check.
 */
export const SPINE_VERSION = "4.3.0";

export interface SpineSkeletonFile {
  skeleton: SpineHeader;
  /**
   * PARENTS BEFORE CHILDREN. The parser resolves `parent` against the bones
   * read so far, and a parent it cannot find yet is not an error: the bone
   * silently becomes a root.
   */
  bones: SpineBone[];
  /** Draw order, BACK TO FRONT: slot 0 is drawn first. */
  slots?: SpineSlot[];
  /** Every constraint type in one list, told apart by `type` (4.3 layout). */
  constraints?: SpineConstraint[];
  skins?: SpineSkin[];
  /** Keyed by event name. */
  events?: Record<string, SpineEventData>;
  /** Keyed by animation name. */
  animations?: Record<string, SpineAnimation>;
}

export interface SpineHeader {
  spine: string;
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
export interface SpineBoneTransform {
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
 * error.
 */
export type SpineInherit =
  | "normal" | "onlyTranslation" | "noRotationOrReflection" | "noScale" | "noScaleOrReflection";

export interface SpineBone extends SpineBoneTransform {
  name: string;
  parent?: string;
  length?: number;
  /** Absent = "normal": the full parent matrix, which is what Flash does. */
  inherit?: SpineInherit;
  /** Editor-only colour, "rrggbbaa". */
  color?: string;
}

/** The four blend modes the runtime has. */
export type SpineBlendMode = "normal" | "additive" | "multiply" | "screen";

export interface SpineSlot {
  name: string;
  /** Must exist: an unknown bone throws. */
  bone: string;
  /** "rrggbbaa" (alpha optional), channels 0..255 → 0..1. Absent = white. */
  color?: string;
  /** Two-colour tint: "rrggbb". Absent = no dark colour, single-colour tint. */
  dark?: string;
  /** Attachment shown in the setup pose, by its key in the skin. Absent = none. */
  attachment?: string;
  blend?: SpineBlendMode;
  visible?: boolean;
}

/** The IK the editor writes, or any constraint carried from an opened file. */
export type SpineConstraint = SpineIkConstraint | (SpineRaw & { type: string; name: string });

export interface SpineIkConstraint {
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
  /** Only in the skins that list it. */
  skin?: boolean;
}

export interface SpineSkin {
  /** "default" is the skin the skeleton starts with. */
  name: string;
  /** slot name → attachment key → attachment. */
  attachments?: Record<string, Record<string, SpineAttachment>>;
  /** Bones and constraints only this skin enables, by name. */
  bones?: string[];
  constraints?: string[];
  color?: string;
}

/** Mesh, linked mesh, path, point and bounding box attachments arrive only
 *  from opened files, carried as they came. */
export type SpineAttachment = SpineRegionAttachment | SpineClippingAttachment | SpineRaw;

/**
 * An image. `x`/`y` place the image's CENTRE in the bone's space (y up);
 * `rotation` and scales apply about that centre.
 */
export interface SpineRegionAttachment {
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
export interface SpineClippingAttachment {
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

export interface SpineEventData {
  int?: number;
  float?: number;
  string?: string;
}

/**
 * The curve on a key shapes the interval that key STARTS. Absent = linear.
 * Otherwise four numbers per value channel, in the timeline's own order
 * (translate: x then y; rgba: r, g, b, a): `cx1, cy1, cx2, cy2` of a cubic
 * bezier in ABSOLUTE units, seconds and the stored (relative) value, not
 * 0..1.
 */
export type SpineCurve = "stepped" | number[];

export interface SpineKey {
  /** Seconds. Absent = 0. */
  time?: number;
  curve?: SpineCurve;
}

/** RELATIVE to the setup value: pose = setup + value. Absent value = 0. */
export interface SpineRotateKey extends SpineKey { value?: number }
/** Relative, as rotate. */
export interface SpineTranslateKey extends SpineKey { x?: number; y?: number }
/** MULTIPLICATIVE: pose = setup × value, so a setup scale of 0 cannot be
 *  animated at all. Absent = 1. */
export interface SpineScaleKey extends SpineKey { x?: number; y?: number }
/** Relative, as rotate. */
export interface SpineShearKey extends SpineKey { x?: number; y?: number }

export interface SpineBoneTimelines {
  rotate?: SpineRotateKey[];
  translate?: SpineTranslateKey[];
  scale?: SpineScaleKey[];
  shear?: SpineShearKey[];
  /** Carried from an opened file: translatex, inherit … */
  [timeline: string]: unknown;
}

/** No curve: attachments switch. `name` null hides the slot's attachment. */
export interface SpineAttachmentKey { time?: number; name: string | null }
export interface SpineRgbaKey extends SpineKey { color: string }
export interface SpineRgba2Key extends SpineKey { light: string; dark: string }

/** Any other key name throws. */
export interface SpineSlotTimelines {
  attachment?: SpineAttachmentKey[];
  rgba?: SpineRgbaKey[];
  rgba2?: SpineRgba2Key[];
  /** Carried from an opened file: sequence … */
  [timeline: string]: unknown;
}

/** Absolute, not relative. Curve channels: mix, softness. */
export interface SpineIkKey extends SpineKey {
  mix?: number;
  softness?: number;
  bendPositive?: boolean;
  compress?: boolean;
  stretch?: boolean;
}

/** Absent `offsets` = the setup draw order. */
export interface SpineDrawOrderKey {
  time?: number;
  offsets?: Array<{ slot: string; offset: number }>;
}

export interface SpineEventKey {
  time?: number;
  name: string;
  int?: number;
  float?: number;
  string?: string;
}

/**
 * The DURATION is the time of the last key on any timeline; the format has
 * no field for it. An animation that ends on a hold is shorter in the
 * runtime than in the editor unless a key sits at the end.
 */
export interface SpineAnimation {
  bones?: Record<string, SpineBoneTimelines>;
  slots?: Record<string, SpineSlotTimelines>;
  ik?: Record<string, SpineIkKey[]>;
  drawOrder?: SpineDrawOrderKey[];
  events?: SpineEventKey[];
  /** Carried from an opened file: attachments (deform, sequence),
   *  transform, path, physics and slider keys. */
  [group: string]: unknown;
}
