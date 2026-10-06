import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRefused, callTool } from "@/agent/host";
import { History } from "@/edit/history";
import { atlasImages, type AtlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { boneNumber } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import { frameTime } from "@/model/timelines";
import { Poser } from "@/ui/stage/posed";
import { testContext } from "./fixtures/agentContext";
import { SAMPLES } from "./fixtures/samples";

const STICK = join(__dirname, "fixtures", "stickman");
const sample = (dir: string, file: string): { doc: Skeleton; images: AtlasImages } => {
  const atlas = readdirSync(dir).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
  return { doc: readSkeleton(readFileSync(join(dir, file), "utf8")).skeleton, images: atlasImages(readAtlas(atlas)) };
};
const stick = sample(STICK, "Stickman_IK.json");
const ctxOf = (s = stick) => testContext(new History(s.doc), s.images);
type Ctx = ReturnType<typeof ctxOf>;
const call = (c: Ctx, name: string, args: unknown) => callTool(name, args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };
const hips = stick.doc.bones!.find((b) => b.name === "hips")!;

describe("the key tools (E5 step 4)", () => {
  it("new_animation and set_keys: absolute values, left-out values from the pose, eases per key and per property, one undo step", async () => {
    const c = ctxOf();
    expect(await call(c, "new_animation", { name: "walk", frames: 16 })).toMatchObject({ animation: "walk", note: expect.stringContaining("key frame 16") });
    const out = await call(c, "set_keys", { animation: "walk", keys: [
      { bone: "hips", frame: 0, rotation: 80, ease: "inout" },
      { bone: "hips", frame: 8, rotation: 95, y: -390, eases: { y: "out" } },
      { bone: "hips", frame: 16, rotation: 80, y: -400, ease: "inout" },
      { bone: "chest", frame: 0, rotation: 5, ease: "hold" },
      { bone: "chest", frame: 8, rotation: -5 },
      { bone: "head", frame: 8, x: 12 },
      { bone: "head", frame: 8, y: 3 },
    ] });
    // The last hips key's ease has nothing after it: said, not kept.
    expect(out).toMatchObject({ animation: "walk", keyed: 6, bones: ["hips", "chest", "head"], frames: 16, note: expect.stringContaining("(hips at frame 16)") });
    expect(c.history!.undoLabel).toBe("AI: set_keys 6 keys in walk");
    const anim = await call(c, "get_animation", { animation: "walk" });
    expect(anim.bones.hips).toEqual([
      { frame: 0, rotation: 80, ease: "inout" },
      // y keyed here; x left out takes the value there (the setup pose), straight in x, easing out in y.
      { frame: 8, rotation: 95, x: boneNumber(hips, "x"), y: -390, ease: "linear", eases: { y: "out" } },
      { frame: 16, rotation: 80, x: boneNumber(hips, "x"), y: -400, ease: "linear" },
    ]);
    expect(anim.bones.chest[0]).toMatchObject({ frame: 0, ease: "hold" });
    // Two keys on one bone and frame merge into one.
    expect(anim.bones.head).toEqual([{ frame: 8, x: 12, y: 3, ease: "linear" }]);
    // The runtime plays what was keyed.
    const p = new Poser(c.history!.doc, stick.images).pose(null, "walk", frameTime(8, 24));
    expect(p.local[p.bones.get("hips")! * 7 + 2]).toBeCloseTo(95, 3);
    expect(await call(c, "undo", {})).toEqual({ undone: ["AI: set_keys 6 keys in walk"] });
    expect(c.history!.doc.animations!.find((a) => a.name === "walk")!.bones).toBeUndefined();
    expect(await refused(call(c, "set_keys", { animation: "walk", keys: [{ bone: "tail", frame: 0, x: 1 }] }))).toBe('There is no bone "tail".');
    expect(await refused(call(c, "set_keys", { animation: "walk", keys: [{ bone: "hips", frame: 0 }] }))).toMatch(/sets nothing/);
  });

  it("set_keys' named eases are version 1's curves (E6 step 2, measured by running the old editor): handles at thirds", async () => {
    const c = ctxOf();
    await call(c, "new_animation", { name: "e", frames: 30 });
    await call(c, "set_keys", { animation: "e", keys: [
      { bone: "head", frame: 0, rotation: 0, ease: "in" }, { bone: "head", frame: 12, rotation: 30, ease: "out" },
      { bone: "head", frame: 24, rotation: 0, ease: "inout" }, { bone: "head", frame: 36, rotation: 30 },
    ] });
    const keys = c.history!.doc.animations!.find((a) => a.name === "e")!.bones!.find((g) => g.name === "head")!.timelines[0]!.keys;
    const setup = boneNumber(stick.doc.bones!.find((b) => b.name === "head")!, "rotation");
    // Each curve as a share of its interval: [x1, y1, x2, y2].
    const shape = (i: number) => {
      const k = keys[i]!, n = keys[i + 1]!, t0 = k.time ?? 0, t1 = n.time!, v0 = (k.value ?? 0) + setup, v1 = (n.value ?? 0) + setup, cv = k.curve as number[];
      return [(cv[0]! - t0) / (t1 - t0), (cv[1]! + setup - v0) / (v1 - v0), (cv[2]! - t0) / (t1 - t0), (cv[3]! + setup - v0) / (v1 - v0)].map((x) => Math.round(x * 1000) / 1000);
    };
    expect([shape(0), shape(1), shape(2)]).toEqual([[0.333, 0, 0.667, 0.333], [0.333, 0.667, 0.667, 1], [0.333, 0, 0.667, 1]]);
  });

  it("set_keys between existing keys keeps what the animation had there; delete_keys and key_properties", async () => {
    const c = ctxOf();
    const before = (await call(c, "get_pose", { animation: "run", frame: 3, bones: ["hips"] })).bones.hips;
    await call(c, "set_keys", { animation: "run", keys: [{ bone: "hips", frame: 3, rotation: 70 }] });
    const k = (await call(c, "get_animation", { animation: "run" })).bones.hips.find((x: { frame: number }) => x.frame === 3);
    expect(k.rotation).toBe(70);
    expect((await call(c, "get_pose", { animation: "run", frame: 3, bones: ["hips"] })).bones.hips.y).toBeCloseTo(before.y, 2);
    // x alone between keys: the key's y is the animation's y there (−413 between −410 and −416), not the setup's.
    await call(c, "set_keys", { animation: "run", keys: [{ bone: "hips", frame: 3, x: 410 }] });
    const k3 = (await call(c, "get_animation", { animation: "run" })).bones.hips.find((x: { frame: number }) => x.frame === 3);
    expect(k3).toMatchObject({ x: 410, y: -413 });
    const del = await call(c, "delete_keys", { animation: "run", keys: [{ bone: "hips", frame: 3 }, { bone: "head", frame: 3 }] });
    expect(del).toMatchObject({ deleted: 2, missing: ["head at frame 3"] });
    expect(await refused(call(c, "delete_keys", { animation: "run", keys: [{ bone: "head", frame: 3 }] }))).toMatch(/No key to delete/);
    // Pin hips at frame 3: only what differs from the setup pose (its translate and rotate keys play there).
    const pinned = await call(c, "key_properties", { animation: "run", frame: 3, layers: ["hips"] });
    expect(pinned.keyed.hips.sort()).toEqual(["rotate", "translate"]);
    expect((await call(c, "get_pose", { animation: "run", frame: 3, bones: ["hips"] })).bones.hips.y).toBeCloseTo(before.y, 2);
  });

  it("key_ik: given values keyed, the rest at their values in force, eased; deleted", async () => {
    const c = ctxOf(), con = stick.doc.constraints!.find((k) => k.type === "ik")!, ik = con.name;
    const bend = (con as { bendPositive?: boolean }).bendPositive ?? true;
    // Eased while it is the last key: said, not kept; eased again once frame 10 exists: kept.
    expect((await call(c, "key_ik", { animation: "run", ik, frame: 4, mix: 0.5, ease: "smooth" })).note).toMatch(/last key/);
    await call(c, "key_ik", { animation: "run", ik, frame: 10, mix: 1, bendPositive: !bend });
    expect((await call(c, "key_ik", { animation: "run", ik, frame: 4, ease: "smooth" })).note).toBeUndefined();
    const list = (await call(c, "get_animation", { animation: "run" })).ik.find((x: { ik: string }) => x.ik === ik);
    // bendPositive left out keys the value in force there: the constraint's own.
    expect(list.keys).toEqual([
      { frame: 4, mix: 0.5, bendPositive: bend, softness: 0, ease: "smooth" },
      { frame: 10, mix: 1, bendPositive: !bend, softness: 0, ease: "linear" },
    ]);
    await call(c, "key_ik", { animation: "run", ik, frame: 4, delete: true });
    expect((await call(c, "get_animation", { animation: "run" })).ik.find((x: { ik: string }) => x.ik === ik).keys).toHaveLength(1);
    expect(await refused(call(c, "key_ik", { animation: "run", ik: "nope", frame: 1, mix: 0 }))).toMatch(/There is no ik constraint "nope"/);
  });

  it("key_transform and key_constraint on Stretchyman's transform and path constraints; physics on Celestial Circus", async () => {
    const s = sample(join(SAMPLES, "Stretchyman"), "stretchyman.json");
    const c = testContext(new History(s.doc), s.images);
    const anim = s.doc.animations![0]!.name, tr = s.doc.constraints!.find((k) => k.type === "transform")!.name, path = s.doc.constraints!.find((k) => k.type === "path")!.name;
    await call(c, "key_transform", { animation: anim, constraint: tr, frame: 2, mix: { rotate: 0.25, y: 0.5 } });
    const t = (await call(c, "get_animation", { animation: anim })).transforms.find((x: { constraint: string }) => x.constraint === tr);
    expect(t.keys.find((k: { frame: number }) => k.frame === 2).mix).toMatchObject({ rotate: 0.25, y: 0.5 });
    expect(await refused(call(c, "key_transform", { animation: anim, constraint: tr, frame: 2, mix: { spin: 1 } }))).toMatch(/mix.spin is not a mix/);
    await call(c, "key_constraint", { animation: anim, constraint: path, channel: "mix", frame: 3, value: 0.4 });
    const pk = (await call(c, "get_animation", { animation: anim })).constraints.find((x: { constraint: string; channel: string }) => x.constraint === path && x.channel === "mix");
    expect(pk.keys.find((k: { frame: number }) => k.frame === 3).value).toBe(0.4);
    const key = c.history!.doc.animations!.find((a) => a.name === anim)!.path!.find((g) => g.name === path)!.timelines.find((x) => x.name === "mix")!.keys.find((k) => Math.abs((k.time ?? 0) - frameTime(3, 30)) < 1e-5)!;
    // mixY left out means mixX (Spine's default), as written.
    expect([key.mixRotate, key.mixX, key.mixY ?? key.mixX]).toEqual([0.4, 0.4, 0.4]);
    expect(await refused(call(c, "key_constraint", { animation: anim, constraint: path, channel: "gravity", frame: 0, value: 1 }))).toBe("A path constraint keys position, spacing, mix, not gravity.");
    const cc = sample(join(SAMPLES, "celestial-circus"), "celestial-circus-pro.json");
    const c2 = testContext(new History(cc.doc), cc.images);
    const ph = cc.doc.constraints!.find((k) => k.type === "physics")!.name, a2 = cc.doc.animations![0]!.name;
    await call(c2, "key_constraint", { animation: a2, constraint: ph, channel: "gravity", frame: 5, value: 120, ease: "stepped" });
    const g = (await call(c2, "get_animation", { animation: a2 })).constraints.find((x: { constraint: string; channel: string }) => x.constraint === ph && x.channel === "gravity");
    expect(g.keys.find((k: { frame: number }) => k.frame === 5)).toMatchObject({ value: 120 });
  });

  it("key_draw_order: slots or a bone's slots moved front first into their places; setup; get_animation's drawOrder", async () => {
    const c = ctxOf(), slots = stick.doc.slots!.map((s) => s.name);
    const [back, , , , front] = [slots[0]!, slots[1]!, slots[2]!, slots[3]!, slots.at(-1)!];
    const out = await call(c, "key_draw_order", { animation: "run", frame: 5, front: [back, front] });
    expect(out.front[0]).toBe(back);
    expect(out.front.at(-1)).toBe(front);
    // run has a draw order key of its own at frame 17 (back to the setup order).
    expect((await call(c, "get_animation", { animation: "run" })).drawOrder).toEqual([{ frame: 5, front: out.front }, { frame: 17, setup: true }]);
    await call(c, "key_draw_order", { animation: "run", frame: 9, setup: true });
    expect((await call(c, "get_animation", { animation: "run" })).drawOrder).toContainEqual({ frame: 9, setup: true });
    const bone = stick.doc.slots!.find((s) => s.name === back)!.bone;
    expect((await call(c, "key_draw_order", { animation: "run", frame: 12, front: [bone] })).front).toContain(back);
    expect(await refused(call(c, "key_draw_order", { animation: "run", frame: 1, front: ["ghost"] }))).toBe('There is no slot or bone "ghost".');
    // What was written plays: Spine reads the offsets back as the same order.
    expect(writeSkeleton(readSkeleton(writeSkeleton(c.history!.doc)).skeleton)).toBe(writeSkeleton(c.history!.doc));
  });

  it("define_event and key_event; set_inherit on the bone and keyed", async () => {
    const c = ctxOf();
    expect((await call(c, "define_event", { name: "step", int: 2, audio: "step.wav", volume: 0.5 })).event).toEqual({ name: "step", int: 2, float: 0, string: "", audio: "step.wav", volume: 0.5, balance: 0 });
    await call(c, "key_event", { animation: "run", frame: 4, event: "step" });
    await call(c, "key_event", { animation: "run", frame: 4, event: "step", volume: 0.2 });
    await call(c, "define_event", { name: "step", rename: "footstep" });
    expect((await call(c, "get_animation", { animation: "run" })).events).toEqual([{ frame: 4, event: "footstep" }, { frame: 4, event: "footstep", volume: 0.2 }]);
    await call(c, "key_event", { animation: "run", frame: 4, event: "footstep", delete: true });
    expect((await call(c, "get_animation", { animation: "run" })).events).toBeUndefined();
    await call(c, "set_inherit", { bone: "head", inherit: "onlyTranslation" });
    expect(c.history!.doc.bones!.find((b) => b.name === "head")!.inherit).toBe("onlyTranslation");
    await call(c, "set_inherit", { bone: "head", inherit: "noScale", animation: "run", frame: 6 });
    const tl = c.history!.doc.animations!.find((a) => a.name === "run")!.bones!.find((g) => g.name === "head")!.timelines.find((t) => t.name === "inherit")!;
    expect(tl.keys).toEqual([expect.objectContaining({ inherit: "noScale" })]);
    expect(await refused(call(c, "set_inherit", { bone: "head", inherit: "noScale", animation: "run" }))).toMatch(/needs `frame`/);
  });
});
