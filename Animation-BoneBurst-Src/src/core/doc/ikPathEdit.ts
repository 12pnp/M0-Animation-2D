import { apply, applyInverse, type Matrix2D } from "@/core/math/Matrix2D";
import { cloneTf, type Transform } from "@/core/math/Transform";
import { DRAWN_BONE_LENGTH, type PathPointKind } from "./bonePath";
import { createKeyframe } from "./defaults";
import type { IkId, NodeId } from "./ids";
import { ikChain } from "./ikGraph";
import { ikPoseAt, withIkKey } from "./ikKeys";
import { withTransform } from "./keyed";
import type { Pose } from "./pose";
import { insertKeyframe, keyIndexAt } from "./timeline";
import type { Animation, IkConstraint, SymbolItem, Track } from "./types";

/**
 * Dragging the path of a bone the IK solves (docs/IK-PATH-PLAN.md). A chain
 * bone is never keyed, so the drag keys the constraint's target instead, at
 * the place that puts the dragged dot under the pointer:
 *
 * - `tip`: the effector's tip of a two-bone chain;
 * - `joint`: the knee (the root's tip or the effector's origin): it turns
 *   about the root's origin and the effector keeps its world angle; pulled
 *   across the leg it keys the bend flipped at that frame;
 * - `aim`: a one-bone chain's tip: the target goes on the ray from the bone
 *   through the pointer, at its own distance.
 */
export type IkPathRole = "tip" | "joint" | "aim";

export interface IkPathDrag {
  ik: IkId;
  role: IkPathRole;
}

export interface Point { x: number; y: number }

/** How a drag on `id`'s path goes through its IK target, or why it cannot;
 *  null when no constraint solves `id`. With `anim` and `frame` the mix is
 *  the keyed one there (`ikPoseAt`), else the constraint's weight. */
export function ikPathDrag(
  sym: SymbolItem, id: NodeId, which: PathPointKind, anim?: Animation | null, frame?: number,
): IkPathDrag | { refused: string } | null {
  const node = sym.nodes[id];
  if (!node) return null;
  for (const k of sym.ik) {
    const chain = ikChain(sym, k);
    if (!chain.includes(id)) continue;
    // With no weight the bone plays its own keys: the plain rules apply.
    if ((frame === undefined ? k.weight : ikPoseAt(k, anim, frame).mix) === 0) return null;
    const target = sym.nodes[k.targetId];
    if (!target) return { refused: `${node.name} is moved by IK, and its target is missing.` };
    if (insideChain(sym, k.targetId, chain[0]!)) {
      return { refused: `${target.name} hangs inside the chain it drives, so the IK is not solved.` };
    }
    const layer = sym.layers.find((l) => l.nodeId === k.targetId);
    if (layer && (layer.locked || !layer.visible)) {
      return { refused: `${node.name} is moved by IK, and its target ${target.name} is ${layer.locked ? "locked" : "hidden"}.` };
    }
    const twoBone = chain.length === 2;
    const isRoot = twoBone && id === chain[0];
    if (which === "origin" && (isRoot || !twoBone)) {
      const parent = node.parentId ? sym.nodes[node.parentId]?.name : undefined;
      return { refused: `The IK only turns ${node.name}: its origin follows ${parent ? `its parent. Drag the path of ${parent}` : "its parent"}.` };
    }
    if (!twoBone) return { ik: k.id, role: "aim" };
    return { ik: k.id, role: isRoot || which === "origin" ? "joint" : "tip" };
  }
  return null;
}

function insideChain(sym: SymbolItem, id: NodeId, rootId: NodeId): boolean {
  let cursor: NodeId | null | undefined = id;
  for (let guard = 0; cursor && guard < 64; guard++) {
    if (cursor === rootId) return true;
    cursor = sym.nodes[cursor]?.parentId;
  }
  return false;
}

/** The length the stage measures a bone's tip with (the drawn dot). */
function tipLength(sym: SymbolItem, id: NodeId): number {
  const n = sym.nodes[id];
  return n?.kind === "bone" ? n.boneLength ?? DRAWN_BONE_LENGTH : 0;
}

const originOf = (m: Matrix2D): Point => ({ x: m.tx, y: m.ty });
const tipOf = (m: Matrix2D, length: number): Point => apply({ x: 0, y: 0 }, m, length, 0);
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const len = (p: Point): number => Math.hypot(p.x, p.y);
const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x;
function along(from: Point, toward: Point, distance: number): Point {
  const d = sub(toward, from), l = len(d);
  return l < 1e-9 ? from : { x: from.x + (d.x / l) * distance, y: from.y + (d.y / l) * distance };
}

/**
 * The target's local transform at `frame` that puts it at `world`: the
 * frame's local with x, y moved, in the target's parent's space there.
 */
export function targetLocalAt(start: Pose, targetId: NodeId, world: Point): Transform | null {
  const e = start.byNode.get(targetId);
  if (!e) return null;
  const parentId = e.node.parentId;
  const parent = parentId ? start.byNode.get(parentId)?.world : undefined;
  const p = { x: world.x, y: world.y };
  if (parent && !applyInverse(p, parent, world.x, world.y)) return null;
  return { ...cloneTf(e.local), x: p.x, y: p.y };
}

/** `anim` with `targetId` keyed at `frame` to `local`, for posing a trial. */
export function withTargetAt(anim: Animation, sym: SymbolItem, targetId: NodeId, frame: number, local: Transform): Animation {
  const node = sym.nodes[targetId]!;
  let track: Track = anim.tracks[targetId]
    ?? { nodeId: targetId, keys: [createKeyframe(0, node)], endFrame: Math.max(0, anim.duration - 1) };
  if (keyIndexAt(track, frame) < 0) track = insertKeyframe(track, frame, node) ?? track;
  track = { ...track, keys: track.keys.map((k) => (k.frame === frame ? withTransform(k, local) : k)) };
  return { ...anim, tracks: { ...anim.tracks, [targetId]: track } };
}

/** `anim` with the constraint's bend keyed flipped at `frame`, the mix kept:
 *  a knee dragged across the leg. */
export function withBendFlippedAt(anim: Animation, k: IkConstraint, frame: number): Animation {
  const now = ikPoseAt(k, anim, frame);
  const keys = withIkKey(anim.ik?.[k.id] ?? [], frame, { ...now, bendPositive: !now.bendPositive }, k.softness);
  return { ...anim, ik: { ...anim.ik, [k.id]: keys } };
}

/** Where the target goes, and whether the bend flips there. */
export interface IkTargetFit { target: Point; flip: boolean }

/** Within this many pixels the solved tip counts as on the pointer. */
const REACHED = 1e-3;

/**
 * Where to put the target (world) so the dot dragged by `drag` follows the
 * pointer: the pointer is `dot` (where the dot was at the press) moved by
 * `delta`. `start` is the frame's pose at the press; `poseWith` poses the
 * frame with the target at a world point, the bend flipped when asked. A
 * knee pulled across the leg (the turn at the knee changing sign) flips the
 * bend, since the solver only bends the way the constraint says.
 */
export function ikTargetFor(
  sym: SymbolItem, drag: IkPathDrag, start: Pose, delta: Point,
  poseWith: (targetWorld: Point, flip: boolean) => Pose,
): IkTargetFit | null {
  const k: IkConstraint | undefined = sym.ik.find((c) => c.id === drag.ik);
  if (!k) return null;
  const chain = ikChain(sym, k);
  const effector = start.byNode.get(k.boneId);
  const target = start.byNode.get(k.targetId);
  if (!effector || !target) return null;
  const length = tipLength(sym, k.boneId);
  const target0 = originOf(target.world);
  const tip0 = tipOf(effector.world, length);

  if (drag.role === "aim") {
    const o = originOf(effector.world);
    const goal = add(tip0, delta);
    const d = len(sub(target0, o));
    return { target: along(o, goal, d > 1e-6 ? d : length), flip: false };
  }

  let goal = add(tip0, delta);
  let flip = false;
  if (drag.role === "joint") {
    const root = start.byNode.get(chain[0]!);
    if (!root) return null;
    const r = originOf(root.world), j = originOf(effector.world);
    const shin = sub(tip0, j);
    const knee = along(r, add(j, delta), len(sub(j, r)));
    goal = add(knee, shin);
    const was = cross(sub(j, r), shin), now = cross(sub(knee, r), shin);
    flip = Math.abs(was) > 1e-9 && Math.abs(now) > 1e-9 && Math.sign(was) !== Math.sign(now);
  }

  // The solved tip is a smooth function of the target: move the target by
  // what the tip misses until it lands. Out of reach the chain straightens
  // and the tip stops short; then the target goes on the pointer, so the
  // chain points at it.
  let t = add(target0, sub(goal, tip0));
  let best: { t: Point; err: number } | null = null;
  for (let i = 0; i < 12; i++) {
    const e = poseWith(t, flip).byNode.get(k.boneId);
    if (!e) return null;
    const miss = sub(goal, tipOf(e.world, length));
    const err = len(miss);
    if (!best || err < best.err) best = { t, err };
    if (err < REACHED) return { target: t, flip };
    t = add(t, miss);
  }
  return { target: best && best.err < 0.5 ? best.t : goal, flip };
}
