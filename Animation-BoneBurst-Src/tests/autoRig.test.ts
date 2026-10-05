import { describe, expect, it } from "vitest";
import { type AutoRigPlan, autoRigPlan, jointNames, layerPixel, type RigLayer } from "@/core/rig/autoRig";
import { guessRoles } from "@/core/rig/motion";

/** A side-view figure facing right, y up, feet at 0. */
const JOINTS = {
  pelvis: [0, 100], neck: [0, 160], head: [0, 190],
  "shoulder.near": [2, 155], "elbow.near": [8, 128], "wrist.near": [16, 104],
  "shoulder.far": [-2, 155], "elbow.far": [-6, 128], "wrist.far": [-2, 104],
  "hip.near": [3, 100], "knee.near": [10, 52], "ankle.near": [4, 4], "toe.near": [16, 0],
  "hip.far": [-3, 100], "knee.far": [-6, 52], "ankle.far": [-10, 4],
} as const satisfies Record<string, readonly [number, number]>;

/** An upright layer covering a box, its pivot at its centre, as Import PSD as Layers leaves it. */
function box(name: string, x0: number, y0: number, x1: number, y1: number, z: number): RigLayer {
  const w = x1 - x0, h = y1 - y0;
  return { name, size: [w, h], pivot: [w / 2, h / 2], at: [(x0 + x1) / 2, (y0 + y1) / 2], rotation: 0, z };
}

const plan = (joints: Record<string, readonly [number, number]>, layers: RigLayer[] = [], view: "side" | "front" = "side", opts = {}) => {
  const out = autoRigPlan(joints as Record<string, [number, number]>, layers, view, opts);
  if (typeof out === "string") throw new Error(out);
  return out;
};
const bone = (p: AutoRigPlan, name: string) => p.bones.find((b) => b.name === name)!;

describe("autoRigPlan: bones", () => {
  it("builds a bone between each pair of joints, parents first, named for guessRoles", () => {
    const p = plan(JOINTS);
    expect(p.bones.map((b) => `${b.name}<${b.parent ?? ""}`)).toEqual([
      "hips<", "torso<hips", "head<torso",
      "thigh_near<hips", "shin_near<thigh_near", "foot_near<shin_near", "upper_arm_near<torso", "forearm_near<upper_arm_near",
      "thigh_far<hips", "shin_far<thigh_far", "upper_arm_far<torso", "forearm_far<upper_arm_far",
    ]);
    expect(bone(p, "shin_near")).toMatchObject({ from: [10, 52], to: [4, 4] });
    expect(bone(p, "head")).toMatchObject({ from: [0, 160], to: [0, 190] });
    expect(p.ik).toEqual(["shin_near", "shin_far"]);
    const { map } = guessRoles(p.bones.map((b) => b.name), "side");
    expect(map).toMatchObject({ hips: "hips", torso: "torso", head: "head", "thigh.near": "thigh_near", "shin.far": "shin_far", "foot.near": "foot_near", "upperArm.near": "upper_arm_near", "forearm.far": "forearm_far" });
  });

  it("guesses what it is not told, and says so", () => {
    const p = plan({ pelvis: [0, 100], neck: [0, 160], "knee.near": [0, 50], "ankle.near": [0, 0], "elbow.far": [5, 130] });
    expect(bone(p, "head").to).toEqual([0, 187]);
    expect(bone(p, "hips")).toMatchObject({ from: [0, 100], to: [0, 112] });
    // A thigh from the pelvis when no hip is given; no arm without a shoulder.
    expect(bone(p, "thigh_near").from).toEqual([0, 100]);
    expect(p.bones.some((b) => b.name.includes("arm"))).toBe(false);
    expect(p.notes).toEqual(expect.arrayContaining([expect.stringMatching(/No head point/), expect.stringMatching(/No shoulder.far/)]));
  });

  it("makes the spine two bones when told where the chest starts", () => {
    const p = plan({ pelvis: [0, 100], chest: [0, 130], neck: [0, 160] });
    expect(bone(p, "hips")).toMatchObject({ from: [0, 100], to: [0, 130] });
    expect(bone(p, "torso")).toMatchObject({ parent: "hips", from: [0, 130], to: [0, 160] });
  });

  it("stops a limb at its first missing joint, and IK only on a whole leg", () => {
    const p = plan({ pelvis: [0, 100], neck: [0, 160], "knee.near": [0, 50], "toe.near": [9, 0] });
    expect(p.bones.map((b) => b.name)).toContain("thigh_near");
    expect(p.bones.map((b) => b.name)).not.toContain("shin_near");
    expect(p.ik).toEqual([]);
    expect(plan(JOINTS, [], "side", { armIk: true }).ik).toEqual(["shin_near", "forearm_near", "shin_far", "forearm_far"]);
  });

  it("names a front view's sides left and right", () => {
    const p = plan({ pelvis: [0, 100], neck: [0, 160], "knee.left": [-8, 50], "ankle.left": [-10, 0], "shoulder.right": [10, 155], "elbow.right": [20, 125] }, [], "front");
    expect(p.bones.map((b) => b.name)).toEqual(["hips", "torso", "head", "thigh_left", "shin_left", "upper_arm_right"]);
    expect(jointNames("front")).toContain("wrist.left");
  });

  it("refuses what it cannot build, saying why", () => {
    expect(autoRigPlan({ pelvis: [0, 0] }, [], "side")).toMatch(/needs at least pelvis and neck/);
    expect(autoRigPlan({ pelvis: [0, 0], neck: [0, 0] }, [], "side")).toMatch(/same point/);
    expect(autoRigPlan({ pelvis: [0, 0], neck: [0, 9], "knee.left": [0, 1] }, [], "side")).toMatch(/no joint "knee.left" in a side view/);
    expect(autoRigPlan({ pelvis: [0, 0], neck: [0, Number.NaN] as unknown as [number, number] }, [], "side")).toMatch(/two numbers/);
  });
});

describe("autoRigPlan: pictures", () => {
  // Front first, as the artist stacked them: near arm, head, torso, near leg, far leg, far arm.
  const LAYERS = [
    box("arm_n", -2, 100, 20, 158, 0),
    box("head_art", -15, 158, 15, 195, 1),
    box("body", -14, 95, 14, 162, 2),
    box("leg_n_top", -2, 48, 16, 104, 3),
    box("leg_n_low", -3, 0, 14, 56, 4),
    box("leg_f_top", -12, 48, 2, 104, 5),
    box("arm_f", -10, 100, 4, 158, 6),
    box("cloud", 300, 300, 340, 320, 7),
  ];

  it("puts each picture on the bone that runs through it, turning about that bone's joint", () => {
    const p = plan(JOINTS, LAYERS);
    const on = Object.fromEntries(p.attach.map((a) => [a.layer, a.bone]));
    expect(on).toEqual({ arm_n: "upper_arm_near", head_art: "head", body: "torso", leg_n_top: "thigh_near", leg_n_low: "shin_near", leg_f_top: "thigh_far", arm_f: "upper_arm_far" });
    // The pivot is the bone's joint, in the picture's pixels (v down).
    const body = p.attach.find((a) => a.layer === "body")!;
    expect(body.pivot).toEqual([14, 62]);
    expect(p.notes).toContain(`"cloud" is not on any bone: no bone passes through it.`);
  });

  it("keeps the artist's stacking inside every bone", () => {
    const p = plan(JOINTS, LAYERS);
    const order = Object.fromEntries(p.order.map((o) => [o.parent, o.front]));
    expect(order.torso).toEqual(["upper_arm_near", "head", "body", "upper_arm_far"]);
    expect(order.hips).toEqual(["torso", "thigh_near", "thigh_far"]);
  });

  it("fits joints read off a picture, a hair outside an edge, and flags what fits nothing well", () => {
    // A side-view PSD of parts (y up, front first) and the joints a model read off
    // its render_frame: the neck lands 0.4 px above the body picture's top.
    const layers = [
      box("arm_front", 145, -150, 160, -80, 0), box("forearm_front", 147, -210, 158, -148, 1), box("head", 125, -70, 175, -20, 2),
      box("body", 130, -170, 170, -70, 3), box("thigh_front", 145, -280, 165, -190, 4), box("shin_front", 147, -370, 163, -278, 5),
      box("foot_front", 147, -380, 185, -365, 6), box("pelvis", 128, -195, 172, -165, 7), box("thigh_back", 135, -280, 155, -190, 8),
      box("shin_back", 137, -370, 153, -278, 9), box("foot_back", 137, -380, 175, -365, 10), box("arm_back", 138, -150, 150, -80, 11),
      box("forearm_back", 139, -210, 149, -148, 12),
    ];
    const joints = {
      head: [149.9, -20.1], neck: [149.9, -69.6], chest: [149.9, -166.4], pelvis: [149.9, -185],
      "shoulder.near": [152.2, -79.9], "elbow.near": [152.2, -150], "wrist.near": [152.2, -209.3],
      "hip.near": [155, -189.7], "knee.near": [155, -279.4], "ankle.near": [154.6, -369.6], "toe.near": [184.5, -371.9],
      "hip.far": [144.7, -189.7], "knee.far": [144.7, -279.4], "ankle.far": [144.7, -369.6],
    } as const;
    const p = plan(joints, layers, "side", { taken: (n: string) => layers.some((l) => l.name === n) });
    const on = Object.fromEntries(p.attach.map((a) => [a.layer, a.bone]));
    expect(on).toMatchObject({
      arm_front: "upper_arm_near", forearm_front: "forearm_near", head: "head_bone", body: "torso", thigh_front: "thigh_near",
      shin_front: "shin_near", foot_front: "foot_near", pelvis: "hips", thigh_back: "thigh_far", shin_back: "shin_far",
    });
    // The far arm was hidden, so it has no bones: its pictures are flagged, not hidden.
    expect(p.notes.some((n) => n.startsWith(`"forearm_back" fits "${on.forearm_back}" poorly`))).toBe(true);
    expect(p.notes).toContain(`"foot_back" shares "foot_near" with "foot_front": right for one part drawn in two layers; otherwise give the joints of the part it shows.`);
  });

  it("reads a turned picture's pixels", () => {
    const layer: RigLayer = { name: "t", size: [40, 10], pivot: [0, 5], at: [100, 50], rotation: 90, z: 0 };
    // Turned a quarter counter-clockwise: its +u runs up the skeleton's y.
    const [u, v] = layerPixel(layer, [100, 80]);
    expect(u).toBeCloseTo(30, 9);
    expect(v).toBeCloseTo(5, 9);
    expect(layerPixel(layer, [102, 50])[1]).toBeCloseTo(7, 9);
  });
});
