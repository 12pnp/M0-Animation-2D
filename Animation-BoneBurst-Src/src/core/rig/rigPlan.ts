import type { IkConstraint, Layer, SymbolItem } from "@/core/doc/types";
import { ikChain } from "@/core/doc/ikGraph";
import { evaluateSymbol } from "@/core/doc/pose";
import type { NodeId } from "@/core/doc/ids";
import { layerRows } from "@/core/doc/layerTree";
import { invert, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { fromMatrix, matrixOf, type Transform, tf } from "@/core/math/Transform";
import { fromBoneBurstLocal } from "@/core/boneburst/transform";

/**
 * Where new rig parts go, decided without a store: the AI's rigging tools
 * (`add_bones`, `attach`) take positions in skeleton space, Spine's
 * convention (y up, degrees counter-clockwise), and these turn them into a
 * setup pose local to the parent, whose world matrix is the editor's (y down).
 */

/** A point in skeleton space, y up: what get_pose and render_frame report. */
export type BoneBurstPoint = readonly [number, number];

/** A pose in skeleton space as an editor world matrix. */
function worldOf(at: BoneBurstPoint, rotation: number, scale: number): Matrix2D {
  return matrixOf(fromBoneBurstLocal({ x: at[0], y: at[1], rotation, shearX: 0, shearY: 0, scaleX: scale, scaleY: scale }));
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
  parentWorld: Matrix2D | undefined, from: BoneBurstPoint, to: BoneBurstPoint,
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
  boneWorld: Matrix2D | undefined, at: BoneBurstPoint, rotation = 0, scale = 1,
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

/**
 * Which way an IK chain should bend: as drawn when the joint is visibly
 * bent, otherwise a knee forward and an elbow back for a side view facing
 * `facing`. Probed by pulling the target in on a copy of the symbol and
 * solving: the solver's choice is not guessable from `bendPositive` alone
 * (ARCHITECTURE ▸ Bones and IK). The constraint whose bend must flip, or
 * null when it already bends that way or nothing decides.
 */
export function bendFlipNeeded(
  s: SymbolItem, effectorName: string, chain: ReadonlyArray<{ name: string; from: BoneBurstPoint; to: BoneBurstPoint }>,
  facing: "right" | "left" | null,
): IkConstraint | null {
  const k = s.ik.find((x) => s.nodes[x.boneId]?.name === effectorName);
  const ids = k ? ikChain(s, k) : [];
  if (!k || ids.length !== 2 || chain.length !== 2) return null;
  const angle = (b: { from: BoneBurstPoint; to: BoneBurstPoint }) => Math.atan2(b.to[1] - b.from[1], b.to[0] - b.from[0]);
  const [root, eff] = ids.map((id) => chain.find((c) => c.name === s.nodes[id]!.name)!);
  const drawn = Math.sin(angle(eff!) - angle(root!));
  // Turn sign root → effector, y up: a knee forward bends a right-facing leg clockwise.
  const leg = /^shin_/.test(effectorName);
  const want = Math.abs(drawn) > 0.05 ? Math.sign(drawn) : facing ? (leg ? -1 : 1) * (facing === "right" ? 1 : -1) : 0;
  if (!want) return null;
  const pose = evaluateSymbol(s, null, 0, "setup");
  const target = s.nodes[k.targetId]!, tw = pose.byNode.get(target.id)?.world, rw = pose.byNode.get(ids[0]!)?.world;
  if (!tw || !rw) return null;
  const parentWorld = target.parentId ? pose.byNode.get(target.parentId)?.world : undefined;
  const pulled = placeOnBone(parentWorld, [tw.tx + 0.25 * (rw.tx - tw.tx), -(tw.ty + 0.25 * (rw.ty - tw.ty))]);
  if (!pulled) return null;
  const probe = evaluateSymbol({ ...s, nodes: { ...s.nodes, [target.id]: { ...target, bind: pulled } } }, null, 0, "setup");
  const [a, b] = ids.map((id) => probe.byNode.get(id)!.world);
  const got = Math.sign(Math.sin(Math.atan2(-b!.b, b!.a) - Math.atan2(-a!.b, a!.a)));
  return got !== want ? k : null;
}
