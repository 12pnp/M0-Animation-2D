import { apply, applyInverse, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { cloneTf, toMatrix, type Transform } from "@/core/math/Transform";
import { wrapTo180 } from "@/core/math/angle";
import { createKeyframe } from "./defaults";
import type { NodeId } from "./ids";
import { ikChain } from "./ikGraph";
import type { BonePath, PathPointKind } from "./bonePath";
import { insertKeyframe, keyIndexAt, sampleColorRaw, sampleTransformRaw, spanKeyAt } from "./timeline";
import type { Animation, Node, SymbolItem, Track } from "./types";

/**
 * Editing an animation by dragging a bone's path (docs/CYCLE-PATH-PLAN.md,
 * B5). Every decision is here, pure: what a drag moves, the transform it
 * writes, which keys it leaves redundant. The Selection tool only applies it.
 */

export type PathDragMode = "translate" | "rotate" | "rotateWithParent";

export type PathDragRule = { mode: PathDragMode } | { refused: string };

function varies(track: Track | undefined, pick: (t: Transform) => number[]): boolean {
  if (!track || track.keys.length < 2) return false;
  const first = pick(track.keys[0]!.transform);
  return track.keys.some((k) => pick(k.transform).some((v, i) => Math.abs(v - first[i]!) > 1e-6));
}

/**
 * What dragging `id`'s path does:
 *
 * - a bone the IK solves is refused: it is never keyed (ARCHITECTURE ▸ Bones
 *   and IK), and its target's path is the one to drag;
 * - an IK target, the origin, a bone whose keys move it without turning it,
 *   and a root bone that does not turn are moved (`translate`);
 * - any other tip turns the bone (`rotate`), or the bone and its parent when
 *   the bone's option says so (`withParent`) and the parent is a bone the IK
 *   does not solve.
 */
export function pathDragMode(
  sym: SymbolItem, anim: Animation, id: NodeId, which: PathPointKind, withParent: boolean,
): PathDragRule {
  const node = sym.nodes[id];
  if (!node) return { refused: "Nothing to drag." };
  for (const k of sym.ik) {
    if (k.targetId === id) return { mode: "translate" };
    if (ikChain(sym, k).includes(id)) {
      const target = sym.nodes[k.targetId]?.name ?? "its target";
      return { refused: `${node.name} is moved by IK. Drag the path of ${target} instead.` };
    }
  }
  if (which === "origin" || node.kind !== "bone") return { mode: "translate" };
  const track = anim.tracks[id];
  const turns = varies(track, (t) => [t.skewX, t.skewY]);
  const moves = varies(track, (t) => [t.x, t.y]);
  const parent = node.parentId ? sym.nodes[node.parentId] : undefined;
  if (!turns && (moves || parent?.kind !== "bone")) return { mode: "translate" };
  if (withParent && parent?.kind === "bone" && !sym.ik.some((k) => ikChain(sym, k).includes(parent.id))) {
    return { mode: "rotateWithParent" };
  }
  return { mode: "rotate" };
}

/** A node as the stage showed it at the dragged frame when the drag began. */
export interface DragFrame {
  local: Transform;
  world: Matrix2D;
  parentWorld: Matrix2D;
  /** The length its tip is measured with; 0 for the origin. */
  length: number;
}

export interface Point { x: number; y: number }

function tipOf(f: DragFrame): Point {
  return apply({ x: 0, y: 0 }, f.world, f.length, 0);
}

function angleOf(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function turned(t: Transform, deg: number): Transform {
  return { ...t, skewX: t.skewX + deg, skewY: t.skewY + deg };
}

function worldOfLocal(parentWorld: Matrix2D, local: Transform): Matrix2D {
  return mul(mat(), parentWorld, toMatrix(mat(), local));
}

/** The local transform that puts the followed point (tip or origin) on
 *  `target`, the bone keeping its angle. */
export function translateTo(f: DragFrame, target: Point): Transform {
  const tip = tipOf(f);
  const origin = { x: target.x - (tip.x - f.world.tx), y: target.y - (tip.y - f.world.ty) };
  const p = { x: origin.x, y: origin.y };
  if (!applyInverse(p, f.parentWorld, origin.x, origin.y)) return cloneTf(f.local);
  return { ...cloneTf(f.local), x: p.x, y: p.y };
}

/**
 * The local transform that turns the bone about its origin so its tip points
 * at `target`.
 */
export function rotateTo(f: DragFrame, target: Point): Transform {
  if (f.length === 0) return cloneTf(f.local);
  return aim(f, { x: f.length, y: 0 }, target);
}

/**
 * Turn `f` about its origin until `carried` (a point in its own space) lies
 * on the ray from the origin to `target`. Exact, in the parent's space: the
 * parent's matrix is affine, so it maps that ray onto the ray from the local
 * origin to the target brought into the parent's space; and adding the same
 * angle to both skews turns the local matrix by that angle.
 */
function aim(f: DragFrame, carried: Point, target: Point): Transform {
  const goal = { x: target.x, y: target.y };
  if (!applyInverse(goal, f.parentWorld, target.x, target.y)) return cloneTf(f.local);
  const m = toMatrix(mat(), { ...f.local, x: 0, y: 0 });
  const now = apply({ x: 0, y: 0 }, m, carried.x, carried.y);
  const want = angleOf({ x: f.local.x, y: f.local.y }, goal);
  return turned(cloneTf(f.local), wrapTo180(want - angleOf({ x: 0, y: 0 }, now)));
}

/**
 * Two bones, the dragged one and its parent, turned so the dragged bone's tip
 * reaches `target` (as far as the two lengths allow), keeping the way the
 * chain bends now. The first segment runs from the parent's origin to the
 * child's; `parent.length` is unused.
 */
export function rotateWithParentTo(
  child: DragFrame, parent: DragFrame, target: Point,
): { child: Transform; parent: Transform } {
  const a = { x: parent.world.tx, y: parent.world.ty };
  const c = { x: child.world.tx, y: child.world.ty };
  const t = tipOf(child);
  const l1 = Math.hypot(c.x - a.x, c.y - a.y);
  const l2 = Math.hypot(t.x - c.x, t.y - c.y);
  const inParent = { x: c.x, y: c.y };
  if (l1 === 0 || l2 === 0 || !applyInverse(inParent, parent.world, c.x, c.y)) {
    return { child: rotateTo(child, target), parent: cloneTf(parent.local) };
  }
  const cross = (c.x - a.x) * (t.y - c.y) - (c.y - a.y) * (t.x - c.x);
  const bend = cross < 0 ? -1 : 1;
  const d = Math.max(Math.abs(l1 - l2), 1e-9, Math.min(l1 + l2, Math.hypot(target.x - a.x, target.y - a.y)));
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)));
  // The elbow on the side that keeps the bend.
  const elbowAngle = Math.atan2(target.y - a.y, target.x - a.x) - bend * Math.acos(cosA);
  const elbow = { x: a.x + l1 * Math.cos(elbowAngle), y: a.y + l1 * Math.sin(elbowAngle) };

  const parentLocal = aim(parent, inParent, elbow);
  // The child as the turned parent now carries it.
  const parentWorld = worldOfLocal(parent.parentWorld, parentLocal);
  const childWorld = worldOfLocal(parentWorld, child.local);
  return { parent: parentLocal, child: rotateTo({ ...child, parentWorld, world: childWorld }, target) };
}

/** `track` with a key at `frame` (F6's rule: what the stage shows there),
 *  made for a node without a track. `added` when the key is new. */
export function keyAt(
  track: Track | undefined, node: Node, frame: number, duration: number,
): { track: Track; added: boolean } {
  const base: Track = track ?? { nodeId: node.id, keys: [createKeyframe(0, node)], endFrame: Math.max(0, duration - 1) };
  if (keyIndexAt(base, frame) >= 0) return { track: base, added: !track && frame === 0 };
  return { track: insertKeyframe(base, frame, node) ?? base, added: true };
}

/** `track` with the key at `frame` holding `t`. */
export function withKeyTransform(track: Track, frame: number, t: Transform): Track {
  return { ...track, keys: track.keys.map((k) => (k.frame === frame ? { ...k, transform: t } : k)) };
}

/** ⇧-drag: every key moved by what the dragged key moved, position or
 *  angle by `mode`. */
export function shiftKeys(track: Track, from: Transform, to: Transform, mode: PathDragMode): Track {
  const dx = to.x - from.x, dy = to.y - from.y;
  const turn = to.skewY - from.skewY;
  return {
    ...track,
    keys: track.keys.map((k) => ({
      ...k,
      transform: mode === "translate"
        ? { ...k.transform, x: k.transform.x + dx, y: k.transform.y + dy }
        : turned(k.transform, turn),
    })),
  };
}

export interface KeyTolerance { px: number; deg: number; scale: number }
export const KEY_TOLERANCE: Readonly<KeyTolerance> = Object.freeze({ px: 0.01, deg: 0.01, scale: 1e-4 });

function close(a: Transform, b: Transform, tol: KeyTolerance): boolean {
  return Math.abs(a.x - b.x) <= tol.px && Math.abs(a.y - b.y) <= tol.px
    && Math.abs(a.skewX - b.skewX) <= tol.deg && Math.abs(a.skewY - b.skewY) <= tol.deg
    && Math.abs(a.scaleX - b.scaleX) <= tol.scale && Math.abs(a.scaleY - b.scaleY) <= tol.scale;
}

/**
 * `track` without those of the keys at `candidates` that change nothing: the
 * track samples the same at every whole frame (within `tol`, colour and
 * display exactly) with the key gone. The first key stays: a track is never
 * empty. Removal is checked against the track as given, one key at a time,
 * so small errors cannot add up across removed keys.
 */
export function withoutRedundantKeys(
  track: Track, candidates: readonly number[], tol: KeyTolerance = KEY_TOLERANCE,
): Track {
  let out = track;
  for (const frame of [...candidates].sort((a, b) => a - b)) {
    const i = keyIndexAt(out, frame);
    if (i <= 0) continue;
    const trial: Track = { ...out, keys: out.keys.filter((_, j) => j !== i) };
    const from = out.keys[i - 1]!.frame;
    const to = out.keys[i + 1]?.frame ?? out.endFrame;
    let same = true;
    for (let f = from; f <= to && same; f++) {
      const a = sampleTransformRaw(track, f), b = sampleTransformRaw(trial, f);
      const ca = sampleColorRaw(track, f), cb = sampleColorRaw(trial, f);
      same = !!a && !!b && close(a, b, tol)
        && spanKeyAt(track, f)?.displayIndex === spanKeyAt(trial, f)?.displayIndex
        && JSON.stringify(ca) === JSON.stringify(cb);
    }
    if (same) out = trial;
  }
  return out;
}

/**
 * The dot of `paths` under (x, y), within `radius`, all in the symbol's
 * space. Dots pile up where a bone passes the same place twice, as every loop
 * does at its start and end: among the dots under the pointer the one on
 * `current` (the playhead's frame) wins, then a key, then the nearest, then
 * the earliest frame.
 */
export function pathDotAt(
  paths: readonly BonePath[], x: number, y: number, radius: number, current?: number,
): { id: NodeId; frame: number; x: number; y: number } | null {
  let best: { id: NodeId; frame: number; x: number; y: number } | null = null;
  let bestRank: [number, number, number] | null = null;
  for (const path of paths) {
    for (const p of path.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d > radius) continue;
      const rank: [number, number, number] = [p.frame === current ? 0 : 1, p.key ? 0 : 1, d];
      const better = !bestRank || rank[0] < bestRank[0]
        || (rank[0] === bestRank[0] && (rank[1] < bestRank[1] || (rank[1] === bestRank[1] && rank[2] < bestRank[2])));
      if (better) {
        bestRank = rank;
        best = { id: path.id, frame: p.frame, x: p.x, y: p.y };
      }
    }
  }
  return best;
}
