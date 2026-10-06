import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localBone, reexpress, drawOrderWith } from "@/agent/build";
import { AgentRefused, callTool } from "@/agent/host";
import { addBone, updateBone } from "@/edit/bones";
import { History } from "@/edit/history";
import { atlasImages, type AtlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Attachment, Skeleton } from "@/model/skeleton";
import { importPsd } from "@/ui/psdImport";
import { boneMatrix, boneTip, Poser } from "@/ui/stage/posed";
import { testContext } from "./fixtures/agentContext";
import { figureLayers, writeFigure } from "./fixtures/psd";

const figure = importPsd(writeFigure(figureLayers()), "figure.psd", "h");
const figImages = atlasImages(figure.atlas);
const STICK = join(__dirname, "fixtures", "stickman");
const stick = { doc: readSkeleton(readFileSync(join(STICK, "Stickman_IK.json"), "utf8")).skeleton, images: atlasImages(readAtlas(readFileSync(join(STICK, "Stickman_IK.atlas.txt"), "utf8"))) };
const ctxOf = (doc: Skeleton, images: AtlasImages) => testContext(new History(doc), images);
type Ctx = ReturnType<typeof ctxOf>;
const call = (c: Ctx, name: string, args: unknown) => callTool(name, args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };
const posed = (c: Ctx) => new Poser(c.history!.doc, c.images).pose(null, null, 0);
const joint = (c: Ctx, bone: string) => { const p = posed(c), m = boneMatrix(p, p.bones.get(bone)!); return [m[4], m[5]]; };
const tip = (c: Ctx, bone: string) => { const p = posed(c); return boneTip(p, p.bones.get(bone)!); };
/** Where every region's centre is in the world, by slot. */
function centres(c: Ctx): Record<string, [number, number]> {
  const p = posed(c), out: Record<string, [number, number]> = {};
  for (const s of c.history!.doc.slots ?? []) {
    const a = c.history!.doc.skins![0]!.attachments!.find((x) => x.slot === s.name)?.entries[0]?.attachment;
    if (!a || (a.type ?? "region") !== "region") continue;
    const m = boneMatrix(p, p.bones.get(s.bone)!);
    out[s.name] = [m[0] * (a.x ?? 0) + m[1] * (a.y ?? 0) + m[4], m[2] * (a.x ?? 0) + m[3] * (a.y ?? 0) + m[5]];
  }
  return out;
}
const close = (a: number[], b: number[], d = 0.05) => a.every((v, i) => Math.abs(v - b[i]!) <= d);

describe("the building tools (E5 step 5)", () => {
  it("places a bone from its joint and tip under any parent, and re-expresses a picture so it stays put", () => {
    // A turned, scaled, sheared parent.
    let s = addBone("p", "root", { x: 30, y: -10, rotation: 37, scaleX: 1.5, scaleY: 0.8, shearY: 12 })(figure.skeleton);
    const p0 = new Poser(s, figImages).pose(null, null, 0);
    const pm = boneMatrix(p0, p0.bones.get("p")!);
    s = addBone("b", "p", localBone([...pm], [10, 20], [60, 80]))(s);
    const p1 = new Poser(s, figImages).pose(null, null, 0), bm = boneMatrix(p1, p1.bones.get("b")!);
    expect(close([bm[4], bm[5]], [10, 20], 0.02)).toBe(true);
    expect(close(boneTip(p1, p1.bones.get("b")!), [60, 80], 0.05)).toBe(true);
    const region = { x: 5, y: 7, rotation: 20, width: 10, height: 10, extra: new Map() } as Attachment;
    const moved = reexpress(region, [...pm], [...bm]);
    const w0 = [pm[0] * 5 + pm[1] * 7 + pm[4], pm[2] * 5 + pm[3] * 7 + pm[5]];
    const w1 = [bm[0] * moved.x! + bm[1] * moved.y! + bm[4], bm[2] * moved.x! + bm[3] * moved.y! + bm[5]];
    expect(close(w1, w0, 0.02)).toBe(true);
    // a and b to the front of d, front first: the three take the places they held (0, 1, 3), back to front d, a, b.
    expect(drawOrderWith(["a", "b", "c", "d", "e"], [["a", "b"], ["d"]])).toEqual(["d", "a", "c", "b", "e"]);
    expect(drawOrderWith(["a", "b", "c", "d", "e"], [["d"], ["a", "b"]])).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("add_bones: joints and tips land where given, parents in the list first; one undo step; refusals", async () => {
    const c = ctxOf(figure.skeleton, figImages);
    const out = await call(c, "add_bones", { bones: [
      { name: "hips", from: [0, 140], to: [0, 160] },
      { name: "torso", parent: "hips", from: [0, 160], to: [0, 280] },
      { name: "head", parent: "torso", from: [0, 280], to: [0, 380] },
    ] });
    expect(out.bones.map((b: { name: string }) => b.name)).toEqual(["hips", "torso", "head"]);
    expect(close(joint(c, "head"), [0, 280])).toBe(true);
    expect(close(tip(c, "head"), [0, 380])).toBe(true);
    expect(c.history!.undoLabel).toBe("AI: add_bones hips, torso, head");
    expect(await refused(call(c, "add_bones", { bones: [{ name: "x", from: [0, 0] }] }))).toMatch(/both from and to/);
    expect(await refused(call(c, "add_bones", { bones: [{ name: "x", parent: "nope", from: [0, 0], to: [1, 1] }] }))).toMatch(/there is no bone "nope"/);
    // A refusal part-way takes the whole call back.
    expect(await refused(call(c, "add_bones", { bones: [{ name: "ok", from: [0, 0], to: [1, 1] }, { name: "head", from: [0, 0], to: [1, 1] }] }))).toMatch(/already a bone "head"/);
    expect(c.history!.doc.bones!.some((b) => b.name === "ok")).toBe(false);
  });

  it("attach: an atlas image placed by its pivot; a slot moved onto a bone staying where it is", async () => {
    const c = ctxOf(figure.skeleton, figImages);
    await call(c, "add_bones", { bones: [{ name: "neck", from: [0, 280], to: [0, 300] }] });
    const before = centres(c);
    const out = await call(c, "attach", { items: [{ bone: "neck", layer: "head", pivot: [45, 90] }, { bone: "neck", image: "body", name: "body2", pivot: [50, 0], at: [0, 280] }] });
    expect(out.attached).toEqual([{ slot: "head", bone: "neck" }, { slot: "body2", bone: "neck", image: "body" }]);
    expect(out.notes[0]).toMatch(/pivot is not used for a slot/);
    expect(c.history!.doc.slots!.find((s) => s.name === "head")!.bone).toBe("neck");
    expect(close(centres(c).head!, before.head!)).toBe(true);
    // The body picture's top-centre pixel (50, 0) sits at (0, 280): its centre 75 below.
    expect(close(centres(c).body2!, [0, 205])).toBe(true);
    // Drawn just in front of what the bone already held (head).
    const order = c.history!.doc.slots!.map((s) => s.name);
    expect(order.indexOf("body2")).toBe(order.indexOf("head") + 1);
    expect(await refused(call(c, "attach", { items: [{ bone: "neck", image: "nope" }] }))).toMatch(/no atlas image "nope"/);
  });

  it("add_ik: a two-bone chain with a target made at the tip, the setup pose unchanged; keyed bones refused", async () => {
    const c = ctxOf(figure.skeleton, figImages);
    await call(c, "add_bones", { bones: [{ name: "thigh", from: [-15, 150], to: [-12, 85] }, { name: "shin", parent: "thigh", from: [-12, 85], to: [-15, 25] }] });
    const shin0 = tip(c, "shin");
    const out = await call(c, "add_ik", { bone: "shin" });
    expect(out).toEqual({ ik: "shin_ik", bones: ["thigh", "shin"], target: "shin_target" });
    expect(close(tip(c, "shin"), shin0, 0.05)).toBe(true);
    expect(close(joint(c, "shin_target"), shin0, 0.05)).toBe(true);
    const k = testContext(new History(stick.doc), stick.images);
    // chest under hips: hips is keyed in run, so the chain cannot take an IK.
    expect(await refused(call(k, "add_ik", { bone: "chest" }))).toMatch(/"hips" has keys in/);
  });

  it("draw_order: named children move front first into their places; a bone carries its slots together", async () => {
    const c = ctxOf(figure.skeleton, figImages);
    await call(c, "add_bones", { bones: [{ name: "arms", from: [0, 200], to: [0, 210] }] });
    await call(c, "attach", { items: [{ bone: "arms", layer: "arm L" }, { bone: "arms", layer: "arm R" }] });
    const out = await call(c, "draw_order", { parent: "root", front: ["body", "arms"] });
    // The body now in front of both arms, the arms still together, everything else in place.
    const order = c.history!.doc.slots!.map((s) => s.name);
    expect(order.indexOf("body")).toBeGreaterThan(order.indexOf("arm R"));
    expect(Math.abs(order.indexOf("arm L") - order.indexOf("arm R"))).toBe(1);
    expect(out.order[0]).toBe("head");
    expect(await refused(call(c, "draw_order", { parent: "arms", front: ["body"] }))).toMatch(/not a child of "arms"/);
  });

  it("auto_rig: the figure rigged from its joints in one step, every picture on a bone and where it was, IK on the legs", async () => {
    const c = ctxOf(figure.skeleton, figImages);
    const before = centres(c);
    // The figure's joints, read off its layout (canvas 300 × 400; skeleton x = u − 150, y = 400 − v), front view.
    const joints = {
      pelvis: [0, 150], neck: [0, 280], head: [0, 380],
      "hip.left": [-15, 150], "knee.left": [-15, 85], "ankle.left": [-15, 25],
      "hip.right": [15, 150], "knee.right": [15, 85], "ankle.right": [15, 25],
      // The elbows a hair above the arm pictures' centres (y 210), as read on screen: the forearm fits a little better.
      "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
      "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
    };
    const out = await call(c, "auto_rig", { joints, view: "front" });
    expect(c.history!.undoLabel).toMatch(/^AI: auto_rig \d+ bones$/);
    // A slot is already called "head": the bone is "head_bone" (the motion library still reads it).
    expect(out.bones).toEqual(expect.arrayContaining(["hips", "torso", "head_bone", "thigh_left", "shin_left", "upper_arm_right", "forearm_right"]));
    const on = Object.fromEntries(out.attached.map((a: { slot: string; bone: string }) => [a.slot, a.bone]));
    expect(on).toMatchObject({ head: "head_bone", body: "torso" });
    // A limb drawn in one piece goes on its first bone, so the whole picture turns from the hip or shoulder.
    expect(on).toMatchObject({ "leg L": "thigh_left", "leg R": "thigh_right", "arm L": "upper_arm_left", "arm R": "upper_arm_right" });
    // Nothing moved: every picture where it was, the setup pose as drawn (IK solves to it).
    const after = centres(c);
    for (const [slot, at] of Object.entries(before)) expect(close(after[slot]!, at, 0.1), slot).toBe(true);
    expect(close(tip(c, "shin_left"), [-15, 25], 0.1)).toBe(true);
    expect(out.ik).toEqual(["shin_left_ik", "shin_right_ik"]);
    expect(await call(c, "undo", {})).toMatchObject({ undone: [expect.stringMatching(/^AI: auto_rig/)] });
    expect(c.history!.doc.bones!.length).toBe(figure.skeleton.bones!.length);
    expect(await refused(call(c, "auto_rig", { joints: { pelvis: [0, 0] } }))).toBe("auto_rig needs at least pelvis and neck.");
  });

  it("auto_rig settles each IK's bend: a bent knee stays as drawn; a straight one bends forward for the facing", async () => {
    // Side view facing right: the near knee drawn bent forward (+x), the far leg straight.
    const joints = { pelvis: [0, 150], neck: [0, 280], "hip.near": [0, 150], "knee.near": [18, 85], "ankle.near": [0, 25], "hip.far": [5, 150], "knee.far": [5, 85], "ankle.far": [5, 25] };
    for (const facing of ["right", "left"] as const) {
      const c = ctxOf(figure.skeleton, figImages);
      await call(c, "auto_rig", { joints: facing === "right" ? joints : Object.fromEntries(Object.entries(joints).map(([k, [x, y]]) => [k, [-x!, y]])), facing });
      const sx = facing === "right" ? 1 : -1;
      expect(close(joint(c, "shin_near"), [18 * sx, 85], 0.1), `${facing}: the bent knee as drawn`).toBe(true);
      // Pull the straight leg's target up: its knee goes forward (+x facing right, −x facing left).
      const t = c.history!.doc.bones!.find((b) => b.name === "shin_far_target")!;
      c.history!.apply("pull", updateBone("shin_far_target", { y: (t.y ?? 0) + 30 }));
      expect(Math.sign(joint(c, "shin_far")[0]! - 5 * sx), `${facing}: the straight knee bends forward`).toBe(sx);
    }
    // A knee drawn bending backward (a bird's) keeps its bend: the drawing wins over the facing.
    const c = ctxOf(figure.skeleton, figImages);
    await call(c, "auto_rig", { joints: { ...joints, "knee.near": [-18, 85] }, facing: "right" });
    expect(close(joint(c, "shin_near"), [-18, 85], 0.1)).toBe(true);
  });

  it("constraints: transform (every property following), its map, physics, a slider, their order; paths, boxes and points", async () => {
    const c = ctxOf(figure.skeleton, figImages);
    await call(c, "add_bones", { bones: [{ name: "a", from: [0, 0], to: [50, 0] }, { name: "b", from: [0, 100], to: [50, 100] }, { name: "c", parent: "b", from: [50, 100], to: [90, 100] }] });
    await call(c, "add_transform_constraint", { bones: ["b"], source: "a" });
    c.history!.apply("turn a", updateBone("a", { rotation: 30 }));
    const p = posed(c), am = boneMatrix(p, p.bones.get("a")!), bm = boneMatrix(p, p.bones.get("b")!);
    expect(close([bm[0], bm[2], bm[4], bm[5]], [am[0], am[2], am[4], am[5]], 1e-3)).toBe(true);
    expect((await call(c, "map_transform", { constraint: "b_transform", from: "rotate", to: "x", scale: 2 })).map.rotate.to).toEqual({ rotate: { scale: 1, offset: 0, max: 1 }, x: { scale: 2, offset: 0, max: 1 } });
    const removed = await call(c, "map_transform", { constraint: "b_transform", from: "shearY", to: "shearY", remove: true });
    expect(removed.map.shearY).toBeUndefined();
    expect((await call(c, "add_physics", { bone: "c", settings: { gravity: 50 } })).settings).toEqual({ rotate: 1, gravity: 50 });
    await call(c, "new_animation", { name: "dial", frames: 10 });
    expect(await call(c, "add_slider", { animation: "dial", bone: "a" })).toEqual({ constraint: "dial_slider", animation: "dial", bone: "a" });
    expect((await call(c, "set_constraint_order", { order: ["c_physics"] })).constraintOrder).toEqual(["c_physics", "b_transform", "dial_slider"]);
    const path = await call(c, "make_path", { bones: ["b", "c"] });
    expect(path).toEqual({ constraint: "b_path", slot: "b_path", points: 3 });
    // Spine reads what was written back the same.
    expect(writeSkeleton(readSkeleton(writeSkeleton(c.history!.doc)).skeleton)).toBe(writeSkeleton(c.history!.doc));
    const box = await call(c, "add_attachment", { kind: "box", on: "body" });
    const boxA = c.history!.doc.skins![0]!.attachments!.find((x) => x.slot === box.slot)!.entries[0]!.attachment;
    const body = c.history!.doc.skins![0]!.attachments!.find((x) => x.slot === "body")!.entries[0]!.attachment;
    expect(boxA.vertices).toEqual([(body.x ?? 0) - 50, body.y! + 75, (body.x ?? 0) + 50, body.y! + 75, (body.x ?? 0) + 50, body.y! - 75, (body.x ?? 0) - 50, body.y! - 75]);
    const pt = await call(c, "add_attachment", { kind: "point", on: "a", name: "muzzle" });
    expect(await call(c, "set_point", { point: pt.slot, x: 12, rotation: 45 })).toEqual({ point: "muzzle", slot: "muzzle", x: 12, y: 0, rotation: 45 });
  });
});
