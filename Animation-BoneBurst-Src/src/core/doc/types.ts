import type { Transform } from "@/core/math/Transform";
import type { ExportSettings } from "@/core/export/settings";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import type { BoneBurstInherit } from "@/core/boneburst/types";
import type { AnimId, AssetId, CnId, FolderId, IkId, ItemId, LayerId, NodeId, TcId } from "./ids";

/** Bumped whenever the on-disk shape changes; `schema.ts` bridges versions. */
export const DOC_VERSION = 27;

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
  /** Transform constraints, applied in the constraint order (after the IK by default), in this order
   *  (`core/math/transformConstraint.ts`, ARCHITECTURE ▸ Transform constraints). */
  transforms?: TransformConstraint[];
  animations: Animation[];
  /** The library folder holding it; absent: the top level. */
  folderId?: FolderId;
  /** Opened from a Spine file: what the model does not hold, carried to the
   *  export as it came. The stage poses such a symbol through the runtime
   *  (`core/boneburst/boneburstPose.ts`), so what it carries is also what it shows. */
  spine?: BoneBurstCarry;
  /** The skins the stage and Preview show, combined as Spine combines
   *  skins (the default skin under them all). Absent: the default skin, or
   *  the first other one when it draws nothing (`stageSkinOf`).
   *  The editor's choice only: the export does not write it. */
  stageSkins?: string[];
  /** Skins made or opened here (ARCHITECTURE ▸ Skins), in order. */
  skins?: SkinDef[];
  /** Physics, slider and path constraints (ARCHITECTURE ▸ Physics, sliders
   *  and paths), applied in the constraint order (by default after the IK and
   *  transform constraints). The runtime
   *  poses a symbol that has any. */
  physics?: PhysicsConstraint[];
  sliders?: SliderConstraint[];
  paths?: PathConstraint[];
  /** The order its constraints are applied in, by name (`core/doc/constraintOrder.ts`,
   *  ARCHITECTURE ▸ Constraint order); one it does not name comes after, in
   *  the default order. Absent: the default order. */
  constraintOrder?: string[];
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
 * bone NAMES here (`core/boneburst/carry.ts`), and the export checks that every
 * name still exists.
 */
export interface BoneBurstCarry {
  /** Header fields other than `spine` and `fps`: hash, bounds, images, audio, referenceScale. */
  header: Record<string, unknown>;
  /** Constraints kept as the file has them. */
  constraints: Array<Record<string, unknown>>;
  /** What of the file's skins the model does not hold (`SymbolItem.skins`
   *  holds the rest), merged back by name on export. */
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

/** "box" and "point": a slot showing Spine's bounding box or point
 *  attachment, drawn only as an outline on the stage (ARCHITECTURE ▸ Boxes
 *  and points). */
export type NodeKind = "image" | "symbol" | "bone" | "group" | "empty" | "box" | "point" | "path";

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
  /** Display 0 as a mesh (ARCHITECTURE ▸ Meshes); extra displays carry their
   *  own. */
  mesh?: MeshData;
  /** Display 0 only in skins (`DisplayRef.skinOnly`). */
  skinOnly?: true;
  /** Display 0's sequence (`DisplayRef.sequence`). */
  sequence?: SequenceData;
  /** A box node's polygon (Spine's bounding box), in its own space, y down;
   *  weighted as a mesh is when opened so (`OutlineWeights`). */
  box?: { points: number[] } & OutlineWeights;
  /** A point node's offset from its origin (Spine's point attachment `x`,
   *  `y`, `rotation`), in its own space: y down, rotation clockwise in
   *  degrees, as the editor's. Absent: at the origin, along its x axis. */
  point?: { x: number; y: number; rotation: number };
  /** Display 0's region turn (`DisplayRef.region`). */
  region?: RegionTurn;
  /** A bone's colour in the editor (Spine's, "rrggbbaa"): the stage and the
   *  Tree draw it; the export writes it as nonessential data. */
  boneColor?: string;
  /** A bone's icon in Spine's editor, by name (`core/doc/boneIcons.ts`; nonessential). */
  boneIcon?: string;
  /** A path node's curve (Spine's path attachment), in its own space, y down. */
  path?: PathShape;
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
   *  it. Only the Spine pose applies the other modes (`boneburstPose.ts`). */
  inherit?: BoneBurstInherit;
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
  attachment?: BoneBurstAttachmentRef;
  /** Display 0's attachment key, kept from an opened file once the model
   *  holds the attachment itself (a mesh made editable): what attachment keys
   *  and linked meshes name. Absent: the image's name. */
  key?: string;
  /** Display 0's attachment name (`DisplayRef.name`). */
  attachmentName?: string;
  /** Display 0's tint (`DisplayRef.tint`). */
  tint?: string;
  /** Display 0 draws another display's mesh (`DisplayRef.linked`). */
  linked?: LinkedMesh;
  /** A box's, point's or path's editor colour ("rrggbbaa", nonessential),
   *  kept from an opened file. */
  attachmentColor?: string;
  /** Fields of an opened Spine bone or slot the model has no place for,
   *  merged into what the export writes. */
  spine?: { bone?: Record<string, unknown>; slot?: Record<string, unknown> };
}

/** One entry of a node's display list: an item and its own transform point. */
export interface DisplayRef {
  itemId: ItemId;
  pivot: { x: number; y: number };
  /** The Spine attachment it came from, opened from a Spine file. */
  attachment?: BoneBurstAttachmentRef;
  /** Its attachment key, as `Node.key` is display 0's. */
  key?: string;
  /** The attachment's own name (Spine's `name`, which the region path
   *  defaults to) where an opened file gave one other than its key. */
  name?: string;
  /** The attachment's own colour, "rrggbbaa" (Spine's `color` on a region,
   *  mesh or linked mesh), multiplied into the slot's. Absent: white. Only
   *  spine-core poses it (`runtimePosed`). */
  tint?: string;
  /** It draws another display's mesh with its own image (Spine's linked mesh). */
  linked?: LinkedMesh;
  /** The image as a mesh (ARCHITECTURE ▸ Meshes), exported as a Spine mesh
   *  attachment. */
  mesh?: MeshData;
  /** The default skin leaves it empty: only a skin shows something here
   *  (Spine's skin placeholder, ARCHITECTURE ▸ Skins). */
  skinOnly?: true;
  /** Frame-by-frame images in place of `itemId` (ARCHITECTURE ▸ Sequences). */
  sequence?: SequenceData;
  /** An opened region's rotation and scale, Spine's own (y up, counterclockwise),
   *  about its centre. The pivot still places the centre as if unturned. Only
   *  spine-core poses it (`runtimePosed`). */
  region?: RegionTurn;
}

export interface RegionTurn {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
}

/** A box's or path's points bound to bones, as `MeshData.weights` and
 *  `boneOffsets` bind a mesh's (one entry per point). */
export interface OutlineWeights {
  weights?: Array<Array<[NodeId, number]>>;
  boneOffsets?: Array<Array<[number, number]>>;
}

/** A display drawing the mesh of display `to` of the same node with its own
 *  image, as Spine's linked mesh does: the same points, triangles and weights,
 *  and the mesh's deform keys unless `deform` is false (Spine's `timelines`). */
export interface LinkedMesh {
  to: number;
  deform?: false;
  /** The skin whose display `to` holds the mesh (Spine's `skin`). Absent:
   *  the node's own display. */
  skin?: string;
}

/** A display's images in order, all the size of the first, which `itemId`
 *  names; `setup` the one the setup pose shows. Spine's region sequence. */
export interface SequenceData {
  items: ItemId[];
  setup?: number;
}

/** Spine's sequence modes: how the images advance from a key. */
export type SequenceMode = "hold" | "once" | "loop" | "pingpong" | "onceReverse" | "loopReverse" | "pingpongReverse";

/** From `frame` on, the image at `index` and then, unless `mode` is hold,
 *  one more every `delay` frames (Spine's sequence timeline). */
export interface SequenceKey {
  frame: number;
  mode: SequenceMode;
  index: number;
  delay: number;
}

/**
 * A skin (ARCHITECTURE ▸ Skins): what it shows in place of a node's
 * displays, by display index, and the bones and constraints only the skins
 * listing them have. The default skin is the nodes' own displays.
 */
export interface SkinDef {
  /** Unique; never "default". */
  name: string;
  /** Its colour in Spine's editor, "rrggbbaa" (nonessential; the runtimes do
   *  not read it). Absent: Spine's default. */
  color?: string;
  /** node → display index → what this skin shows there. */
  displays?: Record<NodeId, Record<string, DisplayRef>>;
  bones?: NodeId[];
  ik?: IkId[];
  transforms?: TcId[];
  /** Physics, slider and path constraints only this skin has. */
  constraints?: CnId[];
  /** Its own box, point or path for a box, point or path node: Spine's
   *  attachment under the node's key in this skin (`skinnedOutline`). */
  outlines?: Record<NodeId, SkinOutline>;
}

/** A skin's box, point or path for a node, the node's own kind. */
export interface SkinOutline {
  box?: { points: number[] } & OutlineWeights;
  path?: PathShape;
  point?: { x: number; y: number; rotation: number };
}

/**
 * An image's mesh (`core/mesh/`). Points are in the image's pixels (y down,
 * origin top-left): where each point is and the texture it shows. The first
 * `hull` points, in order, are the outline. `weights`: per point, the bones
 * it follows and how much, summing to 1; absent, the mesh follows its node.
 */
export interface MeshData {
  /** The image's size when the mesh was made: the texture's extent. */
  width: number;
  height: number;
  /** Each point's place in the image (x, y in pixels, y down): its texture
   *  coordinate, and its setup position when `vertices` is absent. */
  points: number[];
  triangles: number[];
  hull: number;
  weights?: Array<Array<[NodeId, number]>>;
  /** Each point's setup position, in the same frame as `points`, where it is
   *  not its texture coordinate: an opened Spine mesh's, whose vertices are
   *  not where its UVs put them (`meshPositions`). */
  vertices?: number[];
  /** Spine's mesh edges (nonessential), kept from an opened file. */
  edges?: number[];
  /** Per point, per weight entry, where the point is in that bone's setup
   *  space (y down), as Spine stores a weighted vertex: an opened mesh's,
   *  whose bones need not agree on one setup position. Absent: derived from
   *  the point's position (`S⁻¹ · N · p`). Dropped when the weights change. */
  boneOffsets?: Array<Array<[number, number]>>;
}

/** One deform key: each point's offset from its place (x, y per point, in
 *  the node's space, y down) from `frame` on, tweened to the next key. */
export interface DeformKey {
  frame: number;
  offsets: number[];
  tween?: TweenSpec;
}

/**
 * An attachment of an opened Spine file, written back as it came: a region
 * keeps its own offset, rotation and size, a mesh its vertices, weights and
 * triangles. `itemId` is the image its `path` (or name) names.
 */
export interface BoneBurstAttachmentRef {
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
  /** Scale the bone along its length to reach a target out of reach. */
  stretch?: boolean;
  /** Scale it down for a target nearer than its length (one bone). */
  compress?: boolean;
  /** How scale y follows a stretch or compress: with it (uniform), keeping
   *  the bone's area (volume); absent, it stays. */
  scaleY?: "uniform" | "volume";
  /** Fields of an opened Spine IK constraint the editor does not model,
   *  merged into the export. The Spine pose applies them. */
  spine?: Record<string, unknown>;
}

/* ── Transform constraints ────────────────────────────────────────────────
   Spine 4.3's: `boneIds` follow `sourceId` through `properties`, a map from
   a source property to target properties. Every value as Spine writes it,
   y up (rotation counter-clockwise).                                      */

/** What a transform constraint reads from its source and drives in its bones
 *  (Spine 4.3's property names). */
export type TcChannel = "rotate" | "x" | "y" | "scaleX" | "scaleY" | "shearY";
export const TC_CHANNELS: readonly TcChannel[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];
/** One target property a source property drives: `offset + value × scale`,
 *  clamped toward `max` when the constraint clamps. */
export interface TcTo { to: TcChannel; offset: number; max: number; scale: number }
/** A source property, less its `offset`, and the target properties it drives. */
export interface TcFrom { from: TcChannel; offset: number; to: TcTo[] }

export interface TransformConstraint {
  id: TcId;
  name: string;
  boneIds: NodeId[];
  sourceId: NodeId;
  /** Read the source's local values rather than its world ones. */
  localSource?: boolean;
  /** Write the bones' local values rather than their world ones. */
  localTarget?: boolean;
  /** Add to the bones' values rather than replace them ("Relative"). */
  additive?: boolean;
  /** Keep each result between its property's offset and max. */
  clamp?: boolean;
  /** Added to what the source reads, per property; absent: 0. */
  offsets?: Partial<Record<TcChannel, number>>;
  /** How far each target property goes, 0..1 (the runtime allows more). */
  mix: Record<TcChannel, number>;
  properties: TcFrom[];
  /** Fields of an opened constraint the editor does not model (skin),
   *  merged into the export. */
  spine?: Record<string, unknown>;
}

/** One transform constraint key: its mixes from `frame` on, tweened to the
 *  next key by `tween` (linear when absent, `none` stepped, one cubic). */
export interface TcKey {
  frame: number;
  mix: Record<TcChannel, number>;
  tween?: TweenSpec;
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
  /** Transform constraint keys per constraint (`core/doc/transformKeys.ts`),
   *  each list sorted by frame. Absent for a constraint: its own mixes. */
  transforms?: Record<TcId, TcKey[]>;
  /** Deform keys per mesh node (`core/mesh/deform.ts`), each list sorted by
   *  frame. Absent: the mesh as made. Display 0's of the default skin. */
  deforms?: Record<NodeId, DeformKey[]>;
  /** Deform keys of every other mesh display: by skin ("default" for a node's
   *  own displays past 0), node and display index (`deformKeysOf`). */
  displayDeforms?: Record<string, Record<NodeId, Record<string, DeformKey[]>>>;
  /** Sequence keys of nodes whose display 0 is a sequence (ARCHITECTURE ▸ Sequences). */
  sequences?: Record<NodeId, SequenceKey[]>;
  /** Inherit mode keys per bone (`core/doc/inherit.ts`), each list sorted by
   *  frame: the mode from each key on, stepped. Absent: the bone's own. */
  inherits?: Record<NodeId, InheritKey[]>;
  /** Keys of physics, slider and path constraints (`core/doc/constraintKeys.ts`):
   *  per constraint, per channel (mix, inertia, time, position, …), each list
   *  sorted by frame. Absent for a channel: the constraint's own value. */
  constraintKeys?: Record<CnId, Record<string, ValueKey[]>>;
}

/** One key of one value: `value` from `frame` on, tweened to the next key by
 *  `tween` (linear when absent, `none` stepped, one cubic). */
export interface ValueKey {
  frame: number;
  value: number;
  tween?: TweenSpec;
}

/** One inherit key: the bone takes `inherit` of its parent from `frame` on. */
export interface InheritKey {
  frame: number;
  inherit: BoneBurstInherit;
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
  return n.kind === "image" || n.kind === "symbol" || n.kind === "box" || n.kind === "point" || n.kind === "path";
}

/* ── Physics, sliders and paths ───────────────────────────────────────────
   Spine 4.3's, every value as Spine writes it and absent at Spine's
   default (`core/doc/constraints.ts` has the defaults), solved by the
   runtime, which poses any symbol that has one.                          */

/** A bone that lags, springs and sways (Spine's physics constraint). `x`
 *  … `shearX` say how much of each property the simulation moves, 0..1. */
export interface PhysicsConstraint {
  id: CnId;
  name: string;
  boneId: NodeId;
  x?: number; y?: number; rotate?: number; scaleX?: number; shearX?: number;
  scaleY?: "uniform" | "volume";
  limit?: number; fps?: number;
  inertia?: number; strength?: number; damping?: number; mass?: number; wind?: number; gravity?: number; mix?: number;
}

export type SliderProperty = "rotate" | "x" | "y" | "scaleX" | "scaleY" | "shearY";

/** An animation played by a value (Spine 4.3's slider): `time` itself, or a
 *  bone's `property` mapped `from` → `to` seconds at `scale`. */
export interface SliderConstraint {
  id: CnId;
  name: string;
  animId: AnimId;
  additive?: boolean;
  loop?: boolean;
  mix?: number;
  boneId?: NodeId;
  property?: SliderProperty;
  from?: number; to?: number; scale?: number; max?: number; local?: boolean;
  time?: number;
}

/** Bones laid along a path node's curve (Spine's path constraint). */
export interface PathConstraint {
  id: CnId;
  name: string;
  boneIds: NodeId[];
  pathId: NodeId;
  positionMode?: "fixed" | "percent";
  spacingMode?: "length" | "fixed" | "percent" | "proportional";
  rotateMode?: "tangent" | "chain" | "chainScale";
  rotation?: number; position?: number; spacing?: number;
  mixRotate?: number; mixX?: number; mixY?: number;
}

/** A path's points, three per knot: the handle in, the knot, the handle out. */
export interface PathShape extends OutlineWeights {
  points: number[];
  closed?: boolean;
  /** Absent: true (Spine's default). */
  constantSpeed?: boolean;
  /** An opened file's `lengths` and the shape they were measured on: written
   *  back while the shape is unchanged (`fileLengthsOf`), since Spine's own
   *  measure need not be ours to the last digit. */
  fileLengths?: { points: number[]; closed?: boolean; lengths: number[] };
}

