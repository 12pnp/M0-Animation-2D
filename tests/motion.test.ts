import { describe, expect, it } from "vitest";
import { apply, type Matrix2D, mat, mul } from "@/core/math/Matrix2D";
import { matrixOf, tf } from "@/core/math/Transform";
import { fromSpineLocal, type SpineLocal } from "@/core/spine/transform";
import { boneSide, guessRoles, localRotationFor, type MotionClip, retarget, type RigBone, type RigIk, sampleRole } from "@/core/rig/motion";
import MOTIONS from "@/core/rig/motions.json";

const CLIPS = MOTIONS as unknown as MotionClip[];
const angleOf = (m: Matrix2D) => (Math.atan2(-m.b, m.a) * 180) / Math.PI;
const wrap = (a: number) => ((((a % 360) + 540) % 360) - 180);

describe("localRotationFor", () => {
  const PARENTS: Array<[string, Matrix2D | undefined]> = [
    ["none", undefined],
    ["turned", matrixOf(tf(3, 4, 40, 40))],
    ["scaled", matrixOf(tf(0, 0, -100, -100, 2, 0.5))],
    ["mirrored", matrixOf(tf(0, 0, 30, 30, -1, 1))],
  ];
  it.each(PARENTS)("points the bone at the world angle under a %s parent", (_, parent) => {
    for (const theta of [-90, 0, 37, 170]) {
      const r = localRotationFor(parent, theta, 0);
      const local = matrixOf(fromSpineLocal({ x: 0, y: 0, rotation: r, shearX: 0, shearY: 0, scaleX: 1, scaleY: 1 }));
      expect(wrap(angleOf(parent ? mul(mat(), parent, local) : local) - theta)).toBeCloseTo(0, 9);
    }
  });
  it("answers nearest the previous value, so a tween never goes the long way", () => {
    expect(localRotationFor(undefined, 10, 350)).toBeCloseTo(370, 9);
    expect(localRotationFor(undefined, -170, 170)).toBeCloseTo(190, 9);
  });
});

describe("sampleRole", () => {
  it.each([[-5, 10], [0, 10], [5, 15], [10, 20], [15, 0], [20, -20], [99, -20]])("at %d is %d", (f, v) => {
    expect(sampleRole([[0, 10], [10, 20], [20, -20]], f)).toBeCloseTo(v, 9);
  });
});

/** A side-view figure: hips at (0, 100) pointing up, a chest, a head, and two
 *  legs of 50 + 50 hanging from the hips; nothing in a T-pose by accident. */
function figure(): RigBone[] {
  const bone = (name: string, parent: string | null, local: Partial<SpineLocal>, length: number): RigBone =>
    ({ name, parent, local: { x: 0, y: 0, rotation: 0, shearX: 0, shearY: 0, scaleX: 1, scaleY: 1, ...local }, length, setup: { x: 0, y: 0, rotation: 0, scaleX: 1 } });
  const bones = [
    bone("hips", null, { x: 0, y: 100, rotation: 90 }, 20),
    bone("chest", "hips", { x: 20, rotation: 5 }, 40),
    bone("head", "chest", { x: 40, rotation: -10 }, 20),
    bone("thighA", "hips", { rotation: 170 }, 50),
    bone("shinA", "thighA", { x: 50, rotation: 10 }, 50),
    bone("thighB", "hips", { rotation: 190 }, 50),
    bone("shinB", "thighB", { x: 50, rotation: -5 }, 50),
    bone("footTarget", null, { x: 30, y: 0 }, 10),
  ];
  // The setup worlds, as the runtime poses them (no IK solves here).
  const worlds = compose(bones, new Map());
  for (const b of bones) {
    const m = worlds.get(b.name)!;
    b.setup = { x: m.tx, y: -m.ty, rotation: angleOf(m), scaleX: Math.hypot(m.a, m.b) };
  }
  return bones;
}

/** World matrices from setup locals with `keyed` values over them: an FK of
 *  the test's own, not the retarget's. */
function compose(bones: RigBone[], keyed: Map<string, Partial<SpineLocal>>): Map<string, Matrix2D> {
  const out = new Map<string, Matrix2D>();
  const at = (b: RigBone): Matrix2D => {
    const done = out.get(b.name);
    if (done) return done;
    const m = matrixOf(fromSpineLocal({ ...b.local, ...keyed.get(b.name) }));
    const parent = b.parent ? at(bones.find((x) => x.name === b.parent)!) : undefined;
    const w = parent ? mul(mat(), parent, m) : m;
    out.set(b.name, w);
    return w;
  };
  for (const b of bones) at(b);
  return out;
}

const MAP = { hips: "hips", torso: "chest", head: "head", "thigh.near": "thighA", "shin.near": "shinA", "thigh.far": "thighB", "shin.far": "shinB" };
const clip = (name: string) => CLIPS.find((c) => c.name === name)!;

/** The pose the keys make at `frame`. */
function posed(bones: RigBone[], keys: ReturnType<typeof retarget>["keys"], frame: number) {
  const keyed = new Map<string, Partial<SpineLocal>>();
  for (const k of keys.filter((x) => x.frame === frame)) {
    keyed.set(k.bone, { ...(k.rotation !== undefined ? { rotation: k.rotation } : {}), ...(k.x !== undefined ? { x: k.x, y: k.y } : {}) });
  }
  return compose(bones, keyed);
}
const lowestFoot = (w: Map<string, Matrix2D>) => Math.min(...["shinA", "shinB"].map((n) => -apply({ x: 0, y: 0 }, w.get(n)!, 50, 0).y));

describe("retarget", () => {
  it("points every limb the way the clip says, and keeps the feet on the ground", () => {
    const bones = figure();
    const walk = clip("walk");
    const { keys, ground, expected } = retarget({ clip: walk, bones, ik: [], map: MAP });
    // The lower of the two feet as the figure stands.
    expect(ground).toBeCloseTo(lowestFoot(compose(bones, new Map())), 9);
    for (const { frame } of expected) {
      const w = posed(bones, keys, frame);
      for (const [role, bone] of Object.entries(MAP)) {
        if (role === "hips" || role === "head") continue;
        expect(wrap(angleOf(w.get(bone)!) - sampleRole(walk.angles[role]!, frame)), `${role} at ${frame}`).toBeCloseTo(0, 6);
      }
      // Delta roles turn from the rig's own setup angle: the head stays tilted as drawn.
      expect(wrap(angleOf(w.get("head")!) - (bones[2]!.setup.rotation + sampleRole(walk.angles.head!, frame)))).toBeCloseTo(0, 6);
      expect(lowestFoot(w), `feet at ${frame}`).toBeCloseTo(ground!, 6);
    }
  });

  it("mirrors a side clip for a character facing left", () => {
    const bones = figure();
    const right = retarget({ clip: clip("run"), bones, ik: [], map: MAP });
    const left = retarget({ clip: clip("run"), bones, ik: [], map: MAP, facing: "left" });
    for (const f of [0, 4, 6]) {
      const r = posed(bones, right.keys, f), l = posed(bones, left.keys, f);
      expect(wrap(angleOf(l.get("thighA")!) - (180 - angleOf(r.get("thighA")!)))).toBeCloseTo(0, 6);
      expect(lowestFoot(l)).toBeCloseTo(lowestFoot(r), 6);
    }
  });

  it("stretches the clip to the length asked for, and closes a loop", () => {
    const bones = figure();
    const { keys } = retarget({ clip: clip("walk"), bones, ik: [], map: MAP, frames: 48 });
    const frames = [...new Set(keys.map((k) => k.frame))];
    expect(frames).toEqual(Array.from({ length: 49 }, (_, i) => i));
    // Frame 12 of 48 is frame 6 of the clip.
    const w = posed(bones, keys, 12);
    expect(wrap(angleOf(w.get("thighA")!) - sampleRole(clip("walk").angles["thigh.near"]!, 6))).toBeCloseTo(0, 6);
    const first = keys.filter((k) => k.frame === 0), last = keys.filter((k) => k.frame === 48);
    for (const k of first) expect(last.find((x) => x.bone === k.bone)!.rotation).toBeCloseTo(k.rotation!, 6);
  });

  it("lifts the body by the clip's flight, never pushing a foot below the ground", () => {
    const bones = figure();
    const jump = clip("jump");
    const { keys, ground, expected } = retarget({ clip: jump, bones, ik: [], map: MAP });
    const air = expected.map((e) => lowestFoot(posed(bones, keys, e.frame)) - ground!);
    expect(Math.min(...air)).toBeCloseTo(0, 6);
    // The top of the jump, frame 15: half a leg length (100 here) up.
    expect(air[expected.findIndex((e) => e.frame === 15)]).toBeCloseTo(50, 6);
  });

  it("keys an IK target at the limb's tip instead of the bones the solver turns", () => {
    const bones = figure();
    const ik: RigIk[] = [{ bones: ["thighA", "shinA"], target: "footTarget" }];
    const { keys, expected } = retarget({ clip: clip("walk"), bones, ik, map: MAP });
    expect(keys.some((k) => k.bone === "thighA" || k.bone === "shinA")).toBe(false);
    for (const { frame } of expected.slice(0, 5)) {
      const w = compose(bones, new Map([...keys.filter((k) => k.frame === frame && k.bone !== "footTarget")]
        .map((k) => [k.bone, { rotation: k.rotation!, ...(k.x !== undefined ? { x: k.x, y: k.y } : {}) }])));
      const t = keys.find((k) => k.bone === "footTarget" && k.frame === frame)!;
      // The tip the FK legs would reach, as the retarget expected them.
      const e = expected.find((x) => x.frame === frame)!.bones.shinA!;
      const tip = { x: e.x + 50 * Math.cos((e.rotation * Math.PI) / 180), y: e.y + 50 * Math.sin((e.rotation * Math.PI) / 180) };
      expect(t.x).toBeCloseTo(tip.x, 6);
      expect(t.y).toBeCloseTo(tip.y, 6);
      expect(w.get("hips")).toBeDefined();
    }
  });

  it("bends a joint the solver's way, keeping the tip, when the clip bends it the other", () => {
    const bones = figure();
    // The walk bends the knee clockwise (a negative turn); this solver bends the other way.
    const against = retarget({ clip: clip("walk"), bones, ik: [{ bones: ["thighA", "shinA"], target: "footTarget", bend: 1 }], map: MAP });
    const along = retarget({ clip: clip("walk"), bones, ik: [{ bones: ["thighA", "shinA"], target: "footTarget", bend: -1 }], map: MAP });
    expect(against.notes.some((n) => n.includes("bends the other way"))).toBe(true);
    expect(along.notes.some((n) => n.includes("bends the other way"))).toBe(false);
    for (const [a, b] of against.expected.map((e, i) => [e, along.expected[i]!] as const)) {
      const t = (e: typeof a) => {
        const s = e.bones.shinA!;
        return [s.x + 50 * Math.cos((s.rotation * Math.PI) / 180), s.y + 50 * Math.sin((s.rotation * Math.PI) / 180)];
      };
      expect(t(a)[0]).toBeCloseTo(t(b)[0]!, 6);
      expect(t(a)[1]).toBeCloseTo(t(b)[1]!, 6);
      const turn = Math.sin(((a.bones.shinA!.rotation - a.bones.thighA!.rotation) * Math.PI) / 180);
      expect(turn).toBeGreaterThanOrEqual(-1e-9);
    }
    const keyA = against.keys.filter((k) => k.bone === "footTarget"), keyB = along.keys.filter((k) => k.bone === "footTarget");
    keyA.forEach((k, i) => { expect(k.x).toBeCloseTo(keyB[i]!.x!, 9); expect(k.y).toBeCloseTo(keyB[i]!.y!, 9); });
  });

  it("says what it could not do, and refuses a wrong map", () => {
    const bones = figure();
    const { notes } = retarget({ clip: clip("walk"), bones, ik: [], map: { torso: "chest" } });
    expect(notes).toContain("thigh.near is not mapped; it keeps its setup pose.");
    expect(notes.some((n) => n.startsWith("No thigh and shin are mapped"))).toBe(true);
    expect(notes.some((n) => n.startsWith("The feet are not kept on the ground"))).toBe(true);
    expect(() => retarget({ clip: clip("walk"), bones, ik: [], map: { tail: "chest" } })).toThrow(/no role "tail"/);
    expect(() => retarget({ clip: clip("walk"), bones, ik: [], map: { torso: "chest", head: "chest" } })).toThrow(/mapped twice/);
    expect(() => retarget({ clip: clip("walk"), bones, ik: [], map: { torso: "nope" } })).toThrow(/no bone "nope"/);
  });
});

describe("the motion library", () => {
  it.each(CLIPS.map((c) => [c.name, c] as const))("%s closes its loop and keys only known roles", (_, c) => {
    for (const [role, keys] of Object.entries(c.angles)) {
      expect(keys[0]![0]).toBe(0);
      expect(keys[keys.length - 1]![0]).toBe(c.frames);
      if (c.loop) expect(keys[keys.length - 1]![1], role).toBeCloseTo(keys[0]![1], 6);
      expect(c.view === "side" ? !/left|right/.test(role) : !/near|far/.test(role), role).toBe(true);
    }
  });
});

describe("boneSide", () => {
  it.each([
    ["leg_far_thigh", "far"], ["arm_near_up", "near"], ["UpperArm.L", "near"], ["thigh_r", "far"], ["handRight", "far"],
    ["leftFoot", "near"], ["shin_back", "far"], ["hips", null], ["torso_bone", null], ["Lollipop", null], ["rear", null],
  ] as const)("%s is %s", (name, side) => {
    expect(boneSide(name)).toBe(side);
  });
});

describe("guessRoles", () => {
  it.each<[string, string[], "side" | "front", Record<string, string>]>([
    ["the stickman", ["hips", "chest", "head", "arm_far_up", "arm_far_fore", "arm_near_up", "arm_near_fore", "leg_far_thigh", "leg_far_shin", "leg_near_thigh", "leg_near_shin", "foot_near_target"], "side",
      { hips: "hips", torso: "chest", head: "head", "upperArm.far": "arm_far_up", "forearm.far": "arm_far_fore", "upperArm.near": "arm_near_up", "forearm.near": "arm_near_fore", "thigh.far": "leg_far_thigh", "shin.far": "leg_far_shin", "thigh.near": "leg_near_thigh", "shin.near": "leg_near_shin" }],
    ["a humanoid", ["Hips", "Spine", "Chest", "Neck", "Head", "UpperArm.L", "LowerArm.L", "Hand.L", "UpperLeg.R", "LowerLeg.R", "Foot.R"], "front",
      { hips: "Hips", torso: "Chest", head: "Head", "upperArm.left": "UpperArm.L", "forearm.left": "LowerArm.L", "hand.left": "Hand.L", "thigh.right": "UpperLeg.R", "shin.right": "LowerLeg.R", "foot.right": "Foot.R" }],
    ["one unsided leg", ["pelvis", "thigh", "calf", "foot"], "side", { hips: "pelvis", "thigh.near": "thigh", "shin.near": "calf", "foot.near": "foot" }],
  ])("reads %s", (_, names, view, map) => {
    expect(guessRoles(names, view).map).toEqual(map);
  });

  it("says when it read left and right as near and far", () => {
    const { map, notes } = guessRoles(["thigh_l", "shin_l", "thigh_r", "shin_r"], "side");
    expect(map).toEqual({ "thigh.near": "thigh_l", "shin.near": "shin_l", "thigh.far": "thigh_r", "shin.far": "shin_r" });
    expect(notes.length).toBe(1);
  });
});
