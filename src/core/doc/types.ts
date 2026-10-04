import type { Transform } from "@/core/math/Transform";
import type { ExportSettings } from "@/core/export/settings";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import type { SpineInherit } from "@/core/spine/types";
import type { AnimId, AssetId, FolderId, IkId, ItemId, LayerId, NodeId } from "./ids";

/** Bumped whenever the on-disk shape changes; `schema.ts` bridges versions. */
export const DOC_VERSION = 19;

/* ── Colour ───────────────────────────────────────────────────────────────
   Stored exactly as DragonBones expects: multipliers as 0-100 percentages,
   offsets as -255..255. Keeping the wire units in the model means the
   exporter is a copy, not a conversion that could drift.                   */

export interface ColorTransform {
  aM: number; rM: number; gM: number; bM: number;   // 0..100
  aO: number; rO: number; gO: number; bO: number;   // -255..255
}

export const DEFAULT_COLOR: Readonly<ColorTransform> = Object.freeze({
  aM: 100, rM: 100, gM: 100, bM: 100, aO: 0, rO: 0, gO: 0, bO: 0,
});

export function isDefaultColor(c: ColorTransform): boolean {
  return c.aM === 100 && c.rM === 100 && c.gM === 100 && c.bM === 100
      && c.aO === 0 && c.rO === 0 && c.gO === 0 && c.bO === 0;
}

/**
 * Only the modes `PixiSlot._updateBlendMode` actually applies. The runtime's
 * parser knows 14 (`alpha`, `erase`, `invert`, `layer`, `subtract` too), but
 * those fall through its `default: break` and render as normal — exporting one
 * would fail silently, which is exactly what this list exists to prevent.
 */
export type BlendMode =
  | "normal" | "add" | "multiply" | "screen" | "overlay"
  | "darken" | "lighten" | "difference" | "hardlight";

/* ── Library ──────────────────────────────────────────────────────────────
   Symbol === Armature. An ImageItem exports as an "image" display; a
   SymbolItem exports as its own armature, and instances of it become slots
   carrying an "armature" display.                                         */

export interface ImageItem {
  kind: "image";
  id: ItemId;
  name: string;
  assetId: AssetId;
  /** Untrimmed pixel size. Pivots normalise against THIS, never the packed
   *  region — getting that wrong is the classic "off by a few pixels in the
   *  runtime" bug. */
  width: number;
  height: number;
  /** Skip alpha-trimming this image when packing (for pixel-exact art). */
  noTrim?: boolean;
  /** The library folder holding it; absent: the top level. */
  folderId?: FolderId;
}

export interface SymbolItem {
  kind: "symbol";
  id: ItemId;
  name: string;
  nodes: Record<NodeId, Node>;
  /** Index 0 is the TOP layer in the UI. The exporter emits slots in
   *  REVERSED order, because DragonBones draws later array entries in front. */
  layers: Layer[];
  ik: IkConstraint[];
  animations: Animation[];
  /** The library folder holding it; absent: the top level. */
  folderId?: FolderId;
  /** Opened from a Spine file: what the model does not hold, carried to the
   *  export as it came. The stage poses such a symbol through the runtime
   *  (`core/spine/spinePose.ts`), so what it carries is also what it shows. */
  spine?: SpineCarry;
  /** An opened rig's skins the stage and Preview show, combined as Spine
   *  combines skins (the default skin under them all). Absent: the default
   *  skin, or the first other one when it draws nothing (`stageSkinOf`).
   *  The editor's choice only: the export does not write it. */
  stageSkins?: string[];
  /** The events its animations fire (`core/doc/events.ts`), names unique,
   *  as Spine's skeleton `events`. */
  events?: EventDef[];
}

/** A named event and its values, which a key may override. Absent: 0, 0,
 *  "", no sound, volume 1, balance 0 (Spine's defaults). `audio` is the
 *  sound's path as the game finds it; the project's sound files are keyed by
 *  it (`SoundStore`). */
export interface EventDef {
  name: string;
  int?: number;
  float?: number;
  string?: string;
  audio?: string;
  volume?: number;
  balance?: number;
}

/** An event fired at a frame. A value it leaves out is the event's own. */
export interface EventKey {
  frame: number;
  name: string;
  int?: number;
  float?: number;
  string?: string;
  volume?: number;
  balance?: number;
}

/**
 * The parts of an opened Spine skeleton the editor does not model, kept so
 * the export writes them back: constraints other than the IK it solves,
 * attachments that are not displays (every skin but the default one whole),
 * events. Bones and slots are named, never indexed: weighted vertices hold
 * bone NAMES here (`core/spine/carry.ts`), and the export checks that every
 * name still exists.
 */
export interface SpineCarry {
  /** Header fields other than `spine` and `fps`: hash, bounds, images, audio, referenceScale. */
  header: Record<string, unknown>;
  /** Constraints kept as the file has them. */
  constraints: Array<Record<string, unknown>>;
  /** Every constraint's name, the model's IK included, in the file's order:
   *  the order Spine applies them in. */
  constraintOrder: string[];
  /** Skins as the file has them, less the default skin's displays. */
  skins: Array<Record<string, unknown>>;
  /** Event definitions, by name. */
  events?: Record<string, unknown>;
}

export type LibraryItem = ImageItem | SymbolItem;

/** A library folder: organisation only, the exporter never sees it. */
export interface LibraryFolder {
  id: FolderId;
  name: string;
  /** null: the top level. */
  parentId: FolderId | null;
}

/* ── Nodes ────────────────────────────────────────────────────────────────
   Every node owns exactly one layer, which is what makes the layer-order to
   slot-order mapping unambiguous.

   - "image"  : a slot with an image display
   - "symbol" : a slot with a nested-armature display
   - "bone"   : an explicit bone, drawn in the overlay, produces no slot
   - "group"  : a transform-only parent, flattened into the same armature
                (unlike a symbol, which costs a whole child armature and
                makes its contents z-atomic)
   - "empty"  : a placeholder holding an empty layer open. It carries no
                library item and exports as NOTHING — not even a bone — so an
                empty layer left in the document costs the runtime nothing.
                Dropping a library item onto it converts it in place
                (`SetNodeItem`), which is why the layer keeps its id, its
                name, its z-order and its mask links.                       */

export type NodeKind = "image" | "symbol" | "bone" | "group" | "empty";

export interface Node {
  id: NodeId;
  name: string;
  kind: NodeKind;
  parentId: NodeId | null;
  /** Library item for "image" and "symbol" nodes. */
  itemId?: ItemId;
  /** The bind / setup pose. Exports as the bone's `transform` (its origin);
   *  animation frames are offsets from this. */
  bind: Transform;
  /** Transform point, in UNTRIMMED image pixels relative to the image's top
   *  left. Exports as the bone origin plus a compensating normalised
   *  `display.pivot`, so rotation happens about exactly this point and the
   *  artwork does not shift. Values outside the image are legal. */
  pivot: { x: number; y: number };
  /** Further artwork a keyframe can switch to, as in a DragonBones slot's
   *  display list: `displayIndex` k ≥ 1 shows `extraDisplays[k - 1]`, while
   *  `itemId` and `pivot` above are display 0 — the one the bind pose shows.
   *  Absent on a layer that only ever shows one thing. */
  extraDisplays?: DisplayRef[];
  /** Bind-pose colour, exported as `slot.color`. Absent means neutral.
   *  Keyframe colour overrides it wholesale, as it does in the runtime. */
  color?: ColorTransform;
  blendMode?: BlendMode;
  /** Motion blur multiplier, 0 (never blurred) to 2. Absent means 1. On a
   *  symbol instance it scales everything inside it. */
  motionBlur?: number;
  /** Bone length in px — display only, for the bone overlay. */
  boneLength?: number;
  /** Dragging this bone's path turns its parent too (`core/doc/pathEdit.ts`).
   *  Absent: the bone alone. Editor only; never exported. */
  pathDrag?: "parent";
  /** A bone marked as one of the rig's main ones (a leg, an arm, the head):
   *  the stage toolbar's Primary row shows, picks and names it instead of the
   *  Bones row (`boneRow`). Editor only; never exported. */
  primary?: true;
  /** What the bone takes from its parent, Spine's `inherit`. Absent: all of
   *  it. Only the Spine pose applies the other modes (`spinePose.ts`). */
  inherit?: SpineInherit;
  /**
   * Spine's slot on a bone: this layer draws on the bone node named here and
   * has no transform of its own (its bind stays identity, it is never keyed
   * for transform). Its `parentId` is null, so the layer list can hold
   * Spine's draw order, which does not follow the bone tree the way layers
   * do. Exports as a slot on that bone, and no bone of its own.
   */
  slotBone?: NodeId;
  /** The display the bind pose shows; -1 none. Absent: 0. */
  setupDisplay?: number;
  /** Display 0's Spine attachment, when opened from a Spine file. */
  attachment?: SpineAttachmentRef;
  /** Fields of an opened Spine bone or slot the model has no place for,
   *  merged into what the export writes. */
  spine?: { bone?: Record<string, unknown>; slot?: Record<string, unknown> };
}

/** One entry of a node's display list: an item and its own transform point. */
export interface DisplayRef {
  itemId: ItemId;
  pivot: { x: number; y: number };
  /** The Spine attachment it came from, opened from a Spine file. */
  attachment?: SpineAttachmentRef;
}

/**
 * An attachment of an opened Spine file, written back as it came: a region
 * keeps its own offset, rotation and size, a mesh its vertices, weights and
 * triangles. `itemId` is the image its `path` (or name) names.
 */
export interface SpineAttachmentRef {
  /** Its key in the skin: what attachment keys name. */
  name: string;
  /** The attachment's JSON; weighted vertices name their bones. */
  data: Record<string, unknown>;
}

export interface Layer {
  id: LayerId;
  nodeId: NodeId;
  name: string;
  /** Timeline chip colour, also used for the outline-mode wireframe. */
  color: string;
  visible: boolean;
  locked: boolean;
  outline: boolean;
  /** UI indent, mirroring the node hierarchy. */
  depth: number;
  /** Groups only: hide the children in the timeline. */
  collapsed?: boolean;
  /** This layer's artwork clips the layers linked to it, Flash-style. Its own
   *  artwork is never drawn. */
  isMask?: boolean;
  /** The mask layer clipping this one. Must sit ABOVE it (a lower index). */
  maskedBy?: LayerId;
  /** Keep this layer out of the export entirely — reference art, or a test
   *  rig. It still draws on the stage; it does not reach `_ske.json`, the
   *  atlas, the mask sidecar or the Preview. Absent rather than false, so a
   *  saved file stays clean. */
  excludeFromExport?: boolean;
}

/* ── IK ───────────────────────────────────────────────────────────────────
   `chain: 0` solves one bone (look-at); `chain: 1` solves two (the runtime
   takes the parent as the chain root). `target` must reference an existing
   bone node — the editor creates one alongside each constraint.           */

export interface IkConstraint {
  id: IkId;
  name: string;
  boneId: NodeId;
  targetId: NodeId;
  chain: 0 | 1;
  bendPositive: boolean;
  weight: number;
  /** Spine's softness, in pixels: near full reach the two-bone solve eases
   *  into straight over this distance. Absent: 0. */
  softness?: number;
  /** Fields of an opened Spine IK constraint the editor does not solve
   *  (stretch, compress, uniform, skin), merged into the export.
   *  The Spine pose applies them. */
  spine?: Record<string, unknown>;
}

/* ── Animation ────────────────────────────────────────────────────────────
   Keyframes hold ABSOLUTE local transforms, Flash-style, so the editor never
   has to think in offsets. The exporter subtracts the bind pose. Angles are
   never wrapped: `rotateTurns` depends on how far an angle actually
   travelled.                                                              */

/** Rotate CW / CCW: which way a tween turns, whatever the keyed angles say. */
export type RotateDir = "cw" | "ccw";

export interface Keyframe {
  frame: number;
  transform: Transform;
  color?: ColorTransform;
  /** Which display the span shows: 0 is the node's own item, k ≥ 1 its
   *  `extraDisplays[k - 1]`. -1 marks a blank keyframe (F7) — the slot
   *  stays, its display is hidden. */
  displayIndex: number;
  /** Governs the interval STARTING at this keyframe. */
  tween: TweenSpec;
  /** Per-property overrides of `tween` over the same interval, down to one
   *  axis (`TweenChannel`). Ignored while `tween` is a hold. */
  eases?: ChannelEases;
  /** Which way the outgoing tween turns. Absent: as keyed — the angle
   *  travels from this key's value to the next one's, sign included. Set,
   *  the difference is taken modulo a turn in that direction (screen y points
   *  down, so a growing angle is clockwise). */
  rotateDir?: RotateDir;
  /** Extra whole turns over the outgoing interval. With `rotateDir` a count
   *  in that direction; without it signed, + clockwise, which is how files
   *  written before `rotateDir` store it. See `rotationDelta`. */
  rotateTurns?: number;
  /** The bone properties this key is a key OF on the timeline's property
   *  rows (`core/doc/propertyKeys.ts`). Absent: those whose value changes
   *  here. A key a property merely passes through, because another property
   *  needs it, leaves that property out. Editor only; the export samples. */
  keyed?: TimelineProp[];
  label?: string;
}

/** A bone property with a row of its own on the timeline, as in Spine. */
export type TimelineProp = "rotate" | "x" | "y" | "scale" | "shear";
export const TIMELINE_PROPS: readonly TimelineProp[] = ["rotate", "x", "y", "scale", "shear"];

export interface Track {
  nodeId: NodeId;
  /** Sorted ascending by `frame`, never empty for a track that exists. */
  keys: Keyframe[];
  /** Last frame this track occupies. Frames past the final key still show
   *  its content up to here — Flash's frame span. */
  endFrame: number;
}

export interface Animation {
  id: AnimId;
  name: string;
  /** Length in frames. */
  duration: number;
  /** 0 loops forever, matching DragonBones `playTimes`. */
  playTimes: number;
  tracks: Record<NodeId, Track>;
  /**
   * Spine's timing: the animation ends AT its last frame, `duration − 1`,
   * where a loop wraps back to frame 0, rather than after it. A Spine loop
   * keys its last pose there, and tweens into it. Opened animations have it;
   * absent, the export pads a held last frame (Flash's timing).
   */
  endsAtLastFrame?: true;
  /** Timelines of an opened Spine animation the model does not hold
   *  (deform, sequence, draw order, events, constraint and inherit keys),
   *  in Spine's layout, merged into the export. */
  spine?: Record<string, unknown>;
  /** Pictures to animate against, frame by frame. Never exported. */
  reference?: AnimationReference;
  /** The frames the user marked as this animation's key poses, sorted and
   *  unique: the Poses panel's list, which the AI animates between. Never
   *  exported. */
  poses?: number[];
  /** Draw order keys (`core/doc/drawOrder.ts`), sorted by frame: from each
   *  key's frame on, the symbol's drawing layers draw in its order. Absent:
   *  the layer stack, at every frame. */
  drawOrder?: DrawOrderKey[];
  /** IK keys per constraint (`core/doc/ikKeys.ts`), each list sorted by
   *  frame: the constraint's mix and bend from each key on, as Spine's `ik`
   *  timeline. Absent for a constraint: its own weight and bend. */
  ik?: Record<IkId, IkKey[]>;
  /** Event keys (`core/doc/events.ts`), sorted by frame; several may share
   *  one, fired in this order. */
  events?: EventKey[];
}

/** One IK key. `tween` eases the mix (and softness) to the next key: linear when absent,
 *  `none` stepped, or one cubic `curve` (4 numbers). The bend is stepped,
 *  as Spine's is; `bendPositive` is the editor's sense (y down), like
 *  `IkConstraint.bendPositive`. */
export interface IkKey {
  frame: number;
  mix: number;
  bendPositive: boolean;
  /** Tweens with the mix, by the same tween. Absent: the constraint's own. */
  softness?: number;
  tween?: TweenSpec;
}

/** One draw order key: the drawing layers back to front from `frame` on.
 *  No `order`: the setup order (the layer stack) again. A layer the order
 *  does not list keeps its place in the stack beside its neighbours. */
export interface DrawOrderKey {
  frame: number;
  order?: NodeId[];
}

/**
 * Reference art for one animation (`core/doc/reference.ts`): images of one
 * size, the cells of a sprite sheet or a numbered sequence. Image `i` is
 * keyed to frame `at[i]` and shows until the next image's frame (the last
 * holds `hold` frames); `start`/`hold` are the bulk spacing the panel's two
 * fields re-apply across `at`. Drawn on the stage for the animator and shown
 * to the AI to match. Placed in the symbol's own space: the image's top-left
 * at (x, y), `scale` symbol units per image pixel, y down as the editor has
 * it. The images live in the project file like library images.
 */
export interface AnimationReference {
  frames: AssetId[];
  /** Every image's size, in pixels. */
  width: number;
  height: number;
  /** The frame each image is keyed to, one per `frames` entry. */
  at: number[];
  hold: number;
  start: number;
  x: number;
  y: number;
  scale: number;
}

/* ── Document ─────────────────────────────────────────────────────────────*/

export interface StageSettings {
  width: number;
  height: number;
  background: string;
}

/**
 * Per-sprite motion blur, applied at runtime by the `ANIMO_motion_blur`
 * extension. DragonBones cannot carry it, so it ships in `<name>_ext.json`.
 */
export interface MotionBlurSettings {
  enabled: boolean;
  /** Degrees, 0–360: how much of a frame the shutter stays open. */
  shutter: number;
  /** Longest trail, in armature pixels. */
  maxLength: number;
}

export const DEFAULT_MOTION_BLUR: MotionBlurSettings = { enabled: false, shutter: 180, maxLength: 64 };

export interface Project {
  version: number;
  name: string;
  frameRate: number;
  stage: StageSettings;
  /** Absent means off, so older files stay byte-identical when saved. */
  motionBlur?: MotionBlurSettings;
  /** What File ▸ Export writes (`core/export/settings.ts`). Absent means the
   *  defaults, which are what the exporter wrote before the setting existed. */
  exportSettings?: ExportSettings;
  items: Record<ItemId, LibraryItem>;
  folders: Record<FolderId, LibraryFolder>;
  /** Item ids in library display order. */
  itemOrder: ItemId[];
  /** The main scene — itself a SymbolItem, exported as the root armature. */
  rootSymbolId: ItemId;
}

/* ── Narrowing helpers ────────────────────────────────────────────────────*/

export function isSymbol(i: LibraryItem | undefined): i is SymbolItem {
  return i?.kind === "symbol";
}
export function isImage(i: LibraryItem | undefined): i is ImageItem {
  return i?.kind === "image";
}
/** Nodes that become DragonBones slots. Bones and groups do not. */
export function producesSlot(n: Node): boolean {
  return n.kind === "image" || n.kind === "symbol";
}
