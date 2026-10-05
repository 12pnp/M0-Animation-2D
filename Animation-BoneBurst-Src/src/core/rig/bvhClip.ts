import type { MotionClip, MotionView } from "./motion";
import { type Bvh, type Positions, positionsAt, type Vec3 } from "./bvh";

/**
 * A BVH take as a library clip (`motion.ts`), side or front view: the motion
 * of AnimatedDrawings' example BVHs, or any take with the joint names of
 * `SKELETONS`, becomes something `apply_motion` retargets onto any rig.
 *
 * Each frame is looked at from where the character faces at that frame: its
 * left is the shoulder and hip lines, its forward that left turned about up.
 * A side clip faces right, so the character's right side is the near one; a
 * front clip faces the viewer, so its right side is screen left. Limbs and the
 * torso are the world angles of their segments in that view; feet, hands and
 * the head (delta roles) are their limb's turn from its rest angle plus their
 * own bend from the take's first frame. The clip stays in place: the hips only
 * rise by how far the lowest foot leaves the take's ground (`grounded` puts
 * the feet down first).
 */

/** Each role's segment, `[from, to]`: joint names, or a joint name + "/end" for its End Site. */
type Segments = Record<string, [string, string]>;

/** `<side>` is "Left" or "Right" in the joint names. */
interface Skeleton {
  /** Recognised by having this joint. */
  has: string;
  limbs: Record<string, [string, string]>;
  torso: [string, string];
  head: [string, string];
  /** Joint pairs, left then right, whose lines give the character's left. */
  across: Array<[string, string]>;
}

const SKELETONS: Skeleton[] = [
  {
    // Mixamo-style names: FAIR's and Rokoko's takes in AnimatedDrawings.
    has: "RightUpLeg",
    limbs: {
      thigh: ["<side>UpLeg", "<side>Leg"], shin: ["<side>Leg", "<side>Foot"], foot: ["<side>Foot", "<side>ToeBase"],
      upperArm: ["<side>Arm", "<side>ForeArm"], forearm: ["<side>ForeArm", "<side>Hand"], hand: ["<side>Hand", "<side>Hand/tip"],
    },
    torso: ["Hips", "Neck"], head: ["Neck", "Head/end"],
    across: [["LeftArm", "RightArm"], ["LeftUpLeg", "RightUpLeg"]],
  },
  {
    // CMU's names.
    has: "RightKnee",
    limbs: {
      thigh: ["<side>Hip", "<side>Knee"], shin: ["<side>Knee", "<side>Ankle"], foot: ["<side>Ankle", "<side>Toe"],
      upperArm: ["<side>Shoulder", "<side>Elbow"], forearm: ["<side>Elbow", "<side>Wrist"], hand: ["<side>Wrist", "<side>Wrist/tip"],
    },
    torso: ["Hips", "Neck"], head: ["Neck", "Head/end"],
    across: [["LeftShoulder", "RightShoulder"], ["LeftHip", "RightHip"]],
  },
];

export interface BvhClipOptions {
  name: string;
  description: string;
  view: MotionView;
  /** The take's up axis, as AnimatedDrawings' motion configs give it. */
  up: "+x" | "+y" | "+z" | "-x" | "-y" | "-z";
  /** The take's frames to use, end excluded (default: all). */
  start?: number;
  end?: number;
  /** The clip's rate (default 24) and a key every `step` frames (default 2). */
  fps?: number;
  step?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const r2 = (v: number) => Math.round(v * 100) / 100 + 0;

function upVector(up: BvhClipOptions["up"]): Vec3 {
  const s = up[0] === "-" ? -1 : 1, axis = up[1]!;
  return axis === "x" ? [s, 0, 0] : axis === "y" ? [0, s, 0] : [0, 0, s];
}

/** The skeleton `bvh`'s joint names follow, or an error naming what is missing. */
function skeletonOf(bvh: Bvh): Skeleton {
  const names = new Set(bvh.joints.map((j) => j.name));
  const s = SKELETONS.find((k) => names.has(k.has));
  if (!s) throw new Error(`BVH joints not recognised (${[...names].slice(0, 8).join(", ")}, …): expected Mixamo-style (RightUpLeg) or CMU (RightKnee) names`);
  return s;
}

/** A point of the take at one frame: a joint, its End Site ("/end"), or its first child ("/tip"). */
function pointOf(bvh: Bvh, at: Positions, ref: string): Vec3 {
  const [name, kind] = ref.split("/") as [string, string | undefined];
  const i = bvh.joints.findIndex((j) => j.name === name);
  if (i < 0) throw new Error(`BVH has no joint "${name}"`);
  if (kind === "end") return at.ends[i] ?? at.joints[i]!;
  if (kind === "tip") {
    const child = bvh.joints.findIndex((j) => j.parent === i);
    return child >= 0 ? at.joints[child]! : at.ends[i] ?? at.joints[i]!;
  }
  return at.joints[i]!;
}

export function bvhClip(bvh: Bvh, o: BvhClipOptions): MotionClip {
  const sk = skeletonOf(bvh);
  const up = upVector(o.up);
  const fps = o.fps ?? 24, step = o.step ?? 2;
  const start = o.start ?? 0, end = Math.min(o.end ?? bvh.frames.length, bvh.frames.length);
  const duration = (end - 1 - start) * bvh.frameTime;
  const frames = Math.max(1, Math.round(duration * fps));

  // Roles → segments, with the sides named as the view sees them.
  const sides: Array<[string, "Left" | "Right"]> = o.view === "side" ? [["near", "Right"], ["far", "Left"]] : [["left", "Right"], ["right", "Left"]];
  const segments: Segments = { torso: sk.torso, head: sk.head };
  for (const [role, [a, b]] of Object.entries(sk.limbs)) {
    for (const [side, name] of sides) segments[`${role}.${side}`] = [a.replace("<side>", name), b.replace("<side>", name)];
  }
  const parentRole: Record<string, string> = { foot: "shin", hand: "forearm", head: "torso" };

  /** One take frame seen from the character's facing: each role's world angle, the lowest foot, the hips. */
  const look = (f: number) => {
    const at = positionsAt(bvh, f);
    let left: Vec3 = [0, 0, 0];
    for (const [l, r] of sk.across) left = [...left.map((v, k) => v + sub(pointOf(bvh, at, l), pointOf(bvh, at, r))[k]!)] as Vec3;
    left = norm(sub(left, up.map((u) => u * dot(left, up)) as Vec3));
    const forward = cross(left, up);
    // Screen x: forward (side view) or the character's left (front view, screen right).
    const across = o.view === "side" ? forward : left;
    const angle = (seg: [string, string]) => {
      const d = sub(pointOf(bvh, at, seg[1]), pointOf(bvh, at, seg[0]));
      return (Math.atan2(dot(d, up), dot(d, across)) * 180) / Math.PI;
    };
    const angles: Record<string, number> = {};
    for (const [role, seg] of Object.entries(segments)) angles[role] = angle(seg);
    const feet = sides.map(([, name]) => dot(pointOf(bvh, at, sk.limbs.foot![1].replace("<side>", name)), up));
    return { angles, lowestFoot: Math.min(...feet), at };
  };

  const first = look(start);
  // A leg's length, for the hips' lift in leg lengths.
  const legLength = (() => {
    const [h, k] = sk.limbs.thigh!, [, a] = sk.limbs.shin!;
    const p = (n: string) => pointOf(bvh, first.at, n.replace("<side>", "Right"));
    return Math.hypot(...sub(p(k), p(h))) + Math.hypot(...sub(p(a), p(k))) || 1;
  })();

  const samples: Array<{ frame: number; angles: Record<string, number>; lowestFoot: number }> = [];
  for (let f = 0; f <= frames; f += 1) {
    const take = Math.min(end - 1, start + Math.round((f / fps) / bvh.frameTime));
    const l = look(take);
    samples.push({ frame: f, angles: l.angles, lowestFoot: l.lowestFoot });
  }
  const ground = Math.min(...samples.map((s) => s.lowestFoot));

  const angles: MotionClip["angles"] = {};
  for (const role of Object.keys(segments)) {
    const [limb] = role.split(".");
    const parent = parentRole[limb!] ? (limb === "head" ? "torso" : `${parentRole[limb!]}.${role.split(".")[1]}`) : null;
    const keys: Array<[number, number]> = [];
    let prev: number | null = null;
    for (const s of samples) {
      if (s.frame % step !== 0 && s.frame !== frames) continue;
      let v: number;
      if (parent) {
        // Delta: the parent's turn from its rest angle, plus this segment's bend from the first frame.
        const bend = s.angles[role]! - s.angles[parent]!, bend0 = first.angles[role]! - first.angles[parent]!;
        v = (s.angles[parent]! - (limb === "head" ? 90 : -90)) + (bend - bend0);
      } else v = s.angles[role]!;
      // Unwrapped, so keys interpolate the short way.
      if (prev !== null) v = prev + ((((v - prev) % 360) + 540) % 360) - 180;
      prev = v;
      keys.push([s.frame, r2(v)]);
    }
    angles[role] = keys;
  }

  const hips: Array<[number, number, number]> = samples
    .filter((s) => s.frame % step === 0 || s.frame === frames)
    .map((s) => [s.frame, 0, r2((s.lowestFoot - ground) / legLength)]);

  return { name: o.name, description: o.description, view: o.view, fps, frames, loop: false, grounded: true, angles, hips };
}
