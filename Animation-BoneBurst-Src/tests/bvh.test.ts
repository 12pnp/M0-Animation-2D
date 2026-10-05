import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBvh, positionsAt } from "@/core/rig/bvh";
import { bvhClip } from "@/core/rig/bvhClip";

/**
 * BVH mocap as library clips (docs/ANIMATED-DRAWINGS-PLAN.md AD-3): the reader,
 * forward kinematics, and the view a clip is read from, on a take whose
 * answers are known; then AnimatedDrawings' own takes, where its checkout is.
 */

/** Y up, facing +z (so the character's left is +x). Limbs hang straight down;
 *  frame 1 swings the right arm forward, frame 2 raises the left arm sideways. */
const limb = (name: string, offset: string, parts: string[], end: string): string => {
  const [first, ...rest] = parts;
  return `JOINT ${name}${first} { OFFSET ${offset} CHANNELS 3 Zrotation Xrotation Yrotation ${
    rest.length ? limb(name, "0 -10 0", rest, end) : `End Site { OFFSET ${end} }`} }`;
};
const TAKE = `HIERARCHY
ROOT Hips { OFFSET 0 0 0 CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Neck { OFFSET 0 20 0 CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Head { OFFSET 0 4 0 CHANNELS 3 Zrotation Xrotation Yrotation End Site { OFFSET 0 6 0 } }
    ${limb("Left", "4 -2 0", ["Arm", "ForeArm", "Hand"], "0 -3 0")}
    ${limb("Right", "-4 -2 0", ["Arm", "ForeArm", "Hand"], "0 -3 0")} }
  ${limb("Left", "3 0 0", ["UpLeg", "Leg", "Foot"], "0 -2 0").replace("JOINT LeftFoot { OFFSET 0 -10 0 CHANNELS 3 Zrotation Xrotation Yrotation End Site { OFFSET 0 -2 0 } }", "JOINT LeftFoot { OFFSET 0 -10 0 CHANNELS 3 Zrotation Xrotation Yrotation JOINT LeftToeBase { OFFSET 0 0 3 CHANNELS 3 Zrotation Xrotation Yrotation End Site { OFFSET 0 0 1 } } }")}
  ${limb("Right", "-3 0 0", ["UpLeg", "Leg", "Foot"], "0 -2 0").replace("JOINT RightFoot { OFFSET 0 -10 0 CHANNELS 3 Zrotation Xrotation Yrotation End Site { OFFSET 0 -2 0 } }", "JOINT RightFoot { OFFSET 0 -10 0 CHANNELS 3 Zrotation Xrotation Yrotation JOINT RightToeBase { OFFSET 0 0 3 CHANNELS 3 Zrotation Xrotation Yrotation End Site { OFFSET 0 0 1 } } }")}
}
MOTION
Frames: 3
Frame Time: ${1 / 24}
`;

function takeWith(edits: Array<Record<string, [number, number, number]>>): string {
  const bvh = parseBvh(TAKE.replace("Frames: 3", "Frames: 0"));
  const count = bvh.joints.reduce((n, j) => n + j.channels.length, 0);
  const lines = edits.map((edit) => {
    const v = new Array<number>(count).fill(0);
    v[1] = 20;
    for (const [name, [z, x, y]] of Object.entries(edit)) {
      const j = bvh.joints.find((k) => k.name === name)!;
      v[j.start] = z; v[j.start + 1] = x; v[j.start + 2] = y;
    }
    return v.join(" ");
  });
  return TAKE + lines.join("\n");
}

const MOVES = takeWith([{}, { RightArm: [0, -90, 0] }, { LeftArm: [90, 0, 0] }]);

describe("BVH", () => {
  it("reads the hierarchy, the channels and the frames", () => {
    const bvh = parseBvh(MOVES);
    expect(bvh.joints.map((j) => j.name)).toContain("RightToeBase");
    expect(bvh.joints[0]!.channels).toHaveLength(6);
    expect(bvh.frames).toHaveLength(3);
    expect(bvh.frameTime).toBeCloseTo(1 / 24, 9);
  });

  it("poses joints by forward kinematics, rotations in the file's order", () => {
    const bvh = parseBvh(MOVES);
    const at = (f: number, name: string) => positionsAt(bvh, f).joints[bvh.joints.findIndex((j) => j.name === name)]!;
    // Hips at 20, the neck 20 above, the shoulders 2 below it: y 38.
    // Rest: the right hand 20 below its shoulder; swung by -90° about x, 20 in front of it.
    expect(at(0, "RightHand").map((v) => Math.round(v) + 0)).toEqual([-4, 18, 0]);
    expect(at(1, "RightHand").map((v) => Math.round(v) + 0)).toEqual([-4, 38, 20]);
    // +90° about z sends the left arm out to +x.
    expect(at(2, "LeftHand").map((v) => Math.round(v) + 0)).toEqual([24, 38, 0]);
  });

  it("rejects what is not BVH, saying where", () => {
    expect(() => parseBvh("HIERARCHY ROOT Hips { OFFSET 0 0 }")).toThrow(/not a number|ends early/);
    expect(() => parseBvh("MOTION")).toThrow(/"HIERARCHY" expected/);
  });
});

describe("a BVH take as a clip", () => {
  const read = (view: "side" | "front") => bvhClip(parseBvh(MOVES), { name: "t", description: "", view, up: "+y", step: 1 });
  const at = (keys: Array<[number, number]>, frame: number) => keys.find(([f]) => f === frame)![1];

  it("reads limbs as world angles: standing, every limb hangs at -90 and the torso stands at 90", () => {
    const c = read("side");
    expect(c.frames).toBe(2);
    for (const role of ["thigh.near", "thigh.far", "shin.near", "upperArm.near", "upperArm.far", "forearm.far"]) expect(at(c.angles[role]!, 0), role).toBeCloseTo(-90, 1);
    expect(at(c.angles.torso!, 0)).toBeCloseTo(90, 1);
    expect(at(c.angles["foot.near"]!, 0)).toBeCloseTo(0, 1);
  });

  it("side view faces right: the right arm swung forward points along +x, and it is the near one", () => {
    const c = read("side");
    expect(at(c.angles["upperArm.near"]!, 1)).toBeCloseTo(0, 1);
    expect(at(c.angles["upperArm.far"]!, 1)).toBeCloseTo(-90, 1);
    // The hand turns with its forearm: its delta is the forearm's turn from hanging.
    expect(at(c.angles["hand.near"]!, 1)).toBeCloseTo(90, 1);
  });

  it("front view faces the viewer: the character's left arm is screen right", () => {
    const c = read("front");
    expect(at(c.angles["upperArm.right"]!, 2)).toBeCloseTo(0, 1);
    expect(at(c.angles["upperArm.left"]!, 2)).toBeCloseTo(-90, 1);
  });

  it("stays in place, the hips rising only off the ground", () => {
    const c = read("side");
    expect(c.hips!.every(([, x, y]) => x === 0 && y === 0)).toBe(true);
    expect(c).toMatchObject({ grounded: true, loop: false, fps: 24 });
  });

  it("refuses joint names it does not know", () => {
    const odd = MOVES.replaceAll("UpLeg", "Thigh");
    expect(() => bvhClip(parseBvh(odd), { name: "t", description: "", view: "side", up: "+y" })).toThrow(/not recognised/);
  });
});

const AD = resolve(__dirname, "../../../AnimatedDrawings/examples");

describe.skipIf(!existsSync(AD))("AnimatedDrawings' takes", () => {
  it.each([["fair1/zombie.bvh", "+z", "side"], ["rokoko/jesse_dance.bvh", "+y", "front"], ["cmu1/jumping_jacks.bvh", "+y", "front"]] as const)("%s reads standing at its start", (file, up, view) => {
    const c = bvhClip(parseBvh(readFileSync(join(AD, "bvh", file), "utf8")), { name: "t", description: "", view, up });
    const sides = view === "side" ? ["near", "far"] : ["left", "right"];
    for (const s of sides) expect(Math.abs(c.angles[`thigh.${s}`]![0]![1] + 90), `thigh.${s}`).toBeLessThan(15);
    expect(Math.abs(c.angles.torso![0]![1] - 90)).toBeLessThan(10);
  });
});
