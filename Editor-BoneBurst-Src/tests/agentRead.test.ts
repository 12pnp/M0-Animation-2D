import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRefused, callTool, IMAGES_KEY } from "@/agent/host";
import { addAnimation } from "@/edit/animations";
import { keyBone } from "@/edit/boneKeys";
import { PRESETS } from "@/edit/curves";
import { History } from "@/edit/history";
import { setCurve } from "@/edit/keys";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { boneNumber } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import { animationDuration, frameTime, timeFrame } from "@/model/timelines";
import { boneMatrix, boneTip, Poser } from "@/ui/stage/posed";
import { testContext } from "./fixtures/agentContext";

const DIR = join(__dirname, "fixtures", "stickman");
const doc0 = readSkeleton(readFileSync(join(DIR, "Stickman_IK.json"), "utf8")).skeleton;
const images = atlasImages(readAtlas(readFileSync(join(DIR, "Stickman_IK.atlas.txt"), "utf8")));
const setup = (doc: Skeleton) => new Poser(doc, images).pose(null, null, 0);
const ctxOf = (doc: Skeleton = doc0, refs: Parameters<typeof testContext>[2] = []) => testContext(new History(doc), images, refs);
const call = (name: string, args: unknown, c = ctxOf()) => callTool(name, args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };
/** run's length in frames: its latest key, whichever bone it is on. */
const RUN = timeFrame(animationDuration(doc0.animations!.find((a) => a.name === "run")!), 24);
const pose = (anim: string, frame: number) => new Poser(doc0, images).pose(null, anim, frameTime(frame, 24));

describe("the read tools (E5 step 3)", () => {
  it("get_rig: bones with setup and world, slots with where their pictures sit, images, skins, animations, what is shown", async () => {
    const rig = await call("get_rig", {});
    const p = setup(doc0);
    expect(rig.bones.map((b: { name: string }) => b.name)).toEqual(doc0.bones!.map((b) => b.name));
    const hips = rig.bones.find((b: { name: string }) => b.name === "hips"), hb = doc0.bones!.find((b) => b.name === "hips")!;
    expect(hips.setup).toMatchObject({ x: boneNumber(hb, "x"), y: boneNumber(hb, "y"), rotation: boneNumber(hb, "rotation") });
    const m = boneMatrix(p, p.bones.get("hips")!);
    expect(hips.world.x).toBeCloseTo(m[4], 2);
    expect(hips.world.y).toBeCloseTo(m[5], 2);
    // Each region's picture: its centre pixel, through the pivot and the world rotation, lands where the runtime puts the region.
    for (const s of rig.slots.filter((x: { kind?: string }) => x.kind === "region")) {
      const a = doc0.skins![0]!.attachments!.find((x) => x.slot === s.name)!.entries.find((e) => e.key === s.attachment)!.attachment;
      const bm = boneMatrix(p, p.bones.get(s.bone)!);
      const want = [bm[0] * (a.x ?? 0) + bm[1] * (a.y ?? 0) + bm[4], bm[2] * (a.x ?? 0) + bm[3] * (a.y ?? 0) + bm[5]];
      const r = (s.rotation * Math.PI) / 180, du = (s.size[0] / 2 - s.pivot[0]) * ((a.width ?? s.size[0]) / s.size[0]), dv = (s.pivot[1] - s.size[1] / 2) * ((a.height ?? s.size[1]) / s.size[1]);
      expect(s.at[0] + du * Math.cos(r) - dv * Math.sin(r)).toBeCloseTo(want[0]!, 1);
      expect(s.at[1] + du * Math.sin(r) + dv * Math.cos(r)).toBeCloseTo(want[1]!, 1);
    }
    expect(rig.images.length).toBe(images.regions.length);
    expect(rig.skins).toEqual(["default", "alt"]);
    expect(rig.animations).toEqual([{ name: "dance", frames: expect.any(Number) }, { name: "run", frames: RUN }]);
    expect(rig.fps).toBe(24);
    expect(rig.constraints.filter((c: { type: string }) => c.type === "ik").length).toBe(doc0.constraints!.filter((c) => c.type === "ik").length);
    expect(rig.shown).toEqual({ animation: null, frame: 0, skins: [] });
  });

  it("get_animation: absolute local values per key frame, eases by name, and the seam", async () => {
    const anim = await call("get_animation", { animation: "run" });
    expect(anim.frames).toBe(RUN);
    expect(RUN).toBe(17);
    const hb = doc0.bones!.find((b) => b.name === "hips")!;
    // Stored offsets (translate y -4, -10; rotate -4) read back added to the setup pose.
    expect(anim.bones.hips[0]).toMatchObject({ frame: 0, y: boneNumber(hb, "y") - 4, rotation: boneNumber(hb, "rotation") - 4, ease: "linear" });
    expect(anim.bones.hips[1]).toMatchObject({ frame: 2, y: boneNumber(hb, "y") - 10 });
    expect(anim.cycle).toBe(anim.seam.length === 0);
    // Eases: the presets read back by name; stepped as hold.
    // The hips' y changes from frame 0 to 2 (x stays put, a flat channel shows no ease); its rotate holds.
    let doc = setCurve("run", [{ path: { section: "bones", owner: "hips", timeline: "translate" }, time: 0 }], PRESETS.easeIn)(doc0);
    doc = setCurve("run", [{ path: { section: "bones", owner: "hips", timeline: "rotate" }, time: 0 }], "stepped")(doc);
    const eased = await call("get_animation", { animation: "run" }, ctxOf(doc));
    expect(eased.bones.hips[0]).toMatchObject({ ease: "linear", eases: { y: "in", rotation: "hold" } });
    expect(eased.bones.hips[0].eases.x).toBeUndefined();
    // A walk keyed differently at its two ends has a seam there; keyed alike, it is a cycle.
    const local = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
    let w = addAnimation("w")(doc0);
    w = keyBone("w", "hips", ["rotate"], { ...local, rotation: 0 }, 0)(w);
    w = keyBone("w", "hips", ["rotate"], { ...local, rotation: 30 }, frameTime(8, 24))(w);
    expect((await call("get_animation", { animation: "w" }, ctxOf(w))).seam).toContain("hips");
    w = keyBone("w", "hips", ["rotate"], { ...local, rotation: 30 }, 0)(w);
    expect(await call("get_animation", { animation: "w" }, ctxOf(w))).toMatchObject({ cycle: true, seam: [] });
    expect(await refused(call("get_animation", { animation: "fly" }))).toBe('There is no animation "fly"; the rig has dance, run.');
  });

  it("get_pose: each bone's world place as the runtime poses it, at a frame", async () => {
    const got = await call("get_pose", { animation: "run", frame: 5, bones: ["hips", "head"] });
    const p = pose("run", 5);
    for (const name of ["hips", "head"]) {
      const m = boneMatrix(p, p.bones.get(name)!);
      expect(got.bones[name].x).toBeCloseTo(m[4], 2);
      expect(got.bones[name].y).toBeCloseTo(m[5], 2);
      expect(got.bones[name].rotation).toBeCloseTo((Math.atan2(m[2], m[0]) * 180) / Math.PI, 2);
    }
    expect(Object.keys(got.bones)).toEqual(["hips", "head"]);
    expect(await refused(call("get_pose", { bones: ["tail"] }))).toBe('There is no bone "tail".');
  });

  it("show: the animation, frame and one skin; more skins, unknown ones and frames past the end refused", async () => {
    const c = ctxOf();
    expect(await call("show", { animation: "run", frame: 4, skins: ["alt"] }, c)).toEqual({ shown: { animation: "run", frame: 4, skins: ["alt"] } });
    expect(c.view()).toEqual({ animation: "run", frame: 4, skin: "alt" });
    await call("show", { animation: "dance", skins: [] }, c);
    expect(c.view()).toEqual({ animation: "dance", frame: 0, skin: null });
    expect(await refused(call("show", { animation: "run", skins: ["alt", "default"] }, c))).toMatch(/one skin over the default at a time/);
    expect(await refused(call("show", { animation: "run", skins: ["hat"] }, c))).toBe('There is no skin "hat"; the rig has default, alt.');
    expect(await refused(call("show", { animation: "run", frame: 99 }, c))).toBe('"run" is 17 frames long; show a frame from 0 to 17.');
  });

  it("get_reference: each still reference's place and pixel mapping; pictures when frames are asked", async () => {
    const refs = [{ path: "sketch.png", x: 10, y: 20, scale: 0.5, opacity: 0.4, width: 200, height: 100 }, { path: "gone.png", x: 0, y: 0, scale: 1, opacity: 1, width: null, height: null }];
    const r = await call("get_reference", { animation: "run" }, ctxOf(doc0, refs));
    expect(r.references[0]).toMatchObject({ path: "sketch.png", size: [200, 100], pixel: "pixel (u, v) is at (-40 + u·0.5, 45 − v·0.5)" });
    expect(r.references[1].missing).toMatch(/not opened/);
    expect(r[IMAGES_KEY]).toBeUndefined();
    const withPics = await call("get_reference", { animation: "run", frames: [0, 8] }, ctxOf(doc0, refs));
    expect(withPics[IMAGES_KEY]).toEqual([{ data: "png-of-sketch.png", mimeType: "image/png" }]);
  });

  it("render_frame: asks the editor for the frame, with each named bone's path over the animation and its keyed frames", async () => {
    const c = ctxOf();
    const out = await call("render_frame", { animation: "run", frame: 3, paths: ["hips"] }, c);
    const req = c.renders[0]!;
    expect(req).toMatchObject({ animation: "run", time: frameTime(3, 24), reference: true, bones: true });
    const path = req.paths[0]!;
    expect(path.points).toHaveLength(RUN + 1);
    const p = pose("run", 7), tip = boneTip(p, p.bones.get("hips")!);
    expect(path.points[7]![0]).toBeCloseTo(tip[0], 4);
    expect(path.points[7]![1]).toBeCloseTo(tip[1], 4);
    expect(path.keyed).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(out).toMatchObject({ size: [400, 300], mapping: { scale: 0.5, origin: [200, 250] }, [IMAGES_KEY]: [{ data: "png", mimeType: "image/png" }] });
    expect(await refused(call("render_frame", { paths: ["hips"] }))).toMatch(/paths needs an animation/);
  });
});
