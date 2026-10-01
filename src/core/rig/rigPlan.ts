import type { Layer, SymbolItem } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { layerRows } from "@/core/doc/layerTree";
import { invert, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { fromMatrix, matrixOf, type Transform, tf } from "@/core/math/Transform";
import { fromSpineLocal } from "@/core/spine/transform";

/**
 * Where new rig parts go, decided without a store: the AI's rigging tools
 * (`add_bones`, `attach`) take positions in skeleton space, Spine's
 * convention (y up, degrees counter-clockwise), and these turn them into a
 * setup pose local to the parent, whose world matrix is the editor's (y down).
 */

/** A point in skeleton space, y up: what get_pose and render_frame report. */
export type SpinePoint = readonly [number, number];

/** A pose in skeleton space as an editor world matrix. */
function worldOf(at: SpinePoint, rotation: number, scale: number): Matrix2D {
  return matrixOf(fromSpineLocal({ x: at[0], y: at[1], rotation, shearX: 0, shearY: 0, scaleX: scale, scaleY: scale }));
}

/** `world` as a setup pose under `parentWorld`; null when the parent's
 *  matrix is singular (a bone scaled to nothing). */
function localTo(parentWorld: Matrix2D | undefined, world: Matrix2D): Transform | null {
  if (!parentWorld) return fromMatrix(tf(), world);
  const inverse = mat();
  if (!invert(inverse, parentWorld)) return null;
  return fromMatrix(tf(), mul(mat(), inverse, world));
}

/**
 * A bone from its joint `from` to its tip `to`, unscaled in the world.
 * The length is the world distance: a bone's length runs along its own x
 * axis, which is unit length in the world whatever its parents' scale.
 */
export function boneFromWorld(
  parentWorld: Matrix2D | undefined, from: SpinePoint, to: SpinePoint,
): { bind: Transform; length: number } | null {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  const bind = localTo(parentWorld, worldOf(from, (Math.atan2(dy, dx) * 180) / Math.PI, 1));
  return bind && { bind, length };
}

/**
 * An image node on a bone: its transform point (the pivot pixel) at `at`,
 * turned `rotation` degrees counter-clockwise in the world — 0 shows the
 * picture upright, as it was drawn.
 */
export function placeOnBone(
  boneWorld: Matrix2D | undefined, at: SpinePoint, rotation = 0, scale = 1,
): Transform | null {
  return localTo(boneWorld, worldOf(at, rotation, scale));
}

/**
 * The layer list with `parentId`'s children `front` drawn in that order,
 * front first, in the places the listed children held among their siblings;
 * the unlisted ones keep theirs. Each child's subtree moves with it (the
 * list is walked depth first). A string is what is wrong with the request.
 */
export function siblingOrder(sym: SymbolItem, parentId: NodeId | null, front: readonly NodeId[]): Layer[] | string {
  if (new Set(front).size !== front.length) return "A name is listed twice.";
  const isChild = (l: Layer) => (sym.nodes[l.nodeId]?.parentId ?? null) === parentId;
  const slots: number[] = [];
  sym.layers.forEach((l, i) => { if (isChild(l) && front.includes(l.nodeId)) slots.push(i); });
  if (slots.length !== front.length) {
    const stray = front.find((id) => !sym.layers.some((l) => l.nodeId === id && isChild(l)));
    return `"${sym.nodes[stray!]?.name ?? stray}" is not a child of ${parentId ? `"${sym.nodes[parentId]?.name}"` : "the skeleton's root"}.`;
  }
  const layers = [...sym.layers];
  front.forEach((id, k) => { layers[slots[k]!] = sym.layers.find((l) => l.nodeId === id)!; });
  return layerRows({ ...sym, layers }, true).map((r) => r.layer);
}
