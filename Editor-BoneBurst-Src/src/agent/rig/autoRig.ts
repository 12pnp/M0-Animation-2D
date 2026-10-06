import { type MotionView, type Point, SIDES } from "./views";

/**
 * A whole rig from a character's joints (the AI's `auto_rig`; E5-PLAN step 5, lifted from v1's
 * `core/rig/autoRig.ts`, ours): the joints a model reads off a picture, in skeleton space (y up),
 * become bones named the way the motion library reads them, and each picture goes on the bone
 * that runs through it. Pure: numbers and names.
 */

export type Joints = Record<string, Point>;

/** A picture to rig (a slot showing a region), as get_rig lists it. */
export interface RigPicture {
  name: string;
  size: readonly [number, number];
  /** A pixel of the picture, and where that pixel is (skeleton space). */
  pivot: readonly [number, number];
  at: Point;
  rotation: number;
}

export interface PlannedBone { name: string; parent: string | null; from: Point; to: Point }

export interface AutoRigPlan {
  bones: PlannedBone[];
  /** Each picture's bone, and the pixel of the picture at the bone's joint. */
  attach: Array<{ picture: string; bone: string; pivot: [number, number] }>;
  /** Shins (and forearms when asked) that get two-bone IK. */
  ik: string[];
  notes: string[];
}

/** The joints auto_rig reads, per view. */
export function jointNames(view: MotionView): string[] {
  const limbs = ["shoulder", "elbow", "wrist", "hand", "hip", "knee", "ankle", "toe"];
  return ["pelvis", "chest", "neck", "head", ...SIDES[view].flatMap((s) => limbs.map((l) => `${l}.${s}`))];
}

const sub = (a: Point, b: Point): [number, number] => [a[0] - b[0], a[1] - b[1]];
const len = (v: readonly [number, number]) => Math.hypot(v[0], v[1]);

/** Where skeleton point `p` is in a picture's pixels. */
export function picturePixel(picture: RigPicture, p: Point): [number, number] {
  const r = (-picture.rotation * Math.PI) / 180;
  const [dx, dy] = sub(p, picture.at);
  const x = dx * Math.cos(r) - dy * Math.sin(r), y = dx * Math.sin(r) + dy * Math.cos(r);
  return [picture.pivot[0] + x, picture.pivot[1] - y];
}

/** How well a bone runs through a picture: the share of the bone inside the
 *  picture, less a little for passing off the picture's centre. Sampled
 *  between the bone's ends, not at them: a joint read off a picture often
 *  sits on the picture's edge, a hair outside. */
function fit(picture: RigPicture, b: PlannedBone): number {
  const [w, h] = picture.size;
  let inside = 0;
  const N = 9;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const [u, v] = picturePixel(picture, [b.from[0] + (b.to[0] - b.from[0]) * t, b.from[1] + (b.to[1] - b.from[1]) * t]);
    if (u >= 0 && v >= 0 && u <= w && v <= h) inside++;
  }
  if (inside === 0) return -Infinity;
  // The picture's centre in skeleton space, and its distance to the bone.
  const r = (picture.rotation * Math.PI) / 180, cx = w / 2 - picture.pivot[0], cy = picture.pivot[1] - h / 2;
  const c: Point = [picture.at[0] + cx * Math.cos(r) - cy * Math.sin(r), picture.at[1] + cx * Math.sin(r) + cy * Math.cos(r)];
  const d = sub(b.to, b.from), dd = d[0] * d[0] + d[1] * d[1];
  const t = Math.max(0, Math.min(1, ((c[0] - b.from[0]) * d[0] + (c[1] - b.from[1]) * d[1]) / dd));
  const off = len(sub(c, [b.from[0] + d[0] * t, b.from[1] + d[1] * t]));
  return inside / N - 0.25 * off / Math.hypot(w, h);
}

export function autoRigPlan(
  joints: Joints, pictures: readonly RigPicture[], view: MotionView,
  /** `taken`: names already in the skeleton (pictures named "torso" are
   *  common); a bone that would clash gets "_bone" after its name, which
   *  the motion library's role guess still reads. */
  opts: { armIk?: boolean; taken?: (name: string) => boolean } = {},
): AutoRigPlan | string {
  const known = new Set(jointNames(view));
  const stray = Object.keys(joints).find((k) => !known.has(k));
  if (stray) return `There is no joint "${stray}" in a ${view} view. Joints: ${[...known].join(", ")}.`;
  for (const [k, p] of Object.entries(joints)) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === "number" && Number.isFinite(v))) return `Joint "${k}" is two numbers, [x, y].`;
  }
  const { pelvis, neck } = joints;
  if (!pelvis || !neck) return "auto_rig needs at least pelvis and neck.";
  if (len(sub(neck, pelvis)) < 1) return "pelvis and neck are the same point.";
  const notes: string[] = [];
  const bones: PlannedBone[] = [];
  const named = new Map<string, string>();
  const taken = (n: string) => !!opts.taken?.(n) || pictures.some((l) => l.name === n);
  const nameOf = (base: string) => named.get(base) ?? base;
  const add = (base: string, parentBase: string | null, from: Point, to: Point) => {
    if (len(sub(to, from)) < 1) { notes.push(`${base} has no length: left out, and what hangs from it.`); return false; }
    let name = base;
    for (let i = 1; taken(name); i++) name = i === 1 ? `${base}_bone` : `${base}_bone${i}`;
    named.set(base, name);
    bones.push({ name, parent: parentBase === null ? null : nameOf(parentBase), from, to });
    return true;
  };
  const spine = sub(neck, pelvis), spineLength = len(spine);
  const up: [number, number] = [spine[0] / spineLength, spine[1] / spineLength];
  // With a chest joint the spine is two bones, pelvis to chest and chest
  // to neck, for a pelvis and a torso drawn apart; without one the hips
  // bone is a short stub and the torso runs from the pelvis.
  const chest = joints.chest;
  add("hips", null, pelvis, chest ?? [pelvis[0] + up[0] * spineLength * 0.2, pelvis[1] + up[1] * spineLength * 0.2]);
  add("torso", "hips", chest ?? pelvis, neck);
  add("head", "torso", neck, joints.head ?? [neck[0] + up[0] * spineLength * 0.45, neck[1] + up[1] * spineLength * 0.45]);
  if (!joints.head) notes.push("No head point: the head bone is a guess along the spine.");

  const ik: string[] = [];
  for (const side of SIDES[view]) {
    // A chain stops at its first missing joint.
    const chain = (parent: string, start: Point | undefined, parts: Array<[string, string]>): string[] => {
      const made: string[] = [];
      let from = start, up2 = parent;
      for (const [bone, joint] of parts) {
        const to = joints[`${joint}.${side}`];
        if (!from || !to) break;
        if (!add(`${bone}_${side}`, up2, from, to)) break;
        made.push(`${bone}_${side}`);
        from = to; up2 = `${bone}_${side}`;
      }
      return made;
    };
    const leg = chain("hips", joints[`hip.${side}`] ?? pelvis, [["thigh", "knee"], ["shin", "ankle"], ["foot", "toe"]]);
    if (leg.includes(`shin_${side}`)) ik.push(nameOf(`shin_${side}`));
    const arm = chain("torso", joints[`shoulder.${side}`], [["upper_arm", "elbow"], ["forearm", "wrist"], ["hand", "hand"]]);
    if (opts.armIk && arm.includes(`forearm_${side}`)) ik.push(nameOf(`forearm_${side}`));
    if (joints[`elbow.${side}`] && !joints[`shoulder.${side}`]) notes.push(`No shoulder.${side}: that arm has no bones.`);
  }

  // One picture per bone first, best fits first: an arm drawn over the
  // spine fits the torso bone too, but the body picture fits it better.
  // Pictures left over (a part in two pictures) go to their best bone.
  // A limb drawn in one piece (an arm, a leg) goes on the limb's first bone, so the whole picture
  // turns from the shoulder or hip: a small edge to a thigh or upper arm whose child fits it too.
  const limbRoot = (b: PlannedBone) => /^(thigh|upper_arm)_/.test(b.name);
  const childFits = (l: RigPicture, b: PlannedBone) => limbRoot(b) && bones.some((c) => c.parent === b.name && fit(l, c) >= 0.5);
  const pairs = pictures.flatMap((l) => bones.map((b) => ({ l, b, score: fit(l, b) + (childFits(l, b) ? 0.05 : 0) }))).filter((p) => p.score > -Infinity)
    .sort((x, y) => y.score - x.score);
  const chosen = new Map<RigPicture, PlannedBone>();
  const used = new Set<PlannedBone>();
  for (const p of pairs) if (!chosen.has(p.l) && !used.has(p.b)) { chosen.set(p.l, p.b); used.add(p.b); }
  for (const p of pairs) if (!chosen.has(p.l)) chosen.set(p.l, p.b);
  const attach: AutoRigPlan["attach"] = [];
  for (const picture of pictures) {
    const best = chosen.get(picture);
    if (!best) { notes.push(`"${picture.name}" is not on any bone: no bone passes through it.`); continue; }
    // Under half the bone inside: a part with no bones of its own (a limb
    // whose joints were not given) hung on whatever passes near it.
    if (fit(picture, best) < 0.5) notes.push(`"${picture.name}" fits "${best.name}" poorly: check it; a part whose joints were not given has no bone of its own.`);
    const first = attach.find((x) => x.bone === best.name);
    if (first) notes.push(`"${picture.name}" shares "${best.name}" with "${first.picture}": right for one part drawn in two pictures; otherwise give the joints of the part it shows.`);
    const pivot = picturePixel(picture, best.from);
    attach.push({ picture: picture.name, bone: best.name, pivot: [Math.round(pivot[0] * 100) / 100, Math.round(pivot[1] * 100) / 100] });
  }
  return { bones, attach, ik, notes };
}

