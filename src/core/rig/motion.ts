import { apply, invert, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { matrixOf } from "@/core/math/Transform";
import { fromSpineLocal, type SpineLocal } from "@/core/spine/transform";

/**
 * Motion clips and retargeting them onto a rig (the AI's `apply_motion`).
 *
 * A clip is authored for a character facing right, in Spine's conventions
 * (y up, degrees counter-clockwise), per body ROLE rather than per bone.
 * Limbs and the torso are WORLD angles — where the limb points — so a rig
 * standing in any setup pose takes the same motion; the hips, head, hands
 * and feet are offsets from the rig's own setup angle, so a head drawn
 * tilted stays tilted. The retarget poses the rig frame by frame, as the
 * runtime would compose it, and returns `set_keys` values.
 */

export type MotionView = "side" | "front";

export interface MotionClip {
  name: string;
  description: string;
  view: MotionView;
  fps: number;
  /** Length in frames; a looping clip's last frame is the same pose as 0. */
  frames: number;
  loop: boolean;
  /** Feet stay on the ground: the hips go up and down so the lowest foot
   *  touches where the feet stand in the setup pose. */
  grounded: boolean;
  /** Per role, [frame, degrees] in frame order: world angles for "world"
   *  roles, offsets from the rest angle for "delta" roles (`ROLES`). */
  angles: Record<string, Array<[number, number]>>;
  /** The hips' offset in leg lengths, [frame, x, y]: forward and up. With
   *  `grounded`, y is added after the feet are put on the ground. */
  hips?: Array<[number, number, number]>;
}

/** `rest`: the role's angle standing, facing right — what a "world" clip
 *  key reads against, and what a "delta" key of 0 means. */
type RoleRule = { rest: number; mode: "world" | "delta" };

const LIMBS: Record<string, RoleRule> = {
  thigh: { rest: -90, mode: "world" },
  shin: { rest: -90, mode: "world" },
  foot: { rest: 0, mode: "delta" },
  upperArm: { rest: -90, mode: "world" },
  forearm: { rest: -90, mode: "world" },
  hand: { rest: -90, mode: "delta" },
};
export const SIDES: Record<MotionView, readonly [string, string]> = { side: ["near", "far"], front: ["left", "right"] };

/** Every role a clip may key, and how its angles read. */
export const ROLES: Record<string, RoleRule> = {
  hips: { rest: 90, mode: "delta" },
  torso: { rest: 90, mode: "world" },
  head: { rest: 90, mode: "delta" },
  ...Object.fromEntries(Object.entries(LIMBS).flatMap(([limb, rule]) =>
    ["near", "far", "left", "right"].map((side) => [`${limb}.${side}`, rule]))),
};

/** A bone of the rig, as the retarget needs it. */
export interface RigBone {
  name: string;
  parent: string | null;
  /** Its setup pose, local to the parent. */
  local: SpineLocal;
  length: number;
  /** Where the runtime poses it in the setup pose, in skeleton space. */
  setup: { x: number; y: number; rotation: number; scaleX: number };
}

/** An IK constraint: its chain (root first) and its target. `bend`: which
 *  way the solver bends a two-bone chain, the sign of the turn from the root
 *  to the effector in skeleton space; absent when the setup pose is too
 *  straight to tell. */
export interface RigIk { bones: string[]; target: string; bend?: 1 | -1 }

export interface RetargetRequest {
  clip: MotionClip;
  bones: RigBone[];
  ik: RigIk[];
  /** Role → bone name. Roles left out are not animated. */
  map: Record<string, string>;
  facing?: "right" | "left";
  /** The new animation's length in frames (default: the clip's). */
  frames?: number;
}

export interface MotionKey { bone: string; frame: number; rotation?: number; x?: number; y?: number }

export interface RetargetResult {
  keys: MotionKey[];
  /** Where each animated bone is at each keyed frame, in skeleton space, as
   *  the retarget posed it: what the runtime should show, IK included. */
  expected: Array<{ frame: number; bones: Record<string, { x: number; y: number; rotation: number }>; feet?: number }>;
  /** Where the feet stand (skeleton y), when the clip keeps them there. */
  ground?: number;
  notes: string[];
}

const DEG = Math.PI / 180;
const wrap180 = (a: number) => a - 360 * Math.round(a / 360);

/** The clip's value for `role` at `frame`, linear between keys. */
export function sampleRole(keys: ReadonlyArray<readonly [number, number]>, frame: number): number {
  if (frame <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1] = keys[i]!;
    if (frame <= f1) {
      const [f0, v0] = keys[i - 1]!;
      return v0 + (v1 - v0) * ((frame - f0) / (f1 - f0));
    }
  }
  return keys[keys.length - 1]![1];
}

function sampleHips(keys: ReadonlyArray<readonly [number, number, number]>, frame: number): [number, number] {
  return [sampleRole(keys.map((k) => [k[0], k[1]] as const), frame), sampleRole(keys.map((k) => [k[0], k[2]] as const), frame)];
}

/** World angle (Spine, y up) of an editor world matrix's x axis. */
const angleOf = (m: Matrix2D) => Math.atan2(-m.b, m.a) / DEG;

/**
 * The local rotation that points a bone's x axis at world angle `theta`
 * under a parent with world matrix `parent` (editor, y down), nearest to
 * `near` so a tween never takes the long way round.
 */
export function localRotationFor(parent: Matrix2D | undefined, theta: number, near: number): number {
  let dx = Math.cos(theta * DEG), dy = -Math.sin(theta * DEG);
  if (parent) {
    const inverse = mat();
    if (invert(inverse, parent)) {
      const x = inverse.a * dx + inverse.c * dy, y = inverse.b * dx + inverse.d * dy;
      dx = x; dy = y;
    }
  }
  const r = -Math.atan2(dy, dx) / DEG;
  return near + wrap180(r - near);
}

/** A point in skeleton space (y up) in a parent's local space, Spine's way. */
function localPoint(parent: Matrix2D | undefined, x: number, y: number): [number, number] {
  if (!parent) return [x, y];
  const inverse = mat();
  if (!invert(inverse, parent)) return [x, y];
  const p = apply({ x: 0, y: 0 }, inverse, x, -y);
  return [p.x, -p.y];
}

export function retarget(req: RetargetRequest): RetargetResult {
  const { clip } = req;
  const notes: string[] = [];
  const left = req.facing === "left";
  const byName = new Map(req.bones.map((b) => [b.name, b]));
  const roleOf = new Map<string, string>();
  for (const [role, bone] of Object.entries(req.map)) {
    if (!ROLES[role]) throw new Error(`There is no role "${role}". Roles: ${Object.keys(ROLES).join(", ")}.`);
    if (!byName.has(bone)) throw new Error(`There is no bone "${bone}" (for ${role}).`);
    if (roleOf.has(bone)) throw new Error(`"${bone}" is mapped twice (${roleOf.get(bone)} and ${role}).`);
    roleOf.set(bone, role);
  }
  for (const role of Object.keys(clip.angles)) if (!req.map[role]) notes.push(`${role} is not mapped; it keeps its setup pose.`);

  // Parents before children.
  const order: RigBone[] = [];
  const placed = new Set<string>();
  const visit = (b: RigBone, seen: Set<string>) => {
    if (placed.has(b.name) || seen.has(b.name)) return;
    seen.add(b.name);
    const parent = b.parent ? byName.get(b.parent) : undefined;
    if (parent) visit(parent, seen);
    placed.add(b.name);
    order.push(b);
  };
  for (const b of req.bones) visit(b, new Set());

  const sides = SIDES[clip.view];
  const legBone = (limb: string) => req.map[`${limb}.${sides[0]}`] ?? req.map[`${limb}.${sides[1]}`];
  const thigh = legBone("thigh"), shin = legBone("shin");
  let legLength = 100;
  if (thigh && shin) legLength = byName.get(thigh)!.length * byName.get(thigh)!.setup.scaleX + byName.get(shin)!.length * byName.get(shin)!.setup.scaleX;
  else notes.push("No thigh and shin are mapped: the hips move by a leg length of 100.");

  // The points a foot stands on: a foot bone's ends, or the shin's tip.
  const feet: Array<{ bone: string; ends: number[] }> = [];
  for (const side of sides) {
    const foot = req.map[`foot.${side}`], s = req.map[`shin.${side}`];
    if (foot) feet.push({ bone: foot, ends: [0, byName.get(foot)!.length] });
    else if (s) feet.push({ bone: s, ends: [byName.get(s)!.length] });
  }
  const setupPoint = (bone: string, along: number) => {
    const s = byName.get(bone)!.setup;
    return s.y + Math.sin(s.rotation * DEG) * along * s.scaleX;
  };
  const ground = feet.length ? Math.min(...feet.flatMap((f) => f.ends.map((e) => setupPoint(f.bone, e)))) : undefined;
  const hipsBone = req.map.hips;
  let lockFeet = clip.grounded && ground !== undefined && !!hipsBone;
  if (clip.grounded && !lockFeet) notes.push("The feet are not kept on the ground: map hips and the legs for that.");
  if (lockFeet) {
    const under = (name: string): boolean => { for (let b: string | null = name; b; b = byName.get(b)?.parent ?? null) if (b === hipsBone) return true; return false; };
    if (!feet.every((f) => under(f.bone))) { lockFeet = false; notes.push("The legs do not hang from the hips: the feet are not kept on the ground."); }
  }

  // IK: chains whose bones are all animated get their target keyed at the
  // effector's tip instead; the bones the solver turns are never keyed.
  const solved: Array<{ chain: string[]; target: string; bend?: 1 | -1 }> = [];
  for (const k of req.ik) {
    if (!k.bones.every((b) => roleOf.has(b))) continue;
    const target = byName.get(k.target);
    let inside = false;
    for (let b = target?.parent ?? null; b; b = byName.get(b)?.parent ?? null) if (k.bones.includes(b)) inside = true;
    if (!target || inside) { notes.push(`The IK on ${k.bones.join(", ")} is left as it is.`); continue; }
    if (roleOf.has(k.target)) { notes.push(`"${k.target}" is both an IK target and mapped; the IK on ${k.bones.join(", ")} is left as it is.`); continue; }
    solved.push({ chain: k.bones, target: k.target, ...(k.bend ? { bend: k.bend } : {}) });
  }
  const chainBones = new Set(solved.flatMap((s) => s.chain));
  // A clip bending a joint against the solver: the runtime bends it the
  // rig's way whatever the target says, so the pose mirrors the joint
  // across the line from the root to the tip, keeping the tip.
  const flips = new Map(solved.filter((s) => s.chain.length === 2 && s.bend).map((s) => [s.chain[1]!, s]));
  const flipped = new Set<string>();

  // Every frame is keyed: between sparse keys the hips and a foot target
  // would each move in a straight line, and a planted leg would come short.
  const length = req.frames ?? clip.frames;
  const frames = new Map<number, number>();
  for (let f = 0; f <= length; f++) frames.set(f, (f * clip.frames) / length);

  const keys: MotionKey[] = [];
  const expected: RetargetResult["expected"] = [];
  const last = new Map<string, number>(req.bones.map((b) => [b.name, b.local.rotation]));
  const mirror = (theta: number) => (left ? 180 - theta : theta);

  for (const [outFrame, src] of frames) {
    const local = new Map(req.bones.map((b) => [b.name, { ...b.local }]));
    const world = new Map<string, Matrix2D>();
    const pose = (hipsLift: number) => {
      world.clear();
      for (const b of order) {
        const parent = b.parent ? world.get(b.parent) : undefined;
        const l = local.get(b.name)!;
        const role = roleOf.get(b.name);
        if (role && clip.angles[role]) {
          const rule = ROLES[role]!;
          const v = sampleRole(clip.angles[role]!, src);
          const theta = rule.mode === "world" ? mirror(v) : b.setup.rotation + (left ? -v : v);
          l.rotation = localRotationFor(parent, theta, last.get(b.name)!);
        }
        if (b.name === hipsBone) {
          const [ox, oy] = clip.hips ? sampleHips(clip.hips, src) : [0, 0];
          const p = localPoint(parent, b.setup.x + (left ? -ox : ox) * legLength, b.setup.y + oy * legLength + hipsLift);
          l.x = p[0]; l.y = p[1];
        }
        const m = matrixOf(fromSpineLocal(l));
        world.set(b.name, parent ? mul(mat(), parent, m) : m);
        const chain = flips.get(b.name);
        if (chain) unbend(chain.chain[0]!, b, chain.bend!);
      }
    };
    const unbend = (rootName: string, effector: RigBone, bend: 1 | -1) => {
      const root = byName.get(rootName)!, rootWorld = world.get(rootName)!, effWorld = world.get(effector.name)!;
      if (Math.sign(Math.sin((angleOf(effWorld) - angleOf(rootWorld)) * DEG)) !== -bend) return;
      // Skeleton space, y up.
      const a = { x: rootWorld.tx, y: -rootWorld.ty }, k = { x: effWorld.tx, y: -effWorld.ty };
      const t0 = apply({ x: 0, y: 0 }, effWorld, effector.length, 0), t = { x: t0.x, y: -t0.y };
      const ux = t.x - a.x, uy = t.y - a.y, uu = ux * ux + uy * uy;
      if (uu < 1e-12) return;
      const along = ((k.x - a.x) * ux + (k.y - a.y) * uy) / uu;
      const kx = 2 * (a.x + along * ux) - k.x, ky = 2 * (a.y + along * uy) - k.y;
      const rootParent = root.parent ? world.get(root.parent) : undefined;
      const rl = local.get(rootName)!;
      rl.rotation = localRotationFor(rootParent, Math.atan2(ky - a.y, kx - a.x) / DEG, rl.rotation);
      const rm = matrixOf(fromSpineLocal(rl));
      world.set(rootName, rootParent ? mul(mat(), rootParent, rm) : rm);
      const el = local.get(effector.name)!;
      // The effector hangs at the joint: its local x, y are unchanged.
      el.rotation = localRotationFor(world.get(rootName), Math.atan2(t.y - ky, t.x - kx) / DEG, el.rotation);
      world.set(effector.name, mul(mat(), world.get(rootName)!, matrixOf(fromSpineLocal(el))));
      flipped.add(rootName);
    };
    const lowest = () => Math.min(...feet.flatMap((f) => f.ends.map((e) => -apply({ x: 0, y: 0 }, world.get(f.bone)!, e, 0).y)));
    pose(0);
    if (lockFeet) {
      // Clip y is the lift above standing: stand first, then add it.
      const lift = clip.hips ? sampleHips(clip.hips, src)[1] * legLength : 0;
      pose(ground! - (lowest() - lift));
    }

    const posed: Record<string, { x: number; y: number; rotation: number }> = {};
    for (const b of order) {
      if (!roleOf.has(b.name)) continue;
      const m = world.get(b.name)!;
      posed[b.name] = { x: m.tx, y: -m.ty, rotation: angleOf(m) };
      const l = local.get(b.name)!;
      last.set(b.name, l.rotation);
      if (chainBones.has(b.name)) continue;
      keys.push({ bone: b.name, frame: outFrame, rotation: l.rotation, ...(b.name === hipsBone ? { x: l.x, y: l.y } : {}) });
    }
    for (const s of solved) {
      const effector = byName.get(s.chain[s.chain.length - 1]!)!;
      const tip = apply({ x: 0, y: 0 }, world.get(effector.name)!, effector.length, 0);
      const target = byName.get(s.target)!;
      const parent = target.parent ? world.get(target.parent) : undefined;
      const [x, y] = localPoint(parent, tip.x, -tip.y);
      keys.push({ bone: s.target, frame: outFrame, x, y });
    }
    expected.push({ frame: outFrame, bones: posed, ...(feet.length ? { feet: lowest() } : {}) });
  }
  for (const s of solved) {
    if (flipped.has(s.chain[0]!)) notes.push(`The IK on "${s.chain[0]}" and "${s.chain[1]}" bends the other way from the clip at some frames: the tip follows the clip, the joint bends the rig's way.`);
  }
  return { keys, expected, ...(lockFeet ? { ground } : {}), notes };
}

/** A bone name's words: "leg_near_thigh" → leg, near, thigh; "upperArmL" → upper, arm, l. */
function nameTokens(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const SIDE_WORDS: Record<string, string> = { near: "near", front: "near", far: "far", back: "far", left: "left", l: "left", right: "right", r: "right" };

/**
 * Which side a bone is on, by its name: the near (or left) side, the far
 * (or right) side, or neither. What the stage shades and the AI's pictures
 * colour, so overlapping limbs read apart.
 */
export function boneSide(name: string): "near" | "far" | null {
  const side = nameTokens(name).map((t) => SIDE_WORDS[t]).find(Boolean);
  return side === "near" || side === "left" ? "near" : side === "far" || side === "right" ? "far" : null;
}

/**
 * Roles read off bone names: "leg_near_thigh" → thigh.near,
 * "upperArmL" → upperArm.left. A side clip maps left/right names to
 * near/far (left as near) and a front clip near/far to left/right, with a
 * note; a model checks the guess against render_frame.
 */
export function guessRoles(names: readonly string[], view: MotionView): { map: Record<string, string>; notes: string[] } {
  const notes: string[] = [];
  const kindOf = (t: string[]): string | null => {
    const has = (...w: string[]) => w.some((x) => t.includes(x));
    if (has("target", "ik", "ctrl", "control", "pole")) return null;
    if (has("foot", "toe", "toes")) return "foot";
    if (has("shin", "calf", "knee") || (has("leg") && has("lower", "low", "2", "bottom"))) return "shin";
    if (has("thigh") || (has("leg") && has("upper", "up", "1", "top")) || t.join("").includes("upperleg")) return "thigh";
    if (has("hand", "palm", "wrist")) return "hand";
    if (has("forearm", "fore") || (has("arm") && has("lower", "low", "2"))) return "forearm";
    if (has("upperarm", "bicep") || has("arm") || t.join("").includes("upperarm")) return "upperArm";
    if (has("head")) return "head";
    if (has("chest", "torso", "spine", "body", "upperbody", "trunk")) return "torso";
    if (has("hips", "hip", "pelvis")) return "hips";
    if (has("leg")) return "thigh";
    return null;
  };
  const found = new Map<string, string[]>();
  for (const name of names) {
    const t = nameTokens(name);
    const kind = kindOf(t);
    if (!kind) continue;
    const side = t.map((x) => SIDE_WORDS[x]).find(Boolean) ?? null;
    const key = ["hips", "torso", "head"].includes(kind) ? kind : `${kind}.${side ?? "?"}`;
    found.set(key, [...(found.get(key) ?? []), name]);
  }
  const [a, b] = SIDES[view];
  const other: Record<string, string> = view === "side" ? { left: a, right: b } : { near: a, far: b };
  let crossed = false;
  const map: Record<string, string> = {};
  for (const [key, list] of found) {
    let role = key;
    const [kind, side] = key.split(".");
    if (side === "?") role = `${kind}.${a}`;
    else if (side && other[side]) { role = `${kind}.${other[side]}`; crossed = true; }
    if (map[role]) continue;
    // Two candidates for one role (a "spine" and a "chest"): the later in
    // the tree is nearer the limbs, which is what the role moves.
    map[role] = list[list.length - 1]!;
  }
  if (crossed) notes.push(view === "side" ? "Bones named left/right were read as near (left) and far (right)." : "Bones named near/far were read as left (near) and right (far).");
  return { map, notes };
}
