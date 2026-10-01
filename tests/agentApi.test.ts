import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MixFrom, Physics, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import { Store } from "@/app/Store";
import { AGENT_TOOLS, AgentApi, AgentError, type AgentVision, type BoneMark, IMAGES_KEY } from "@/app/agent/AgentApi";
import type { AssetId } from "@/core/doc/ids";
import { SetAnimationReference } from "@/core/history/timelineCommands";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { atlasText } from "@/core/spine/atlas";
import { isImage, type Node, type Project, type SymbolItem } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { createAnimation } from "@/core/doc/defaults";
import { posedSymbol } from "@/core/spine/spinePose";
import { apply } from "@/core/math/Matrix2D";
import { pt } from "@/core/math/geom";
import { loadStickman } from "./fixtures/stickman";
import { importSpine } from "@/core/spine/importSpine";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";

/**
 * The AI's tools on the real stickman rig: values go in and come out in
 * Spine's conventions, each edit is one undo step, and the exported file
 * plays what was keyed.
 */

beforeEach(() => reseed());

async function setup() {
  const { project } = await loadStickman();
  const store = new Store(project);
  return { store, api: new AgentApi(store) };
}

/** The export, played by spine-core at a frame: each bone's local pose as
 *  animated (before constraints). */
function played(store: Store, animation: string, frame: number) {
  const exported = exportSpine(store.project);
  const images = exported.usedImages.map((id) => store.project.items[id]).filter(isImage);
  let y = 0;
  const atlas = atlasText([{ name: "p", imagePath: "p.png", width: 1024, height: 1024, scale: 1, regions: images.map((i) => {
    const r = { name: i.name, x: 0, y, width: i.width, height: i.height, offsetX: 0, offsetY: 0, originalWidth: i.width, originalHeight: i.height, rotated: false };
    y += i.height;
    return r;
  }) }]);
  const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlas))).readSkeletonData(JSON.parse(spineJson(exported.skeleton))));
  sk.setupPose();
  sk.data.findAnimation(animation)!.apply(sk, 0, frame / store.project.frameRate, false, null, 1, MixFrom.setup, false, false, false);
  sk.updateWorldTransform(Physics.none);
  return Object.assign((bone: string) => sk.findBone(bone)!.pose, { world: (bone: string) => sk.findBone(bone)!.appliedPose });
}

describe("the AI's tools", () => {
  it("are described once, with a schema each", () => {
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual([
      "get_rig", "get_animation", "get_pose", "new_animation", "set_keys", "delete_keys", "show", "undo", "redo", "check_preview",
      "get_reference", "render_frame", "add_bones", "attach", "add_ik", "draw_order",
    ]);
    for (const t of AGENT_TOOLS) expect(t.input_schema.type).toBe("object");
  });

  it("describe the rig in Spine's terms", async () => {
    const { api, store } = await setup();
    const rig = await api.call("get_rig") as { bones: Array<{ name: string; parent: string | null; setup: { y: number } }>; animations: Array<{ name: string }>; ik: unknown[]; fps: number };
    expect(rig.fps).toBe(store.project.frameRate);
    expect(rig.animations.map((a) => a.name)).toEqual(expect.arrayContaining(["dance", "run"]));
    expect(rig.ik.length).toBe(4);
    const names = rig.bones.map((b) => b.name);
    for (const b of rig.bones) if (b.parent) expect(names).toContain(b.parent);
  });

  it("key a new animation that the export plays, in one undo step", async () => {
    const { api, store } = await setup();
    const rig = await api.call("get_rig") as { bones: Array<{ name: string; parent: string | null }> };
    const bone = rig.bones.find((b) => b.parent)!.name;
    await api.call("new_animation", { name: "walk", frames: 24 });
    expect(store.history.undoLabel).toBe('AI: New Animation "walk"');
    expect((await api.call("get_rig") as { animations: Array<{ name: string; frames: number }> }).animations.find((a) => a.name === "walk")!.frames).toBe(24);
    const other = rig.bones.find((b) => b.parent && b.name !== bone)!.name;
    const before = store.history.position;
    await api.call("set_keys", { animation: "walk", keys: [
      { bone, frame: 0, rotation: 10, ease: "inout" },
      { bone, frame: 12, rotation: -20, y: 5, ease: "inout" },
      { bone, frame: 24, rotation: 10 },
      { bone: other, frame: 6, rotation: 4 },
    ] });
    // Two bones, one step.
    expect(store.history.position).toBe(before + 1);
    expect(store.history.undoLabel).toBe("AI: Set 4 keys");

    const anim = await api.call("get_animation", { animation: "walk" }) as { frames: number; bones: Record<string, Array<{ frame: number; rotation: number; y: number; ease: unknown }>> };
    expect(anim.frames).toBe(24);
    expect(anim.bones[bone]!.map((k) => [k.frame, k.rotation, k.ease])).toEqual([[0, 10, "inout"], [12, -20, "inout"], [24, 10, "linear"]]);

    const at = played(store, "walk", 12);
    expect(at(bone).rotation).toBeCloseTo(-20, 4);
    expect(at(bone).y).toBeCloseTo(5, 4);
    // The loop wraps at 24: the file lasts exactly 24 frames.
    const exported = exportSpine(store.project).skeleton.animations!.walk!;
    const times = Object.values(exported.bones!).flatMap((t) => Object.values(t).flatMap((keys) => (keys as Array<{ time?: number }>).map((k) => k.time ?? 0)));
    expect(Math.max(...times) * store.project.frameRate).toBeCloseTo(24, 4);

    await api.call("undo");
    expect(await api.call("get_animation", { animation: "walk" })).toMatchObject({ bones: {} });
    await api.call("redo");
    expect(Object.keys((await api.call("get_animation", { animation: "walk" }) as { bones: object }).bones).sort()).toEqual([bone, other].sort());
  });

  it("ease one property on its own, and read it back", async () => {
    const { api, store } = await setup();
    const bone = ((await api.call("get_rig")) as { bones: Array<{ name: string; parent: string | null }> }).bones.find((b) => b.parent)!.name;
    await api.call("new_animation", { name: "hop", frames: 12 });
    await api.call("set_keys", { animation: "hop", keys: [
      { bone, frame: 0, x: 0, y: 0, ease: "linear", eases: { y: "out" } },
      { bone, frame: 12, x: 12, y: 12 },
    ] });
    type Keys = { bones: Record<string, Array<{ frame: number; ease: unknown; eases?: unknown }>> };
    const k0 = () => ((api.call("get_animation", { animation: "hop" })) as Promise<Keys>).then((a) => a.bones[bone]![0]!);
    expect(await k0()).toMatchObject({ ease: "linear", eases: { y: "out" } });
    const at = played(store, "hop", 6);
    expect(at(bone).x).toBeCloseTo(6, 3);
    expect(at(bone).y).toBeGreaterThan(8);

    await expect(api.call("set_keys", { animation: "hop", keys: [{ bone, frame: 0, eases: { y: "hold" } }] })).rejects.toThrow(/whole key/);
    await expect(api.call("set_keys", { animation: "hop", keys: [{ bone, frame: 0, eases: { shear: "in" } }] })).rejects.toThrow(/no property "shear"/);
    await api.call("set_keys", { animation: "hop", keys: [{ bone, frame: 0, ease: "inout" }] });
    expect((await k0()).eases).toBeUndefined();
  });

  it("keep what a key leaves out, as the animation has it at that frame", async () => {
    const { api } = await setup();
    const dance = await api.call("get_animation", { animation: "dance" }) as { bones: Record<string, Array<{ frame: number; x: number; rotation: number }>> };
    const [bone, keys] = Object.entries(dance.bones).find(([, k]) => k.length >= 2)!;
    const mid = Math.floor((keys[0]!.frame + keys[1]!.frame) / 2);
    const pose0 = await api.call("get_animation", { animation: "dance" });
    await api.call("set_keys", { animation: "dance", keys: [{ bone, frame: mid, rotation: 33 }] });
    const after = (await api.call("get_animation", { animation: "dance" }) as { bones: Record<string, Array<{ frame: number; x: number; rotation: number }>> }).bones[bone]!;
    const k = after.find((x) => x.frame === mid)!;
    expect(k.rotation).toBe(33);
    // x is what the tween showed there, not the setup pose.
    const a = keys[0]!, b = keys[1]!;
    if (a.x !== b.x) expect(k.x).not.toBe(0);
    expect(pose0).not.toEqual(await api.call("get_animation", { animation: "dance" }));
  });

  it("read the pose the runtime draws, IK included", async () => {
    const { api, store } = await setup();
    const pose = await api.call("get_pose", { animation: "run", frame: 5 }) as { bones: Record<string, { x: number; y: number; rotation: number }> };
    const at = played(store, "run", 5);
    expect(Object.keys(pose.bones).length).toBeGreaterThan(5);
    const names = new Map(exportSpine(store.project).names);
    for (const [bone, v] of Object.entries(pose.bones)) {
      const id = Object.values(store.currentSymbol.nodes).find((n) => n.name === bone)!.id;
      const w = at.world(names.get(id)!);
      expect(v.x).toBeCloseTo(w.worldX, 1);
      expect(v.y).toBeCloseTo(w.worldY, 1);
      expect(v.rotation).toBeCloseTo((Math.atan2(w.c, w.a) * 180) / Math.PI, 1);
    }
  });

  it("delete keys, and say what a wrong call got wrong", async () => {
    const { api } = await setup();
    await api.call("new_animation", { name: "w", frames: 10 });
    const bone = ((await api.call("get_rig")) as { bones: Array<{ name: string }> }).bones[1]!.name;
    await api.call("set_keys", { animation: "w", keys: [{ bone, frame: 5, rotation: 3 }] });
    await api.call("delete_keys", { animation: "w", keys: [{ bone, frame: 5 }] });
    expect(((await api.call("get_animation", { animation: "w" })) as { bones: Record<string, Array<{ frame: number }>> }).bones[bone]!.map((k) => k.frame)).toEqual([0]);
    await expect(api.call("set_keys", { animation: "w", keys: [{ bone: "nope", frame: 1 }] })).rejects.toBeInstanceOf(AgentError);
    await expect(api.call("set_keys", { animation: "nope", keys: [{ bone, frame: 1 }] })).rejects.toThrow(/no animation/);
    await expect(api.call("new_animation", { name: "w", frames: 3 })).rejects.toThrow(/already/);
    await expect(api.call("set_keys", { animation: "w", keys: [{ bone, frame: 1, ease: "bouncy" }] })).rejects.toThrow(/Unknown ease/);
    await expect(api.call("check_preview", { animation: "w" })).rejects.toThrow(/Preview/);
  });

  const mix = sampleRigs().find((r) => r.name === "mix-and-match");
  it.skipIf(!mix)("list an opened rig's skins, and show chosen ones in one undo step", async () => {
    const { project } = importSpine(JSON.parse(mix!.json), mix!.name, imagesOf(mix!.atlas));
    const store = new Store(project);
    const api = new AgentApi(store);
    const rig = await api.call("get_rig") as { skins: string[]; showing: { skins: string[] }; animations: Array<{ name: string }> };
    expect(rig.skins).toContain("hair/pink");
    expect(rig.showing.skins).toEqual(["skin-base"]);
    const anim = rig.animations[0]!.name;
    expect(await api.call("show", { animation: anim, skins: ["hair/pink", "skin-base"] })).toMatchObject({ skins: ["skin-base", "hair/pink"] });
    expect(store.history.undoLabel).toBe("AI: Show Skins");
    await expect(api.call("show", { animation: anim, skins: ["hat"] })).rejects.toThrow(/no skin "hat"/);
    await api.call("undo");
    expect((await api.call("get_rig") as { showing: { skins: string[] } }).showing.skins).toEqual(["skin-base"]);
  });

  /** A stand-in for the page's canvases: records what it was asked to paint. */
  function fakeVision() {
    const renders: Array<{ frame: number; reference: boolean; bones: BoneMark[]; width: number; height: number }> = [];
    const images: string[] = [];
    const vision: AgentVision = {
      image: async (id, maxSide) => { images.push(`${id}@${maxSide}`); return { mimeType: "image/png", data: `IMG:${id}` }; },
      render: async (req) => {
        renders.push({ frame: req.frame, reference: req.reference, bones: req.bones, width: req.view.width, height: req.view.height });
        return { mimeType: "image/png", data: "RENDER" };
      },
    };
    return { vision, renders, images };
  }

  it("show the reference's timing, placement and images, and say plainly when there is none", async () => {
    const { store } = await setup();
    const fake = fakeVision();
    const api = new AgentApi(store, undefined, fake.vision);
    const anim = store.currentSymbol.animations.find((a) => a.name === "run")!;
    await expect(api.call("get_reference", { animation: "run" })).rejects.toThrow(/no reference/);
    store.apply(new SetAnimationReference(store.currentSymbolId, anim.id,
      { frames: ["r1", "r2", "r3"] as AssetId[], width: 100, height: 200, at: [2, 6, 10], hold: 4, start: 2, x: -50, y: -200, scale: 2 }));

    const rig = await api.call("get_rig") as { animations: Array<{ name: string; reference?: unknown }> };
    expect(rig.animations.find((a) => a.name === "run")!.reference).toEqual({ images: 3, frames: [2, 13] });

    const out = await api.call("get_reference", { animation: "run", frames: [0, 2, 7, 13, 14] }) as Record<string, unknown>;
    expect(out.keyFrames).toEqual([2, 6, 10]);
    expect(out.shown).toEqual([{ frame: 0, image: null }, { frame: 2, image: 1 }, { frame: 7, image: 2 }, { frame: 13, image: 3 }, { frame: 14, image: null }]);
    expect(out[IMAGES_KEY]).toEqual([{ mimeType: "image/png", data: "IMG:r1" }, { mimeType: "image/png", data: "IMG:r2" }, { mimeType: "image/png", data: "IMG:r3" }]);
    // Pixel (u, v) of the image in Spine's y-up space: its top-left is (-50, 200).
    expect(out.placement).toContain("x = -50 + u*2, y = 200 - v*2");
    await expect(api.call("get_reference", { animation: "run", frames: [1, 2, 3, 4, 5, 6, 7] })).rejects.toThrow(/At most 6/);
  });

  it("render a frame with each bone where get_pose puts it, over the reference when asked", async () => {
    const { store } = await setup();
    const fake = fakeVision();
    const api = new AgentApi(store, undefined, fake.vision);
    const anim = store.currentSymbol.animations.find((a) => a.name === "run")!;
    store.apply(new SetAnimationReference(store.currentSymbolId, anim.id,
      { frames: ["r1"] as AssetId[], width: 100, height: 200, at: [0], hold: 20, start: 0, x: -50, y: -200, scale: 2 }));

    const out = await api.call("render_frame", { animation: "run", frame: 5 }) as {
      size: number[]; mapping: string; bones: Record<string, { origin: number[] }>; reference: string; [IMAGES_KEY]: unknown[];
    };
    expect(out[IMAGES_KEY]).toEqual([{ mimeType: "image/png", data: "RENDER" }]);
    expect(Math.max(...out.size)).toBe(768);
    expect(out.reference).toMatch(/image 1/);
    expect(fake.renders[0]).toMatchObject({ frame: 5, reference: true });
    expect(fake.renders[0]!.bones.length).toBeGreaterThan(5);

    // The picture's mapping takes each bone's pixel back to get_pose's world.
    const [, x0, s1, y0, s2] = /x = (-?[\d.]+) \+ px\/([\d.]+), y = (-?[\d.]+) - py\/([\d.]+)/.exec(out.mapping)!.map(Number) as number[];
    const pose = await api.call("get_pose", { animation: "run", frame: 5 }) as { bones: Record<string, { x: number; y: number }> };
    for (const [name, b] of Object.entries(out.bones)) {
      expect(x0! + b.origin[0]! / s1!).toBeCloseTo(pose.bones[name]!.x, 0);
      expect(y0! - b.origin[1]! / s2!).toBeCloseTo(pose.bones[name]!.y, 0);
    }

    await api.call("render_frame", { animation: "run", frame: 30, bones: false });
    expect(fake.renders[1]).toMatchObject({ reference: false, bones: [] });
    await expect(new AgentApi(store).call("render_frame", { animation: "run", frame: 0 })).rejects.toBeInstanceOf(AgentError);
  });
});

describe("rigging through the AI's tools", () => {
  type Pose = { bones: Record<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }> };
  type Rig = { bones: Array<{ name: string; parent: string | null; length?: number }>; slots: unknown[]; ik: unknown[]; images: Array<{ name: string; width: number; height: number }> };

  /** The stickman's library, and a root symbol with nothing in it. */
  async function blank() {
    const { project } = await loadStickman();
    const original = new Store(project);
    const empty = structuredClone(project);
    Object.assign(empty.items[empty.rootSymbolId] as SymbolItem, { nodes: {}, layers: [], ik: [], animations: [createAnimation()] });
    const store = new Store(empty);
    return { original, store, api: new AgentApi(store) };
  }

  /** The calls a model would make to rebuild `sym` from its pictures, read
   *  off its setup pose in skeleton space. */
  function rebuildCalls(project: Project, sym: SymbolItem): Array<[string, Record<string, unknown>]> {
    const setup = posedSymbol(project, sym, null, 0, "setup");
    const world = (n: Node) => setup.byNode.get(n.id)!.world;
    const nameOf = (id: NodeId | null) => (id ? sym.nodes[id]!.name : undefined);
    const rows = sym.layers.map((l) => sym.nodes[l.nodeId]!);
    const calls: Array<[string, Record<string, unknown>]> = [];
    calls.push(["add_bones", { bones: rows.filter((n) => n.kind === "bone").map((n) => {
      const w = world(n), tip = apply(pt(), w, n.boneLength!, 0);
      return { name: n.name, ...(n.parentId ? { parent: nameOf(n.parentId) } : {}), from: [w.tx, -w.ty], to: [tip.x, -tip.y] };
    }) }]);
    calls.push(["attach", { items: rows.filter((n) => n.kind === "image").map((n) => {
      const w = world(n), item = project.items[n.itemId!]!;
      return { bone: nameOf(n.parentId), image: item.name, name: n.name, pivot: [n.pivot.x, n.pivot.y], at: [w.tx, -w.ty], rotation: (Math.atan2(-w.b, w.a) * 180) / Math.PI };
    }) }]);
    for (const parent of [null, ...rows.map((n) => n.id)]) {
      const children = rows.filter((n) => n.parentId === parent).map((n) => n.name);
      if (children.length > 1) calls.push(["draw_order", { ...(parent ? { parent: nameOf(parent) } : {}), front: children }]);
    }
    for (const k of sym.ik) calls.push(["add_ik", { bone: nameOf(k.boneId), target: nameOf(k.targetId), name: k.name, bendPositive: k.bendPositive, mix: k.weight }]);
    return calls;
  }

  const worstApart = (a: Pose, b: Pose) => {
    expect(Object.keys(b.bones).sort()).toEqual(Object.keys(a.bones).sort());
    let worst = 0;
    for (const [name, p] of Object.entries(a.bones)) {
      const q = b.bones[name]!;
      worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y), Math.abs(((p.rotation - q.rotation + 540) % 360) - 180), Math.abs(p.scaleX - q.scaleX), Math.abs(p.scaleY - q.scaleY));
    }
    return worst;
  };

  it("rebuild the stickman from its pictures: same rig, same setup pose, one undo step a call", async () => {
    const { original, store, api } = await blank();
    const calls = rebuildCalls(original.project, original.currentSymbol);
    for (const [tool, args] of calls) {
      const before = store.history.position;
      await api.call(tool, args);
      expect(store.history.position).toBe(before + 1);
      expect(store.history.undoLabel).toMatch(/^AI: /);
    }
    const a = await new AgentApi(original).call("get_rig") as Rig, b = await api.call("get_rig") as Rig;
    expect(b.bones.map(({ name, parent }) => ({ name, parent }))).toEqual(a.bones.map(({ name, parent }) => ({ name, parent })));
    expect(b.slots).toEqual(a.slots);
    expect(b.ik).toEqual(a.ik);
    expect(b.images.map((i) => i.name)).toContain("head");
    expect(worstApart(await new AgentApi(original).call("get_pose") as Pose, await api.call("get_pose") as Pose)).toBeLessThan(0.02);

    // Each call takes back whole.
    for (let i = calls.length; i > 0; i--) store.undo();
    expect(Object.keys(store.currentSymbol.nodes)).toEqual([]);
    expect(store.currentSymbol.ik).toEqual([]);
  });

  it("animate the rebuilt rig as the original animates, and the export plays it", async () => {
    const { original, store, api } = await blank();
    for (const [tool, args] of rebuildCalls(original.project, original.currentSymbol)) await api.call(tool, args);
    const from = new AgentApi(original);
    for (const name of ["run", "dance"]) {
      type Anim = { frames: number; bones: Record<string, Array<Record<string, unknown>>> };
      const anim = await from.call("get_animation", { animation: name }) as Anim;
      await api.call("new_animation", { name, frames: anim.frames });
      await api.call("set_keys", { animation: name, keys: Object.entries(anim.bones).flatMap(([bone, keys]) => keys.map((k) => ({ bone, ...k }))) });
      const names = new Map(exportSpine(store.project).names);
      for (let f = 0; f <= anim.frames; f += 3) {
        const want = await from.call("get_pose", { animation: name, frame: f }) as Pose;
        const got = await api.call("get_pose", { animation: name, frame: f }) as Pose;
        expect(worstApart(want, got), `${name} frame ${f}`).toBeLessThan(0.02);
        const runtime = played(store, name, f);
        for (const [bone, v] of Object.entries(got.bones)) {
          const id = Object.values(store.currentSymbol.nodes).find((n) => n.name === bone)!.id;
          const w = runtime.world(names.get(id)!);
          expect(Math.hypot(v.x - w.worldX, v.y - w.worldY), `${bone} in ${name} at ${f}`).toBeLessThan(0.01);
        }
      }
    }
  });

  it("place a picture upright on a turned bone, at its joint by default", async () => {
    const { store, api } = await blank();
    await api.call("add_bones", { bones: [{ name: "arm", from: [0, 100], to: [0, 40] }] });
    await api.call("attach", { items: [{ bone: "arm", image: "head", pivot: [0, 0] }] });
    const pose = await api.call("get_pose") as Pose;
    expect(pose.bones.arm).toMatchObject({ x: 0, y: 100, rotation: -90 });
    expect(pose.bones.head).toMatchObject({ x: 0, y: 100, rotation: 0 });
    // Turning the bone turns the picture with it.
    await api.call("new_animation", { name: "swing", frames: 10 });
    await api.call("set_keys", { animation: "swing", keys: [{ bone: "arm", frame: 5, rotation: 0 }] });
    expect((await api.call("get_pose", { animation: "swing", frame: 5 }) as Pose).bones.head!.rotation).toBeCloseTo(90, 2);
    expect(store.history.position).toBe(4);
  });

  it("make an IK target at the tip, and key it rather than the chain", async () => {
    const { api } = await blank();
    await api.call("add_bones", { bones: [
      { name: "thigh", from: [0, 100], to: [0, 50] },
      { name: "shin", parent: "thigh", from: [0, 50], to: [0, 0] },
    ] });
    const ik = await api.call("add_ik", { bone: "shin" }) as { bones: string[]; target: string; created?: string };
    expect(ik).toMatchObject({ bones: ["thigh", "shin"], target: "shin_target", created: "shin_target" });
    expect((await api.call("get_pose") as Pose).bones.shin_target).toMatchObject({ x: 0, y: 0 });
    await api.call("new_animation", { name: "kick", frames: 10 });
    await api.call("set_keys", { animation: "kick", keys: [{ bone: "shin_target", frame: 5, x: 40, y: 40 }] });
    const kick = (await api.call("get_pose", { animation: "kick", frame: 5 }) as Pose).bones;
    // Two 50-long bones reaching (40, 40) from (0, 100): the shin's tip is there.
    const r = (kick.shin!.rotation * Math.PI) / 180;
    expect(kick.shin!.x + 50 * Math.cos(r)).toBeCloseTo(40, 1);
    expect(kick.shin!.y + 50 * Math.sin(r)).toBeCloseTo(40, 1);
  });

  it("refuse a wrong call whole, saying what is wrong", async () => {
    const { store, api } = await blank();
    await api.call("add_bones", { bones: [{ name: "hips", from: [0, 0], to: [0, 20] }, { name: "leg", parent: "hips", length: 30, rotation: -90 }] });
    const position = store.history.position;
    const refused = async (tool: string, args: Record<string, unknown>, message: RegExp) => {
      await expect(api.call(tool, args)).rejects.toThrow(message);
      expect(store.history.position).toBe(position);
    };
    await refused("add_bones", { bones: [{ name: "a", from: [0, 0], to: [1, 0] }, { name: "hips", length: 3 }] }, /"hips" is taken/);
    await refused("add_bones", { bones: [{ name: "b", parent: "c", length: 3 }, { name: "c", length: 3 }] }, /no bone "c"/);
    await refused("add_bones", { bones: [{ name: "b", from: [0, 0], to: [0, 0] }] }, /same point/);
    await refused("add_bones", { bones: [{ name: "b" }] }, /length above 0/);
    await refused("attach", { items: [{ bone: "hips", image: "head" }, { bone: "leg", image: "nope" }] }, /no picture "nope"/);
    await refused("attach", { items: [{ bone: "hips", image: "head" }, { bone: "leg", image: "head" }] }, /"head" is taken/);
    await refused("attach", { items: [{ bone: "hips" }] }, /either image/);
    await refused("draw_order", { parent: "hips", front: ["hips"] }, /not a child of "hips"/);
    await refused("add_ik", { bone: "leg", target: "leg" }, /in the chain/);
    await api.call("new_animation", { name: "w", frames: 4 });
    await api.call("set_keys", { animation: "w", keys: [{ bone: "leg", frame: 2, rotation: 10 }] });
    await expect(api.call("add_ik", { bone: "leg" })).rejects.toThrow(/"leg" has keys in "w"/);
  });
});
