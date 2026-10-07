import { type BakedKey, bakeTranslate, curveOf, DEFAULT_FRAMES, fitChannel, keyFrames, keysSignature, pathSignature, progressAtFrame, setupXY, translateKeys } from "@/edit/motionPath";
import { motionOf, withMotion } from "@/edit/sidecar";
import { EditRefused } from "@/edit/history";
import type { MotionNode, MotionPath } from "@/model/sidecar";
import { keysAt } from "@/model/timelines";
import type { Session } from "./session";
import { moveDelta } from "./stage/gizmo";
import { boneMatrix, parentMatrix } from "./stage/posed";
import { fromParent } from "./stage/trail";

/**
 * A bone's motion path in the open project (docs/PATH-SPEED-PLAN.md): finding it, making the first
 * one from the motion the bone has now, and baking its keys. The curve, the timing and the key
 * edit are pure (`edit/motionPath.ts`); this is where the rig is posed to turn the path's points,
 * which are in the Motion Path panel's Local space, into the bone's local x and y.
 */

/** The path kept for the selected bone in the animation shown, or undefined. */
export function motionFor(s: Session): MotionPath | undefined {
  const a = s.animation, bone = s.selectedBone;
  return a && bone ? motionOf(s.sidecar, a.name, bone) : undefined;
}

/** Whether the path's own settings (nodes, node times, frames, multipliers) differ from what the last bake to the timeline was made from. */
export function motionChanged(m: MotionPath): boolean {
  return m.baked !== undefined && m.baked.split("|")[1] !== pathSignature(m);
}

/** Whether the bone's translate keys differ from what the last bake wrote: they were edited since. */
export function motionStale(s: Session, m: MotionPath): boolean {
  if (m.baked === undefined) return false;
  const a = s.doc?.animations?.find((x) => x.name === m.animation);
  const keys = a ? keysAt(a, { section: "bones", owner: m.bone, timeline: "translate" }) ?? [] : [];
  return keysSignature(keys) !== m.baked.split("|")[0];
}

/**
 * A new path for the selected bone (docs/PATH-FRAMES-PLAN.md): a ring through two nodes, the bone's place
 * now and that place plus an offset (the length of the bone, along x), 15 frames (14 + 0) and the two node
 * times it is cut at once it is baked: frame 0 and the middle. Null when there is no animation, bone or pose.
 */
export function startMotion(s: Session): MotionPath | null {
  const a = s.animation, bone = s.selectedBone, here = currentNode(s), p = s.pose();
  if (!a || !bone || !here || !p) return null;
  const i = p.bones.get(bone)!, length = Math.max(20, p.rig.data.bones[i]!.length);
  return { animation: a.name, bone, nodes: [here, { x: here.x + length, y: here.y }], closed: true, frames: DEFAULT_FRAMES, starts: [Math.round(DEFAULT_FRAMES / 2)], speeds: [] };
}

/** A node after `last`: its place plus the same offset the first two have (a bone length along x). */
export function nodeAfter(s: Session, last: MotionNode): MotionNode {
  const bone = s.selectedBone, p = s.pose(), i = bone && p ? p.bones.get(bone) : undefined;
  const length = Math.max(20, i !== undefined ? p!.rig.data.bones[i]!.length : 20);
  return { x: last.x + length, y: last.y };
}

/**
 * The selected bone's joint as it is posed now (an unkeyed pose the artist dragged to included), in the
 * panel's Local space: what a red button stores. Null when the bone has no pose.
 */
export function currentNode(s: Session): MotionNode | null {
  const bone = s.selectedBone, p = s.pose();
  if (!bone || !p) return null;
  const i = p.bones.get(bone);
  if (i === undefined || !p.rig.active[i]) return null;
  const m = boneMatrix(p, i), [x, y] = fromParent(p, i, m[4], m[5]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4 };
}

/**
 * Pose the selected bone, unkeyed, so its joint is at (`x`, `y`) in the panel's Local space at the
 * playhead's frame: what dragging a node does to the bone, so the two stay together.
 */
export function poseAtNode(s: Session, x: number, y: number): void {
  const bone = s.selectedBone, p = s.pose();
  if (!bone || !p) return;
  const i = p.bones.get(bone);
  if (i === undefined) return;
  const [lx, ly] = moveDelta(parentMatrix(p, i), x, y), l = p.local, k = i * 7;
  s.setUnkeyed(bone, { x: lx, y: ly, rotation: l[k + 2]!, scaleX: l[k + 3]!, scaleY: l[k + 4]!, shearX: l[k + 5]!, shearY: l[k + 6]! });
  // The Stage draws on a change: without it the bone moved in the pose but not on screen.
  s.changed();
}

/** How many samples a segment's curve is fitted to. */
const FIT_SAMPLES = 12;

/**
 * The keys a bake to the timeline writes, with how far the baked motion strays from the path at worst (units): one
 * for each node time and one at the end of the run (on a ring the closing key, a copy of the first); each key's
 * curve to the next is fitted to the bone's local x and y over the block, sampled in the rig as it is posed then
 * (so a moving parent is in them).
 */
export function bakeKeys(s: Session, m: MotionPath): { keys: BakedKey[]; stray: number } {
  const poser = s.poserFor();
  if (!poser) throw new EditRefused("Nothing is open.");
  const fps = s.fps, curve = curveOf(m), frames = keyFrames(m);
  const local = (frame: number): [number, number] => {
    const q = curve.at(progressAtFrame(m, frame) * curve.length), pose = poser.pose(s.skin, m.animation, Math.fround(frame / fps), "none"), i = pose.bones.get(m.bone);
    if (i === undefined) throw new EditRefused(`"${m.bone}" has no pose in this skin.`);
    const [lx, ly] = moveDelta(parentMatrix(pose, i), q.x, q.y);
    return [lx, ly];
  };
  const keys: BakedKey[] = [];
  let stray = 0;
  for (let i = 0; i < frames.length; i++) {
    const f0 = frames[i]!, [x, y] = local(f0);
    if (i === frames.length - 1) { keys.push(m.closed ? { frame: f0, x: keys[0]!.x, y: keys[0]!.y } : { frame: f0, x, y }); break; }
    const f1 = frames[i + 1]!, xs: number[] = [], ys: number[] = [];
    for (let k = 0; k <= FIT_SAMPLES; k++) { const [px, py] = local(f0 + ((f1 - f0) * k) / FIT_SAMPLES); xs.push(px); ys.push(py); }
    const fx = fitChannel(xs), fy = fitChannel(ys);
    stray = Math.max(stray, Math.hypot(fx.error, fy.error));
    keys.push({ frame: f0, x, y, control: [fx.c1, fx.c2, fy.c1, fy.c2] });
  }
  return { keys, stray };
}

/**
 * Bake to the timeline: write the path's keys into the bone's translate timeline (one undo step), and keep the
 * path with a signature of those keys. Returns the path kept and how far the baked motion strays from it.
 */
export function bakeMotion(s: Session, m: MotionPath): { path: MotionPath; stray: number } {
  const h = s.history, doc = s.doc;
  if (!h || !doc) throw new EditRefused("Nothing is open.");
  const { keys: baked, stray } = bakeKeys(s, m), keys = translateKeys(setupXY(doc, m.bone), baked, s.fps);
  h.apply(`Bake the path of ${m.bone} to the timeline`, bakeTranslate(m.animation, m.bone, keys));
  const path = { ...m, baked: `${keysSignature(keys)}|${pathSignature(m)}` };
  s.setSidecar(withMotion(s.sidecar, m.animation, m.bone, path));
  s.changed();
  return { path, stray };
}

/** Keep a path (nodes, node times, frames or a multiplier changed) without baking. */
export function keepMotion(s: Session, m: MotionPath): void {
  s.setSidecar(withMotion(s.sidecar, m.animation, m.bone, m));
}

/** Drop the path kept for a bone; its keys stay as they are. */
export function dropMotion(s: Session, animation: string, bone: string): void {
  s.setSidecar(withMotion(s.sidecar, animation, bone, null));
}
