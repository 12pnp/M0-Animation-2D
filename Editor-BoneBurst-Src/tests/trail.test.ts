import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { animationDuration, frameTime } from "@/model/timelines";
import { boneMatrix, boneTip, parentMatrix, Poser } from "@/ui/stage/posed";
import { boneTrail, fromParent, MAX_TRAIL_FRAMES } from "@/ui/stage/trail";

const dir = join(__dirname, "fixtures", "stickman");
const doc = readSkeleton(readFileSync(join(dir, "Stickman_IK.json"), "utf8")).skeleton;
const images = atlasImages(readAtlas(readFileSync(join(dir, "Stickman_IK.atlas.txt"), "utf8")));
const anim = doc.animations![0]!, duration = animationDuration(anim), fps = doc.header?.fps ?? 30;

describe("a bone's trail over an animation", () => {
  it("has a point for every frame, equal to the pose at that frame", () => {
    const poser = new Poser(doc, images), trail = boneTrail(poser, null, anim.name, "arm_near_2", fps, duration, "world")!;
    expect(trail.frames).toBe(Math.round(duration * fps));
    expect(trail.joint).toHaveLength((trail.frames + 1) * 2);
    for (const f of [0, 1, Math.floor(trail.frames / 2), trail.frames]) {
      const p = new Poser(doc, images).pose(null, anim.name, Math.fround(frameTime(f, fps)), "none"), i = p.bones.get("arm_near_2")!;
      const m = boneMatrix(p, i), [tx, ty] = boneTip(p, i);
      expect(trail.joint[f * 2]).toBeCloseTo(m[4], 6);
      expect(trail.joint[f * 2 + 1]).toBeCloseTo(m[5], 6);
      expect(trail.tip[f * 2]).toBeCloseTo(tx, 6);
      expect(trail.tip[f * 2 + 1]).toBeCloseTo(ty, 6);
    }
  });
  it("follows an IK-driven bone to where the constraint puts it, which its own keys do not say", () => {
    const ik = doc.constraints!.find((c) => c.type === "ik")!, bone = ik.bones![ik.bones!.length - 1]!;
    const trail = boneTrail(new Poser(doc, images), null, anim.name, bone, fps, duration, "world")!;
    // The trail moves, though an IK bone is rarely keyed itself.
    const xs = Array.from({ length: trail.frames + 1 }, (_, f) => trail.joint[f * 2]!);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);
    expect(xs.every(Number.isFinite)).toBe(true);
  });
  it("in Local is the world point with the parent's joint taken away: the world's orientation, the parent's movement out", () => {
    const poser = new Poser(doc, images), world = boneTrail(poser, null, anim.name, "head", fps, duration, "world")!, local = boneTrail(poser, null, anim.name, "head", fps, duration, "local")!;
    for (const f of [0, 3, local.frames]) {
      const p = poser.pose(null, anim.name, Math.fround(frameTime(f, fps)), "none"), i = p.bones.get("head")!, parent = parentMatrix(p, i);
      expect(local.joint[f * 2]).toBeCloseTo(world.joint[f * 2]! - parent[4], 6);
      expect(local.joint[f * 2 + 1]).toBeCloseTo(world.joint[f * 2 + 1]! - parent[5], 6);
      expect(local.tip[f * 2]).toBeCloseTo(world.tip[f * 2]! - parent[4], 6);
    }
    // The bone's own direction is the same in both: the tip minus the joint.
    expect(local.tip[8]! - local.joint[8]!).toBeCloseTo(world.tip[8]! - world.joint[8]!, 6);
    expect(local.tip[9]! - local.joint[9]!).toBeCloseTo(world.tip[9]! - world.joint[9]!, 6);
  });
  it("does not move when only the parent moves", () => {
    // A bone under a parent that moves: its Local trail is its own displacement from the parent's joint.
    const p0 = new Poser(doc, images).pose(null, anim.name, 0, "none"), i = p0.bones.get("head")!;
    const [x, y] = fromParent(p0, i, boneMatrix(p0, i)[4], boneMatrix(p0, i)[5]), parent = parentMatrix(p0, i);
    expect(x).toBeCloseTo(boneMatrix(p0, i)[4] - parent[4], 9);
    expect(y).toBeCloseTo(boneMatrix(p0, i)[5] - parent[5], 9);
  });
  it("is null for a bone the rig does not have, and is cut at the most frames", () => {
    expect(boneTrail(new Poser(doc, images), null, anim.name, "nope", fps, duration, "local")).toBeNull();
    expect(boneTrail(new Poser(doc, images), null, anim.name, "head", fps, 1e6, "world")!.frames).toBe(MAX_TRAIL_FRAMES);
  });
});
