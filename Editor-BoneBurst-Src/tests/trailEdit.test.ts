import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyBone, type LocalPose } from "@/edit/boneKeys";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { animationDuration, frameTime } from "@/model/timelines";
import { animatedLocal, boneMatrix, parentMatrix, Poser } from "@/ui/stage/posed";
import { boneTrail } from "@/ui/stage/trail";
import { axisLocked, constraintDriving, shiftedLocal } from "@/ui/stage/trailEdit";

const dir = join(__dirname, "fixtures", "stickman");
const doc = readSkeleton(readFileSync(join(dir, "Stickman_IK.json"), "utf8")).skeleton;
const images = atlasImages(readAtlas(readFileSync(join(dir, "Stickman_IK.atlas.txt"), "utf8")));
const anim = doc.animations![0]!, fps = doc.header?.fps ?? 30;

describe("which bones a constraint drives", () => {
  it("names the chain bones of an IK constraint, and not its target", () => {
    const ik = doc.constraints!.find((c) => c.type === "ik")!;
    for (const b of ik.bones!) expect(constraintDriving(doc, b)?.name).toBe(ik.name);
    expect(constraintDriving(doc, ik.bones![0]!)?.target).toBe(ik.target);
    expect(constraintDriving(doc, ik.target!)).toBeNull();
  });
  it("leaves a free bone alone", () => {
    const driven = new Set((doc.constraints ?? []).flatMap((c) => ("bones" in c && c.bones ? c.bones : [])));
    const free = doc.bones!.find((b) => !driven.has(b.name))!;
    expect(constraintDriving(doc, free.name)).toBeNull();
  });
});

describe("moving a joint by dragging its mark", () => {
  // A free bone with a parent, at a frame: the key written from the shift puts the joint where the shift says, in the world.
  const bone = "head", frame = 2;
  const posedAt = (d: typeof doc, f: number) => new Poser(d, images).pose(null, anim.name, Math.fround(frameTime(f, fps)), "none");
  it("lands the joint on the shifted world point, whatever the parent's turn and scale", () => {
    const p = posedAt(doc, frame), i = p.bones.get(bone)!, from = animatedLocal(p, i), parent = parentMatrix(p, i);
    const before = boneMatrix(p, i);
    const [dx, dy] = [12.5, -7.25];
    const next = { ...from, ...shiftedLocal(parent, from, dx, dy) } as LocalPose;
    const edited = keyBone(anim.name, bone, ["translate"], next, frameTime(frame, fps))(doc);
    const q = posedAt(edited, frame), m = boneMatrix(q, q.bones.get(bone)!);
    expect(m[4] - before[4]).toBeCloseTo(dx, 1);
    expect(m[5] - before[5]).toBeCloseTo(dy, 1);
  });
  it("keeps the duration: a key at an existing frame does not lengthen the animation", () => {
    const p = posedAt(doc, frame), i = p.bones.get(bone)!, from = animatedLocal(p, i);
    const edited = keyBone(anim.name, bone, ["translate"], { ...from, ...shiftedLocal(parentMatrix(p, i), from, 1, 1) } as LocalPose, frameTime(frame, fps))(doc);
    expect(animationDuration(edited.animations!.find((a) => a.name === anim.name)!)).toBe(animationDuration(anim));
  });
  it("a trail in Local moves by the same shift as in World, with the parent held", () => {
    const p = posedAt(doc, frame), i = p.bones.get(bone)!, from = animatedLocal(p, i), parent = parentMatrix(p, i);
    const edited = keyBone(anim.name, bone, ["translate"], { ...from, ...shiftedLocal(parent, from, 6, 3) } as LocalPose, frameTime(frame, fps))(doc);
    const dur = animationDuration(anim);
    const w0 = boneTrail(new Poser(doc, images), null, anim.name, bone, fps, dur, "world")!, w1 = boneTrail(new Poser(edited, images), null, anim.name, bone, fps, dur, "world")!;
    const l0 = boneTrail(new Poser(doc, images), null, anim.name, bone, fps, dur, "local")!, l1 = boneTrail(new Poser(edited, images), null, anim.name, bone, fps, dur, "local")!;
    expect(l1.joint[frame * 2]! - l0.joint[frame * 2]!).toBeCloseTo(w1.joint[frame * 2]! - w0.joint[frame * 2]!, 6);
    expect(l1.joint[frame * 2]! - l0.joint[frame * 2]!).toBeCloseTo(6, 1);
  });
});

describe("a shift held to an axis", () => {
  it("keeps the larger part", () => {
    expect(axisLocked(5, 2)).toEqual([5, 0]);
    expect(axisLocked(-1, -4)).toEqual([0, -4]);
  });
});
