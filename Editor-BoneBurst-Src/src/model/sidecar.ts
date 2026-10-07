import type { Json, JsonObject } from "./json";

/**
 * `<name>.bb.json` (SPEC §3): what the editor keeps beside a skeleton that does not change what the
 * skeleton means. Deleting it loses only these. Versioned from its first field.
 */
export const SIDECAR_FORMAT = "boneburst-sidecar";
export const SIDECAR_VERSION = 1;

export interface Sidecar {
  /** Camera, zoom, open panels: whatever the interface restores. */
  readonly view: JsonObject;
  readonly guides: readonly Guide[];
  readonly references: readonly Reference[];
  readonly notes: readonly Note[];
  /** A bone's preserved motion path in an animation (docs/PATH-SPEED-PLAN.md). */
  readonly motion: readonly MotionPath[];
  /** Tags on elements of the rig (docs/TAGS-PLAN.md), by the key `edit/tags.ts` makes for the element. */
  readonly tags: readonly TagEntry[];
  /** Keys a newer version of this file wrote at the top level, kept. */
  readonly extra: JsonObject;
}

/** One element's tags, in the order they were added. */
export interface TagEntry {
  readonly key: string;
  readonly tags: readonly string[];
}

export interface Guide {
  readonly axis: "x" | "y";
  /** In skeleton units. */
  readonly at: number;
}

/** A picture to animate against: a file next to the skeleton, placed in skeleton space. */
export interface Reference {
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

/** A note left on the document, by a person or an AI. */
export interface Note {
  readonly text: string;
  readonly author?: string;
  /** What it is about: a bone, slot or animation name. */
  readonly about?: string;
}

/** A spline node (spineNode): where the bone's joint was when it was stored (Local space), and the curve's handle there when one was dragged. It says where, not when. */
export interface MotionNode {
  readonly x: number;
  readonly y: number;
  /** The curve's handle at this node, as an offset from it (the way out; the way in is its mirror): set by dragging a handle, automatic when absent. */
  readonly tx?: number;
  readonly ty?: number;
  /** A broken leg (docs/PATH-FRAMES-PLAN.md): the handle on the way in, as an offset from the node, no longer the mirror of the way out. Both or neither. */
  readonly bx?: number;
  readonly by?: number;
  /** The number the node is known by (its button): set once nodes are reordered, so it keeps its number as the path's order changes; absent = its place in the list. */
  readonly id?: number;
  /** The speed spline's value at this node (docs/TWINSPLINE-PLAN.md): -0.99 to 5, the bone goes `1 + speed` times as fast here; absent = 0, an even pace. */
  readonly speed?: number;
  /** The speed spline's leg at this node (docs/TWINSPLINE-PLAN.md, "Legs"): the slope (speed per unit of progress) it leaves by; the way in mirrors it. Absent = automatic. */
  readonly ss?: number;
  /** A broken speed leg: the slope the speed spline arrives by, no longer the mirror of `ss`. Only with `ss`. */
  readonly sb?: number;
}

/**
 * One bone's motion in one animation (docs/PATH-FRAMES-PLAN.md), kept so its keys can be baked again. The
 * path is a spline through `nodes` (at least two), a ring unless `closed` is off. It runs `frames` frames
 * (counting frame 0: 15 is "14 + 0"). The node times cut it into blocks: the first is always frame 0, `starts`
 * are the others (at least one: two node times), and a block runs to the next node time, the last to the end.
 * `speeds` is a time multiplier for each block (absent = 1); `curves` the speed graph inside each block, flat
 * `[u, v, u, v …]` points from u 0 to 1 (absent or empty = a straight line: even speed). `baked` signs the keys the last bake to the timeline wrote.
 */
export interface MotionPath {
  readonly animation: string;
  readonly bone: string;
  /** The bone whose space the nodes are in (docs/MOTION-PARENT-PLAN.md); absent in a path made before: the bone's own parent. */
  readonly parent?: string;
  readonly nodes: readonly MotionNode[];
  readonly closed: boolean;
  readonly frames: number;
  readonly baked?: string;
}

export const EMPTY_SIDECAR: Sidecar = { view: new Map<string, Json>(), guides: [], references: [], notes: [], motion: [], tags: [], extra: new Map<string, Json>() };
