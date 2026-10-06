import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRefused, callTool } from "@/agent/host";
import { CLIPS, rigForMotion } from "@/agent/motion";
import { parseBvh, positionsAt } from "@/agent/rig/bvh";
import { localMatrix, multiply, retarget, type Matrix, type RetargetRequest } from "@/agent/rig/motion";
import { History } from "@/edit/history";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import type { Skeleton } from "@/model/skeleton";
import { importPsd } from "@/ui/psdImport";
import { testContext } from "./fixtures/agentContext";
import { figureLayers, writeFigure } from "./fixtures/psd";

/**
 * Motion (E5 step 6): the library, the retarget (its posing rewritten from v1's, checked against
 * v1's own answers, `fixtures/retarget-v1.json`), the BVH reader, and the two tools.
 */

const D = join(__dirname, "fixtures", "stickman");
const stickDoc = readSkeleton(readFileSync(join(D, "Stickman_IK.json"), "utf8")).skeleton;
const stickImages = atlasImages(readAtlas(readFileSync(join(D, "Stickman_IK.atlas.txt"), "utf8")));
const fig = importPsd(writeFigure(figureLayers()), "figure.psd", "h");
const JOINTS = {
  pelvis: [0, 134], neck: [0, 279], head: [0, 378], "hip.left": [-20, 129], "knee.left": [-20, 76], "ankle.left": [-20, 28],
  "hip.right": [20, 129], "knee.right": [20, 76], "ankle.right": [20, 28], "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
  "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
};
type Ctx = ReturnType<typeof testContext>;
const call = (c: Ctx, name: string, args: unknown) => callTool(name, args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };
async function riggedFigure(): Promise<Ctx> {
  const c = testContext(new History(fig.skeleton), atlasImages(fig.atlas));
  await call(c, "auto_rig", { joints: JOINTS, view: "front" });
  return c;
}
const stick = () => testContext(new History(stickDoc as Skeleton), stickImages);
/** The stickman's limbs by role (its art bones' names mislead the guess). */
const STICK_MAP = {
  hips: "hips", torso: "chest", head: "head",
  "thigh.near": "leg_near_thigh", "shin.near": "leg_near_shin", "thigh.far": "leg_far_thigh", "shin.far": "leg_far_shin",
  "upperArm.near": "arm_near_up", "forearm.near": "arm_near_fore", "upperArm.far": "arm_far_up", "forearm.far": "arm_far_fore",
};

describe("motion (E5 step 6)", () => {
  it("the retarget, its posing rewritten, gives v1's answers (the fork run as an oracle)", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "retarget-v1.json"), "utf8")) as { request: Omit<RetargetRequest, "clip"> & { clip: string }; v1: { keys: Record<string, number | string>[]; notes: string[]; ground?: number } }[];
    expect(fixture.length).toBe(3);
    for (const { request, v1 } of fixture) {
      const out = retarget({ ...request, clip: CLIPS.find((x) => x.name === request.clip)! });
      expect(out.keys.length, request.clip).toBe(v1.keys.length);
      let worst = 0;
      out.keys.forEach((k, i) => {
        const w = v1.keys[i]!;
        expect([k.bone, k.frame]).toEqual([w.bone, w.frame]);
        for (const f of ["rotation", "x", "y"] as const) if (w[f] !== undefined) worst = Math.max(worst, Math.abs((k[f] as number) - (w[f] as number)));
      });
      expect(worst, `${request.clip} ${request.facing}`).toBeLessThan(1e-6);
      expect(out.notes).toEqual(v1.notes);
      if (v1.ground === undefined) expect(out.ground).toBeUndefined();
      else expect(out.ground).toBeCloseTo(v1.ground, 6);
    }
  });

  // The runtime works in float32: four decimals.
  it("composes world matrices as the runtime does (the bones no constraint moves)", () => {
    const c = stick(), rig = rigForMotion(stickDoc, c), world = new Map<string, Matrix>();
    for (const b of rig.bones) {
      const m = localMatrix(b.local);
      world.set(b.name, b.parent ? multiply(world.get(b.parent)!, m) : m);
    }
    for (const name of ["hips", "chest", "head", "torso", "pelvis"]) {
      const want = rig.bones.find((b) => b.name === name)!.setup, got = world.get(name)!;
      expect(got[4]).toBeCloseTo(want.x, 4);
      expect(got[5]).toBeCloseTo(want.y, 4);
      expect((Math.atan2(got[2], got[0]) * 180) / Math.PI).toBeCloseTo(want.rotation, 4);
    }
  });

  it("reads a BVH and poses its joints by forward kinematics", () => {
    const bvh = parseBvh(`HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Spine
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 5 0
    }
  }
}
MOTION
Frames: 2
Frame Time: 0.0333333
0 0 0 0 0 0 0 0 0
1 2 3 90 0 0 0 0 0`);
    expect(bvh.frames.length).toBe(2);
    const p1 = positionsAt(bvh, 1), r = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 || 0);
    // The root moved by (1, 2, 3) and turned 90° about z: the spine, 10 up, now sits along −x, and its end 5 further.
    expect(r(p1.joints[0]!)).toEqual([1, 2, 3]);
    expect(r(p1.joints[1]!)).toEqual([-9, 2, 3]);
    expect(r(p1.ends[1]!)).toEqual([-14, 2, 3]);
  });

  it("list_motions: every clip, and the roles guessed for the rig in each view", async () => {
    const c = await riggedFigure();
    const out = await call(c, "list_motions", {});
    expect(out.motions.map((m: { name: string }) => m.name)).toEqual(["walk", "run", "idle", "jump", "idle_front", "wave", "jump_front", "wave_hello", "dab", "jumping", "zombie_walk", "dance"]);
    expect(out.guessed.front).toMatchObject({ hips: "hips", torso: "torso", "thigh.left": "thigh_left", "shin.right": "shin_right", "upperArm.left": "upper_arm_left", "forearm.right": "forearm_right" });
  });

  it("apply_motion on the auto-rigged figure: a new animation in one step, feet never below the ground, the runtime matching the retarget", async () => {
    const c = await riggedFigure();
    for (const motion of ["idle_front", "wave_hello", "jumping"]) {
      const out = await call(c, "apply_motion", { motion });
      expect(c.history!.undoLabel).toBe(`AI: apply_motion ${motion} as ${motion}`);
      expect(out.check, motion).toMatchObject({ matches: true });
      if (out.ground !== undefined) expect(out.lowestFoot, motion).toBeGreaterThanOrEqual(out.ground - 0.01);
      const anim = await call(c, "get_animation", { animation: motion });
      expect(anim.frames, motion).toBe(out.frames);
      if (out.loops) expect(anim.seam, motion).toEqual([]);
    }
    expect(await call(c, "undo", {})).toEqual({ undone: ["AI: apply_motion jumping as jumping"] });
    expect(c.history!.doc.animations!.some((a) => a.name === "jumping")).toBe(false);
  });

  it("apply_motion on the stickman with a map: its IK targets keyed (never the bones they turn), the feet on the ground", async () => {
    const c = stick();
    const out = await call(c, "apply_motion", { motion: "walk", animation: "walk2", map: STICK_MAP, frames: 24 });
    expect(out.check).toMatchObject({ matches: true });
    expect(out.ground).toBeDefined();
    expect(out.lowestFoot).toBeGreaterThanOrEqual(out.ground - 0.01);
    const anim = await call(c, "get_animation", { animation: "walk2" });
    expect(Object.keys(anim.bones)).toEqual(expect.arrayContaining(["foot_near_target", "foot_far_target", "hips"]));
    expect(anim.bones.leg_near_thigh).toBeUndefined();
    expect(anim.frames).toBe(24);
  });

  it("refuses an unknown clip, a taken name and an unknown role, saying why", async () => {
    const c = stick();
    expect(await refused(call(c, "apply_motion", { motion: "moonwalk" }))).toMatch(/There is no motion "moonwalk"; list_motions has walk, run/);
    expect(await refused(call(c, "apply_motion", { motion: "run" }))).toMatch(/already an animation "run"/);
    expect(await refused(call(c, "apply_motion", { motion: "walk", animation: "w", map: { tail: "hips" } }))).toMatch(/There is no role "tail"/);
  });
});
