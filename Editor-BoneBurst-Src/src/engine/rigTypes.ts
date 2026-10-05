import type { ImageRegion } from "./regions";

/** How a bone takes its parent's transform (`inherit`; absent is "normal"). */
export type BoneBurstInherit =
  | "normal" | "onlyTranslation" | "noRotationOrReflection" | "noScale" | "noScaleOrReflection";

/**
 * A Spine 4.3 skeleton JSON read into the engine's model (docs/SPEC.md §6).
 * Written from the format, held to spine-core by `tests/engineOracle.test.ts`;
 * nothing here is taken from spine-core's source. Whatever a file holds that
 * the engine does not play is listed in `unsupported`, so the stage can say so
 * instead of silently drawing something else.
 */

export type Rgba = [number, number, number, number];
/**
 * Degrees to radians as the runtime converts them: with π written to eight
 * digits (3.1415927), so 90° is π/2 + 2.3e-8 and cos 90° is -2.3e-8, not 0.
 * Measured against spine-core (`tests/engineOracle.test.ts`); the exact
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
  region: ImageRegion | null;
  /** A region attachment's corners in the bone's space (y up): bottom left,
   *  bottom right, top right, top left. Empty for a mesh. */
  corners: Float64Array;
  /** Page UVs, 0..1, v down: a region's four corners, or each mesh vertex. */
  uvs: Float32Array;
}
/** Frames drawn from one path, numbered `start`, `start + 1` … padded to `digits`. */

export interface Sequence { count: number; start: number; digits: number; setup: number; }
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

export interface RegionData extends AttachmentBase { kind: "region"; }

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

export type Timeline = TimelineBody & { unit: number; ids: string[]; };

export type TimelineBody = { kind: "bone"; bone: number; prop: BoneProp; channel: Channel; }
  /** One colour channel of a slot: 0 r, 1 g, 2 b, 3 a; 4 5 6 the dark colour's r g b. */
  |

{ kind: "color"; slot: number; index: number; channel: Channel; } |
{ kind: "attachment"; slot: number; times: number[]; names: Array<string | null>; }
  /** Each key's draw order as slot indices back to front; null = the setup order. */
  |

{ kind: "drawOrder"; times: number[]; orders: Array<number[] | null>; }
  /** A mesh's vertices per key: absolute positions when unweighted, offsets
   *  added to each bone influence when weighted. `curves` run 0..1 between keys. */
  |

{ kind: "deform"; slot: number; attachment: MeshData | PathData | ClippingData | BoxData; times: number[]; curves: Interval[]; vertices: Float64Array[]; }
  /** An IK constraint's values from each key on: mix and softness curved, the rest held. */
  |

{ kind: "ik"; constraint: number; times: number[]; mix: Channel; softness: Channel; bendPositive: boolean[]; compress: boolean[]; stretch: boolean[]; }
  /** Events, fired as the track passes their keys (`Track`). */
  |

{ kind: "event"; times: number[]; events: EventFire[]; }
  /** A physics value, curved, absolute (mass mixed as mass, then inverted);
   *  `constraint` -1 sets every constraint whose value is global. */
  |

{ kind: "physics"; constraint: number; prop: PhysicsProp; times: number[]; channel: Channel; }
  /** Physics resets as the track passes these keys. */
  |

{ kind: "physicsReset"; constraint: number; times: number[]; }
  /** A slider's time or mix, curved, absolute. */
  |

{ kind: "sliderTime" | "sliderMix"; constraint: number; times: number[]; channel: Channel; }
  /** A path constraint's position, spacing, or mixes (rotate, x, y), curved. */
  |

{ kind: "pathPosition" | "pathSpacing"; constraint: number; times: number[]; channel: Channel; } |
{ kind: "pathMix"; constraint: number; times: number[]; rotate: Channel; x: Channel; y: Channel; }
  /** A transform constraint's six mixes, curved. */
  |

{ kind: "transform"; constraint: number; times: number[]; mixes: Record<TransformProp, Channel>; }
  /** A bone's inherit mode from each key on. */
  |

{ kind: "inherit"; bone: number; times: number[]; modes: BoneBurstInherit[]; }
  /** Which sequence frame a slot shows, from each key on. */
  |

{ kind: "sequence"; slot: number; attachment: AttachmentData; times: number[]; modes: SequenceMode[]; indices: number[]; delays: number[]; };

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
  properties: Array<{ from: TransformProp; offset: number; to: Array<{ prop: TransformProp; offset: number; max: number; scale: number; }>; }>;
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
  /** What the file uses that this runtime does not play yet, for the stage to show. */
  unsupported: string[];
}
