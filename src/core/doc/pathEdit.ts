import { apply, applyInverse, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { withTransform } from "./keyed";
import { cloneTf, toMatrix, type Transform } from "@/core/math/Transform";
import { wrapTo180 } from "@/core/math/angle";
import { createKeyframe } from "./defaults";
import type { NodeId } from "./ids";
import { ikChain } from "./ikGraph";
import { type IkPathDrag, ikPathDrag } from "./ikPathEdit";
import type { BonePath, PathPointKind } from "./bonePath";
import { insertKeyframe, keyIndexAt, sampleColorRaw, sampleTransformRaw, spanKeyAt } from "./timeline";
import type { Animation, Node, SymbolItem, Track } from "./types";

/**
 * Editing an animation by dragging a bone's path (docs/CYCLE-PATH-PLAN.md,
 * B5). Every decision is here, pure: what a drag moves, the transform it
 * writes, which keys it leaves redundant. The Selection tool only applies it.
 */

export type PathDragMode = "translate" | "rotate" | "rotateWithParent";

export type PathDragRule =
  | { mode: PathDragMode }
  | { mode: "throughTarget"; ik: IkPathDrag }
  | { refused: string };

function varies(track: Track | undefined, pick: (t: Transform) => number[]): boolean {
  if (!track || track.keys.length < 2) return false;
  const first = pick(track.keys[0]!.transform);
  return track.keys.some((k) => pick(k.transform).some((v, i) => Math.abs(v - first[i]!) > 1e-6));
}

/**
 * What dragging `id`'s path does:
 *
 * - a bone the IK solves is never keyed (ARCHITECTURE ▸ Bones and IK): the
 *   drag keys its target instead (`throughTarget`, `ikPathDrag`);
 * - an IK target, the origin, a bone whose keys move it without turning it,
 *   and a root bone that does not turn are moved (`translate`);
 * - any other tip turns the bone (`rotate`), or the bone and its parent when
 *   the bone's option says so (`withParent`) and the parent is a bone the IK
 *   does not solve.
 */
export function pathDragMode(
  sym: SymbolItem, anim: Animation, id: NodeId, which: PathPointKind, withParent: boolean, frame?: number,
): PathDragRule {
  const node = sym.nodes[id];
  if (!node) return { refused: "Nothing to drag." };
  if (sym.ik.some((k) => k.targetId === id)) return { mode: "translate" };
  const ik = ikPathDrag(sym, id, which, anim, frame);
  if (ik) return "refused" in ik ? ik : { mode: "throughTarget", ik };
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
  // Turned about where the bone IS, which a Spine constraint can move off
  // where its keys put it (a transform constraint's offset).
  const origin = { x: f.world.tx, y: f.world.ty };
  applyInverse(origin, f.parentWorld, f.world.tx, f.world.ty);
  const m = toMatrix(mat(), { ...f.local, x: 0, y: 0 });
  const now = apply({ x: 0, y: 0 }, m, carried.x, carried.y);
  const want = angleOf(origin, goal);
  return turned(cloneTf(f.local), wrapTo180(want - angleOf({ x: 0, y: 0 }, now)));
}

/**
 * Two bones, the dragged one and its parent, turned so the dragged bone's tip
 * reaches `target` (as far as the two lengths allow), keeping the way the
 * chain bends now. The first segment runs from the parent's origin to the
 * child's; `parent.length` is unused.
 */
export function rotateWithParentTo(
  child: DragFrame, parent: DragFrame, target: Point, bend: 1 | -1 = bendOf(child, parent),
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

/** Which way the chain from `parent` through `child` to its tip bends now:
 *  the sign of the turn at the child, 1 when it is straight. */
export function bendOf(child: DragFrame, parent: DragFrame): 1 | -1 {
  const a = { x: parent.world.tx, y: parent.world.ty };
  const c = { x: child.world.tx, y: child.world.ty };
  const t = tipOf(child);
  return (c.x - a.x) * (t.y - c.y) - (c.y - a.y) * (t.x - c.x) < 0 ? -1 : 1;
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
  return { ...track, keys: track.keys.map((k) => (k.frame === frame ? withTransform(k, t) : k)) };
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
): { id: NodeId; frame: number; x: number; y: number; relativeAt?: number } | null {
  let best: { id: NodeId; frame: number; x: number; y: number; relativeAt?: number } | null = null;
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
        best = { id: path.id, frame: p.frame, x: p.x, y: p.y, ...(path.relativeAt !== undefined ? { relativeAt: path.relativeAt } : {}) };
      }
    }
  }
  return best;
}

/** One frame of an interval to bake: the bone (and its parent, for a
 *  two-bone bake) as the stage shows it there, and where the tip should go. */
export interface BakeFrame {
  frame: number;
  own: DragFrame;
  /** The parent, when it turns too. Its `parentWorld` is the grandparent's. */
  parent?: DragFrame;
  target: Point;
}

/** A key a bake writes: the frame, the bone's local transform, and the
 *  parent's for a two-bone bake. */
export interface BakedKey { frame: number; own: Transform; parent?: Transform }

function lerpTf(a: Transform, b: Transform, t: number): Transform {
  return {
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    skewX: a.skewX + (b.skewX - a.skewX) * t, skewY: a.skewY + (b.skewY - a.skewY) * t,
    scaleX: a.scaleX + (b.scaleX - a.scaleX) * t, scaleY: a.scaleY + (b.scaleY - a.scaleY) * t,
  };
}

/** The same turn as `t`, moved by whole turns to lie within half a turn of
 *  `near`: solved frame by frame, angles must not jump a turn between two. */
function unwrapNear(t: Transform, near: Transform): Transform {
  const turns = Math.round((near.skewY - t.skewY) / 360) * 360;
  return turns ? { ...t, skewX: t.skewX + turns, skewY: t.skewY + turns } : t;
}

/**
 * Bake Path (B5 ▸ Rotation bones): turn the bone, or the bone and its parent,
 * at every frame so its tip follows the targets, then keep only the keys
 * needed. Linear tweens between kept keys must put the tip within `tol` of
 * where the per-frame solve puts it, which is the nearest the bone can reach:
 * a bone that only turns keeps its tip on a circle. Keys are added where the
 * error is largest until none is over (Douglas–Peucker over frames). The
 * first and last frame are always kept.
 */
export function bakePlan(frames: readonly BakeFrame[], tol = 0.5): BakedKey[] {
  if (frames.length < 2) return [];
  // Solve every frame, then unwrap so the angles run on without jumps. A
  // chain bends one way for the whole interval, the way it bends at the
  // start: decided frame by frame, a nearly straight chain flips between the
  // two solutions.
  const solved: BakedKey[] = [];
  const first = frames[0]!;
  const bend = first.parent ? bendOf(first.own, first.parent) : 1;
  for (const f of frames) {
    const prev = solved[solved.length - 1];
    if (f.parent) {
      const both = rotateWithParentTo(f.own, f.parent, f.target, bend);
      solved.push({
        frame: f.frame,
        own: unwrapNear(both.child, prev?.own ?? f.own.local),
        parent: unwrapNear(both.parent, prev?.parent ?? f.parent.local),
      });
    } else {
      solved.push({ frame: f.frame, own: unwrapNear(rotateTo(f.own, f.target), prev?.own ?? f.own.local) });
    }
  }

  const tipFor = (i: number, own: Transform, parent?: Transform): Point => {
    const f = frames[i]!;
    const parentWorld = f.parent && parent ? worldOfLocal(f.parent.parentWorld, parent) : f.own.parentWorld;
    return apply({ x: 0, y: 0 }, worldOfLocal(parentWorld, own), f.own.length, 0);
  };
  const want = solved.map((k, i) => tipFor(i, k.own, k.parent));

  const kept = new Set<number>([0, frames.length - 1]);
  for (;;) {
    const idx = [...kept].sort((a, b) => a - b);
    let worst = -1, worstErr = tol;
    for (let s = 0; s + 1 < idx.length; s++) {
      const i0 = idx[s]!, i1 = idx[s + 1]!;
      const k0 = solved[i0]!, k1 = solved[i1]!;
      const span = frames[i1]!.frame - frames[i0]!.frame;
      for (let i = i0 + 1; i < i1; i++) {
        const t = (frames[i]!.frame - frames[i0]!.frame) / span;
        const own = lerpTf(k0.own, k1.own, t);
        const parent = k0.parent && k1.parent ? lerpTf(k0.parent, k1.parent, t) : undefined;
        const p = tipFor(i, own, parent);
        const err = Math.hypot(p.x - want[i]!.x, p.y - want[i]!.y);
        if (err > worstErr) { worstErr = err; worst = i; }
      }
    }
    if (worst < 0) break;
    kept.add(worst);
  }
  return [...kept].sort((a, b) => a - b).map((i) => solved[i]!);
}

/**
 * `track` with baked keys written into the interval from `from` to the next
 * key: a key at each of `keys` (inside the interval) holding its transform,
 * and the turn linear on every interval between `from` and that next key, as
 * `bakePlan` measured it. Only the turn's ease changes: x, y and scale keep
 * theirs. The interval's ends are not rewritten.
 */
export function withBakedKeys(
  track: Track, node: Node, from: number, keys: ReadonlyArray<{ frame: number; t: Transform }>,
): Track {
  const next = track.keys.find((k) => k.frame > from)?.frame ?? track.endFrame;
  let out = track;
  for (const k of keys) {
    if (k.frame <= from || k.frame >= next) continue;
    out = withKeyTransform(keyAt(out, node, k.frame, track.endFrame + 1).track, k.frame, k.t);
  }
  return {
    ...out,
    keys: out.keys.map((k) => {
      if (k.frame < from || k.frame >= next) return k;
      const key = { ...k, eases: { ...k.eases, rotation: { kind: "linear" as const }, shear: { kind: "linear" as const } } };
      if (key.tween.kind === "none") key.tween = { kind: "linear" };
      delete key.rotateDir;
      delete key.rotateTurns;
      return key;
    }),
  };
}
