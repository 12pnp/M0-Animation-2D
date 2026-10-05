import type { JsonObject } from "./json";

/**
 * A Spine 4.3 skeleton as the editor holds it (SPEC §2): the file's structure, typed, readonly.
 * Keys, units and defaults are Format-Json-Atlas.md §3–13's. A field is set exactly when the
 * file had the key; defaults are not filled in (`defaults.ts` answers them). Keys this model does
 * not know, and known keys with the wrong JSON type, are kept in each object's `extra` in file
 * order and written back after the known ones.
 */

/** Keys an object had that the model does not hold, in file order. */
export type Extra = JsonObject;

export interface Skeleton {
  readonly header?: Header;
  readonly bones?: readonly Bone[];
  readonly slots?: readonly Slot[];
  readonly constraints?: readonly Constraint[];
  readonly skins?: readonly Skin[];
  /** Document order (the file's `events` object). */
  readonly events?: readonly EventDef[];
  /** Document order (the file's `animations` object). */
  readonly animations?: readonly Animation[];
  readonly extra: Extra;
}

/** §4 */
export interface Header {
  readonly hash?: string;
  readonly spine?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly referenceScale?: number;
  readonly fps?: number;
  /** Nonessential; the Spine Editor writes null for none. */
  readonly images?: string | null;
  readonly audio?: string | null;
  readonly extra: Extra;
}

export type Inherit = "normal" | "onlyTranslation" | "noRotationOrReflection" | "noScale" | "noScaleOrReflection";

/** §5 */
export interface Bone {
  readonly name: string;
  readonly parent?: string;
  readonly length?: number;
  readonly x?: number;
  readonly y?: number;
  readonly rotation?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly shearX?: number;
  readonly shearY?: number;
  /** Case-insensitive in the file; kept as written. */
  readonly inherit?: string;
  readonly skin?: boolean;
  /** Nonessential. */
  readonly color?: string;
  readonly icon?: string;
  readonly visible?: boolean;
  readonly extra: Extra;
}

/** §6 */
export interface Slot {
  readonly name: string;
  readonly bone: string;
  readonly color?: string;
  readonly dark?: string;
  readonly attachment?: string;
  readonly blend?: string;
  readonly visible?: boolean;
  readonly extra: Extra;
}

/** §7: one list, five kinds; the array position is the constraint's index. */
export type Constraint = IkConstraint | TransformConstraint | PathConstraint | PhysicsConstraint | SliderConstraint;

interface ConstraintBase {
  readonly name: string;
  readonly skin?: boolean;
  readonly extra: Extra;
}

/** §7.2 */
export interface IkConstraint extends ConstraintBase {
  readonly type: "ik";
  readonly bones?: readonly string[];
  readonly target?: string;
  readonly scaleY?: string;
  readonly mix?: number;
  readonly softness?: number;
  readonly bendPositive?: boolean;
  readonly compress?: boolean;
  readonly stretch?: boolean;
}

/** §7.3 */
export interface TransformConstraint extends ConstraintBase {
  readonly type: "transform";
  readonly bones?: readonly string[];
  readonly source?: string;
  readonly localSource?: boolean;
  readonly localTarget?: boolean;
  readonly additive?: boolean;
  readonly clamp?: boolean;
  /** The from → to map, in document order. */
  readonly properties?: readonly TransformFrom[];
  readonly rotation?: number;
  readonly x?: number;
  readonly y?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly shearY?: number;
  readonly mixRotate?: number;
  readonly mixX?: number;
  readonly mixY?: number;
  readonly mixScaleX?: number;
  readonly mixScaleY?: number;
  readonly mixShearY?: number;
}

export interface TransformFrom {
  readonly from: string;
  readonly offset?: number;
  /** Absent: the file had no `to` key. */
  readonly to?: readonly TransformTo[];
  readonly extra: Extra;
}

export interface TransformTo {
  readonly to: string;
  readonly offset?: number;
  readonly max?: number;
  readonly scale?: number;
  readonly extra: Extra;
}

/** §7.4 */
export interface PathConstraint extends ConstraintBase {
  readonly type: "path";
  readonly bones?: readonly string[];
  readonly slot?: string;
  readonly positionMode?: string;
  readonly spacingMode?: string;
  readonly rotateMode?: string;
  readonly rotation?: number;
  readonly position?: number;
  readonly spacing?: number;
  readonly mixRotate?: number;
  readonly mixX?: number;
  readonly mixY?: number;
}

/** §7.5 */
export interface PhysicsConstraint extends ConstraintBase {
  readonly type: "physics";
  readonly bone?: string;
  readonly x?: number;
  readonly y?: number;
  readonly rotate?: number;
  readonly scaleX?: number;
  /** A mode (`none`, `uniform`, `volume`), not a number. */
  readonly scaleY?: string;
  readonly shearX?: number;
  readonly limit?: number;
  readonly fps?: number;
  readonly inertia?: number;
  readonly strength?: number;
  readonly damping?: number;
  readonly mass?: number;
  readonly wind?: number;
  readonly gravity?: number;
  readonly mix?: number;
  readonly inertiaGlobal?: boolean;
  readonly strengthGlobal?: boolean;
  readonly dampingGlobal?: boolean;
  readonly massGlobal?: boolean;
  readonly windGlobal?: boolean;
  readonly gravityGlobal?: boolean;
  readonly mixGlobal?: boolean;
}

/** §7.6 */
export interface SliderConstraint extends ConstraintBase {
  readonly type: "slider";
  readonly additive?: boolean;
  readonly loop?: boolean;
  readonly mix?: number;
  readonly animation?: string;
  readonly bone?: string;
  readonly property?: string;
  readonly from?: number;
  readonly to?: number;
  readonly scale?: number;
  readonly local?: boolean;
  readonly time?: number;
  readonly max?: number;
}

export type ConstraintType = Constraint["type"];
export const CONSTRAINT_TYPES: readonly ConstraintType[] = ["ik", "transform", "path", "physics", "slider"];

/** §8.1 */
export interface Skin {
  readonly name: string;
  readonly bones?: readonly string[];
  readonly ik?: readonly string[];
  readonly transform?: readonly string[];
  readonly path?: readonly string[];
  readonly physics?: readonly string[];
  readonly slider?: readonly string[];
  /** Slot by slot, in document order; absent when the file had no `attachments`. */
  readonly attachments?: readonly SkinSlot[];
  readonly color?: string;
  readonly extra: Extra;
}

export interface SkinSlot {
  readonly slot: string;
  /** Placeholder key → attachment, in document order. */
  readonly entries: readonly SkinEntry[];
}

export interface SkinEntry {
  readonly key: string;
  readonly attachment: Attachment;
}

export type AttachmentType = "region" | "mesh" | "linkedmesh" | "boundingbox" | "path" | "point" | "clipping";
export const ATTACHMENT_TYPES: readonly AttachmentType[] = ["region", "mesh", "linkedmesh", "boundingbox", "path", "point", "clipping"];

/**
 * §8.2–8.8: every kind's keys, each optional; `type` (absent: region) says which apply. Read the
 * kind through `attachmentType`.
 */
export interface Attachment {
  readonly type?: string;
  readonly name?: string;
  readonly path?: string;
  readonly sequence?: Sequence;
  readonly color?: string;
  readonly x?: number;
  readonly y?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly rotation?: number;
  readonly width?: number;
  readonly height?: number;
  readonly source?: string;
  readonly slot?: string;
  readonly skin?: string;
  readonly timelines?: boolean;
  readonly uvs?: readonly number[];
  readonly vertices?: readonly number[];
  readonly triangles?: readonly number[];
  readonly hull?: number;
  readonly edges?: readonly number[];
  readonly vertexCount?: number;
  readonly closed?: boolean;
  readonly constantSpeed?: boolean;
  readonly lengths?: readonly number[];
  readonly end?: string;
  readonly convex?: boolean;
  readonly inverse?: boolean;
  readonly extra: Extra;
}

/** §17 */
export interface Sequence {
  readonly count?: number;
  readonly start?: number;
  readonly digits?: number;
  readonly setup?: number;
  readonly extra: Extra;
}

/** §10 */
export interface EventDef {
  readonly name: string;
  readonly int?: number;
  readonly float?: number;
  readonly string?: string;
  readonly audio?: string | null;
  readonly volume?: number;
  readonly balance?: number;
  readonly extra: Extra;
}

/**
 * §11. Each section is absent when the file did not have it; inside, groups and timelines keep
 * document order.
 */
export interface Animation {
  readonly name: string;
  readonly slots?: readonly TimelineGroup[];
  readonly bones?: readonly TimelineGroup[];
  readonly ik?: readonly KeyList[];
  readonly transform?: readonly KeyList[];
  readonly path?: readonly TimelineGroup[];
  /** The group named "" drives every physics constraint with the matching global flag. */
  readonly physics?: readonly TimelineGroup[];
  readonly slider?: readonly TimelineGroup[];
  readonly attachments?: readonly SkinTimelines[];
  readonly drawOrder?: readonly Key[];
  readonly drawOrderFolder?: readonly DrawOrderFolder[];
  readonly events?: readonly Key[];
  readonly extra: Extra;
}

/** A bone's, slot's or constraint's timelines: name → keys. */
export interface TimelineGroup {
  readonly name: string;
  readonly timelines: readonly KeyList[];
}

/** A named list of keys: one timeline, or an IK or transform constraint's keys. */
export interface KeyList {
  readonly name: string;
  readonly keys: readonly Key[];
}

export interface SkinTimelines {
  readonly skin: string;
  readonly slots: readonly { readonly slot: string; readonly attachments: readonly TimelineGroup[] }[];
}

export interface DrawOrderFolder {
  readonly slots?: readonly string[];
  readonly keys?: readonly Key[];
  readonly extra: Extra;
}

/** `"stepped"`, or four numbers per channel (§12.1). */
export type Curve = string | readonly number[];

/**
 * One key of any timeline (§11.3–11.13): `time` and `curve`, and the value keys its timeline uses.
 * Which ones apply is the timeline's business; the model keeps whatever the key had.
 */
export interface Key {
  readonly time?: number;
  readonly curve?: Curve;
  readonly value?: number;
  readonly x?: number;
  readonly y?: number;
  readonly color?: string;
  readonly light?: string;
  readonly dark?: string;
  readonly name?: string | null;
  readonly inherit?: string;
  readonly mix?: number;
  readonly softness?: number;
  readonly bendPositive?: boolean;
  readonly compress?: boolean;
  readonly stretch?: boolean;
  readonly mixRotate?: number;
  readonly mixX?: number;
  readonly mixY?: number;
  readonly mixScaleX?: number;
  readonly mixScaleY?: number;
  readonly mixShearY?: number;
  readonly offset?: number;
  readonly vertices?: readonly number[];
  readonly mode?: string;
  readonly index?: number;
  readonly delay?: number;
  readonly offsets?: readonly DrawOrderOffset[];
  readonly int?: number;
  readonly float?: number;
  readonly string?: string;
  readonly volume?: number;
  readonly balance?: number;
  readonly extra: Extra;
}

export interface DrawOrderOffset {
  readonly slot?: string;
  readonly offset?: number;
  readonly extra: Extra;
}

/** The attachment's kind; absent `type` is a region (§8.2). Lower-cased: the file is case-insensitive. */
export function attachmentType(a: Attachment): string {
  return (a.type ?? "region").toLowerCase();
}
