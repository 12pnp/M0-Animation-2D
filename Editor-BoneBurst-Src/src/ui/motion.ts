import { arrivalTimes, curveOf, DEFAULT_DURATION, pathPose, pathTime, progressAtTime } from "@/motion";
import type { LocalPose } from "@/edit/boneKeys";
import { deleteTranslateKeys, fitChannel, type PathKey, setupXY, translateKeys, writeTranslateKeys } from "@/edit/pathKeys";
import { motionOf, withMotion } from "@/edit/sidecar";
import { EditRefused } from "@/edit/history";
import type { Skeleton } from "@/model/skeleton";
import type { MotionNode, MotionPath } from "@/model/sidecar";
import type { Session } from "./session";
import { type Matrix, moveDelta } from "./stage/gizmo";
import { boneMatrix, parentMatrix, type Posed } from "./stage/posed";

/**
 * A bone's motion path in the open project (docs/PATH-SPEED-PLAN.md): finding it, making the first
 * one from the motion the bone has now, and baking its keys. The curve, the timing and the key
 * edit are pure (`edit/motionPath.ts`); this is where the rig is posed to turn the path's points,
 * which are in the reference bone's space (docs/MOTION-PARENT-PLAN.md), into the bone's local x and y.
 */

/** The path kept for the selected bone in the animation shown, or undefined. */
export function motionFor(s: Session): MotionPath | undefined {
  const a = s.animation, bone = s.selectedBone;
  return a && bone ? motionOf(s.sidecar, a.name, bone) : undefined;
}

/**
 * The bone whose space a path's nodes are in (docs/MOTION-PARENT-PLAN.md): the one the person chose, else (a path made
 * before the choice existed) the path's own bone's parent; null for the root with none, whose space is the world's.
 */
export function refBoneName(doc: Skeleton | null | undefined, m: Pick<MotionPath, "bone" | "parent">): string | null {
  if (m.parent !== undefined) return m.parent;
  return doc?.bones?.find((b) => b.name === m.bone)?.parent ?? null;
}

/** The bones a path of `bone` may be relative to: every bone but it and those under it (it cannot be placed by its own child). */
export function parentChoices(doc: Skeleton | null | undefined, bone: string): string[] {
  const under = new Set([bone]);
  for (const b of doc?.bones ?? []) if (b.parent !== undefined && under.has(b.parent)) under.add(b.name);
  return (doc?.bones ?? []).map((b) => b.name).filter((n) => !under.has(n));
}

/** The reference bone's world matrix in the pose (the identity when there is none, the world's own space). */
export function refMatrix(p: Posed, ref: string | null): Matrix {
  const i = ref === null ? undefined : p.bones.get(ref);
  return i === undefined ? [1, 0, 0, 1, 0, 0] : boneMatrix(p, i);
}

/** A point of the reference bone's space as the panel shows it: through the bone's matrix, from the bone's joint (its translation left out). */
export function toView(M: Matrix, x: number, y: number): [number, number] {
  return [M[0] * x + M[1] * y + 0, M[2] * x + M[3] * y + 0];
}

/** The reference bone's space from a point the panel shows (the inverse of `toView`). */
export function fromView(M: Matrix, x: number, y: number): [number, number] {
  const [a, b] = moveDelta(M, x, y);
  return [a + 0, b + 0];
}

// `+ 0` turns a negative zero into 0.
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4 + 0;

/** A path with its nodes and handles through `M`: what the panel draws and hits (the parent turned, the path with it). */
export function pathToView(m: MotionPath, M: Matrix): MotionPath {
  const f = (x: number, y: number): [number, number] => toView(M, x, y);
  return { ...m, nodes: m.nodes.map((n) => {
    const [x, y] = f(n.x, n.y), out: MotionNode = { ...n, x, y };
    if (n.tx !== undefined && n.ty !== undefined) { const [tx, ty] = f(n.tx, n.ty); Object.assign(out, { tx, ty }); }
    if (n.bx !== undefined && n.by !== undefined) { const [bx, by] = f(n.bx, n.by); Object.assign(out, { bx, by }); }
    return out;
  }) };
}

/**
 * A path the panel changed (in its view) back to the reference bone's space. A node whose view place is where `stored` puts it
 * keeps its stored numbers, so an edit of one node does not move the others by rounding.
 */
export function pathFromView(view: MotionPath, M: Matrix, stored?: MotionPath): MotionPath {
  const was = stored ? pathToView(stored, M) : undefined;
  const same = (a: number | undefined, b: number | undefined): boolean => a === b || (a !== undefined && b !== undefined && Math.abs(a - b) < 1e-6);
  return { ...view, nodes: view.nodes.map((n, i) => {
    const old = stored?.nodes[i], seen = was?.nodes[i];
    if (old && seen && n.id === old.id && same(n.x, seen.x) && same(n.y, seen.y) && same(n.tx, seen.tx) && same(n.ty, seen.ty) && same(n.bx, seen.bx) && same(n.by, seen.by) && n.speed === old.speed) return old;
    // A part that did not change keeps its stored numbers (a handle dragged leaves the node's place exactly as it was).
    const placed = old && seen && same(n.x, seen.x) && same(n.y, seen.y);
    const [x, y] = placed ? [old.x, old.y] : fromView(M, n.x, n.y), out: MotionNode = { ...n, x: placed ? x : r4(x), y: placed ? y : r4(y) };
    if (n.tx !== undefined && n.ty !== undefined) {
      if (old?.tx !== undefined && old.ty !== undefined && seen && same(n.tx, seen.tx) && same(n.ty, seen.ty)) Object.assign(out, { tx: old.tx, ty: old.ty });
      else { const [tx, ty] = fromView(M, n.tx, n.ty); Object.assign(out, { tx: r4(tx), ty: r4(ty) }); }
    }
    if (n.bx !== undefined && n.by !== undefined) {
      if (old?.bx !== undefined && old.by !== undefined && seen && same(n.bx, seen.bx) && same(n.by, seen.by)) Object.assign(out, { bx: old.bx, by: old.by });
      else { const [bx, by] = fromView(M, n.bx, n.by); Object.assign(out, { bx: r4(bx), by: r4(by) }); }
    }
    return out;
  }) };
}

/**
 * A new path for the selected bone (docs/PATH-FRAMES-PLAN.md): a ring through two nodes, the bone's place
 * now and that place plus an offset (the length of the bone, along x), run in half a second. Null when there is no animation, bone or pose.
 */
export function startMotion(s: Session, parent: string): MotionPath | null {
  const a = s.animation, bone = s.selectedBone, here = currentNode(s, parent), p = s.pose();
  if (!a || !bone || !here || !p) return null;
  const i = p.bones.get(bone)!, length = Math.max(20, p.rig.data.bones[i]!.length);
  return { animation: a.name, bone, parent, nodes: [here, { x: here.x + length, y: here.y }], closed: true, duration: DEFAULT_DURATION, loop: true };
}

/** A node after `last`: its place plus the same offset the first two have (a bone length along x). */
export function nodeAfter(s: Session, last: MotionNode): MotionNode {
  const bone = s.selectedBone, p = s.pose(), i = bone && p ? p.bones.get(bone) : undefined;
  const length = Math.max(20, i !== undefined ? p!.rig.data.bones[i]!.length : 20);
  return { x: last.x + length, y: last.y };
}

/**
 * The selected bone's joint as it is posed now (an unkeyed pose the artist dragged to included), in the
 * reference bone's space: what a red button stores. Null when the bone has no pose.
 */
export function currentNode(s: Session, parent: string | null): MotionNode | null {
  const bone = s.selectedBone, p = s.pose();
  if (!bone || !p) return null;
  const i = p.bones.get(bone);
  if (i === undefined || !p.rig.active[i]) return null;
  // The joint in the reference bone's own space.
  const m = boneMatrix(p, i), R = refMatrix(p, parent), [x, y] = fromView(R, m[4] - R[4], m[5] - R[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4 };
}

/**
 * Pose the selected bone, unkeyed, so its joint is at (`x`, `y`) in the reference bone's space at the
 * playhead's frame: what dragging a node does to the bone, so the two stay together.
 */
export function poseAtNode(s: Session, x: number, y: number, parent: string | null): void {
  const bone = s.selectedBone, p = s.pose();
  if (!bone || !p) return;
  const i = p.bones.get(bone);
  if (i === undefined) return;
  // The node (the reference bone's space) to the world through the bone as it is now, then into the bone's own parent's space.
  const R = refMatrix(p, parent), P = parentMatrix(p, i), [vx, vy] = toView(R, x, y);
  const [lx, ly] = moveDelta(P, R[4] + vx - P[4], R[5] + vy - P[5]), l = p.local, k = i * 7;
  s.setUnkeyed(bone, { x: lx, y: ly, rotation: l[k + 2]!, scaleX: l[k + 3]!, scaleY: l[k + 4]!, shearX: l[k + 5]!, shearY: l[k + 6]! });
  // The Stage draws on a change: without it the bone moved in the pose but not on screen.
  s.changed();
}

/**
 * The local poses the paths of one animation give their bones at the path clock's time `t` (docs/TWO-SYSTEMS-PLAN.md, P): each path's own
 * time, its point through the reference bone as `p` has it (the pose of the key animation alone), then into the bone's own parent's space.
 * Only x and y are the path's; the bone's other values stay what `p` has. A bone with no pose in `p` is left out.
 */
export function pathDrive(doc: Skeleton | null | undefined, motion: readonly MotionPath[], animation: string, p: Posed, t: number): Map<string, LocalPose> {
  const out = new Map<string, LocalPose>();
  for (const m of motion) {
    const i = m.animation === animation ? p.bones.get(m.bone) : undefined;
    if (i === undefined) continue;
    const q = pathPose(m, pathTime(m, t)), R = refMatrix(p, refBoneName(doc, m)), P = parentMatrix(p, i), [vx, vy] = toView(R, q.x, q.y);
    const [lx, ly] = moveDelta(P, R[4] + vx - P[4], R[5] + vy - P[5]), l = p.local, k = i * 7;
    if ([lx, ly].every(Number.isFinite)) out.set(m.bone, { x: lx, y: ly, rotation: l[k + 2]!, scaleX: l[k + 3]!, scaleY: l[k + 4]!, shearX: l[k + 5]!, shearY: l[k + 6]! });
  }
  return out;
}

/** How many samples a segment's curve is fitted to. */
const FIT_SAMPLES = 12;

/**
 * The keys a path makes (docs/TWO-SYSTEMS-PLAN.md): one where the bone reaches each node (the frame the speed spline makes it,
 * rounded, kept apart) and one at the end of the run, then one more in the middle of any stretch where the fitted curve strays from
 * the bone's real motion by more than a little, down to stretches of two frames. Each stretch keeps the control values of its fit.
 * Returns the keys and how far their motion strays from the path at worst.
 */
export function keysFromPath(s: Session, m: MotionPath): { keys: PathKey[]; stray: number } {
  const poser = s.poserFor();
  if (!poser) throw new EditRefused("Nothing is open.");
  const fps = s.fps, curve = curveOf(m), ref = refBoneName(s.doc, m), end = Math.max(1, Math.round(m.duration * fps));
  const local = (frame: number): [number, number] => {
    const q = curve.at(progressAtTime(m, frame / fps) * curve.length), pose = poser.pose(s.skin, m.animation, Math.fround(frame / fps), "none"), i = pose.bones.get(m.bone);
    if (i === undefined) throw new EditRefused(`"${m.bone}" has no pose in this skin.`);
    // The path point is in the reference bone's space: through that bone as it is at this frame to the world, then into the bone's own parent's space.
    const R = refMatrix(pose, ref), P = parentMatrix(pose, i), [vx, vy] = toView(R, q.x, q.y);
    const [lx, ly] = moveDelta(P, R[4] + vx - P[4], R[5] + vy - P[5]);
    return [lx, ly];
  };
  // Where the bone reaches each node, as whole frames in order, from frame 0 to the end.
  const frames: number[] = [0];
  for (const t of arrivalTimes(m)) {
    const r = Math.round(t * fps);
    if (r > frames.at(-1)! && r < end) frames.push(r);
  }
  if (frames.at(-1)! !== end) frames.push(end);
  const tolerance = Math.max(0.1, curve.length * 0.002), fit = (f0: number, f1: number) => {
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k <= FIT_SAMPLES; k++) { const [px, py] = local(f0 + ((f1 - f0) * k) / FIT_SAMPLES); xs.push(px); ys.push(py); }
    const fx = fitChannel(xs), fy = fitChannel(ys);
    return { fx, fy, error: Math.hypot(fx.error, fy.error) };
  };
  // A stretch whose fit strays gets a key in the middle (a limited number of times over): the speed spline can bend the motion within it.
  const refined: number[] = [];
  const split = (f0: number, f1: number, depth: number): void => {
    refined.push(f0);
    if (f1 - f0 >= 2 && depth < 4 && fit(f0, f1).error > tolerance) { const mid = Math.round((f0 + f1) / 2); split(f0, mid, depth + 1); split(mid, f1, depth + 1); }
  };
  for (let i = 0; i + 1 < frames.length; i++) split(frames[i]!, frames[i + 1]!, 0);
  refined.push(end);
  const keys: PathKey[] = [];
  let stray = 0;
  for (let i = 0; i < refined.length; i++) {
    const f0 = refined[i]!, [x, y] = local(f0);
    if (i === refined.length - 1) { keys.push(m.closed ? { frame: f0, x: keys[0]!.x, y: keys[0]!.y } : { frame: f0, x, y }); break; }
    const { fx, fy, error } = fit(f0, refined[i + 1]!);
    stray = Math.max(stray, error);
    keys.push({ frame: f0, x, y, control: [fx.c1, fx.c2, fy.c1, fy.c2] });
  }
  return { keys, stray };
}

/**
 * Make keys from the path, once (docs/TWO-SYSTEMS-PLAN.md, Q3): write the bone's translate keys from the path as it is now, in one undo step.
 * A copy and nothing more: the path keeps no mark of it and does not know the keys again, so editing either leaves the other alone. Returns
 * how many keys were written and how far their motion strays from the path at worst.
 */
export function makeKeysFromPath(s: Session, m: MotionPath): { stray: number; keys: number } {
  const h = s.history, doc = s.doc;
  if (!h || !doc) throw new EditRefused("Nothing is open.");
  const { keys: made, stray } = keysFromPath(s, m), keys = translateKeys(setupXY(doc, m.bone), made, s.fps);
  h.begin(`Make keys from the path of ${m.bone}`);
  try { h.apply("", writeTranslateKeys(m.animation, m.bone, keys)); } finally { h.end(); }
  s.changed();
  return { stray, keys: keys.length };
}

/** Keep a path (a node, a leg, a speed, the duration changed): one undo step labelled `label`, and the steps of one label a moment apart (a typed field) are one. */
export function keepMotion(s: Session, m: MotionPath, label = `Edit the path of ${m.bone}`, join = false): void {
  const change = (): void => s.setSidecar(withMotion(s.sidecar, m.animation, m.bone, m));
  if (s.history) s.history.applyBeside(label, change, join); else change();
}

/** Start a path and delete its bone's translate keys in the animation, as one undo step (the "Delete" answer when a path is made on a bone that has keys). */
export function startMotionDeletingKeys(s: Session, m: MotionPath): void {
  const h = s.history;
  if (!h) { keepMotion(s, m); return; }
  h.begin(`Start a path for ${m.bone}, deleting its translate keys`);
  try {
    h.apply("", deleteTranslateKeys(m.animation, m.bone));
    s.setSidecar(withMotion(s.sidecar, m.animation, m.bone, m));
  } finally { h.end(); }
  s.changed();
}

/** Drop the path kept for a bone; its keys stay as they are. One undo step. */
export function dropMotion(s: Session, animation: string, bone: string): void {
  const change = (): void => s.setSidecar(withMotion(s.sidecar, animation, bone, null));
  if (s.history) s.history.applyBeside(`Remove the path of ${bone}`, change); else change();
}
