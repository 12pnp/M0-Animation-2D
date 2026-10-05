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
import { createAnimation, createLayer, createNode } from "@/core/doc/defaults";
import { fromMatrix, tf } from "@/core/math/Transform";
import { buildFlatPsdImport } from "@/core/doc/psdImport";
import { AddLibraryItem, AddNode } from "@/core/history/commands";
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
      "get_reference", "render_frame", "add_bones", "attach", "add_ik", "auto_rig", "list_motions", "apply_motion", "draw_order",
      "key_draw_order", "key_ik", "define_event", "key_event", "add_transform_constraint", "key_transform", "make_mesh", "bind_mesh", "set_cycle", "get_bone_path", "set_bone_path",
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
    // Far-side bones are marked so the picture can tell overlapping limbs apart.
    const side = (n: string) => fake.renders[0]!.bones.find((b) => b.name === n)!.side;
    expect([side("leg_far_thigh"), side("arm_near_up"), side("hips")]).toEqual(["far", "near", undefined]);
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

  it("render poses over the reference where it has a picture, framed to hold it whole", async () => {
    const { store } = await setup();
    const fake = fakeVision();
    const api = new AgentApi(store, undefined, fake.vision);
    const anim = store.currentSymbol.animations.find((a) => a.name === "run")!;
    // A tall reference far to the right of the rig, from frame 4 to 11.
    store.apply(new SetAnimationReference(store.currentSymbolId, anim.id,
      { frames: ["r1", "r2"] as AssetId[], width: 100, height: 400, at: [4, 8], hold: 4, start: 4, x: 900, y: -100, scale: 2 }));
    await api.renderPoses("run", [0, 4, 8], "both");
    const plain = fake.renders.splice(0);
    expect(plain.map((r) => r.reference)).toEqual([false, false, false]);
    await api.renderPoses("run", [0, 4, 8], "both", undefined, true);
    const over = fake.renders.splice(0);
    expect(over.map((r) => r.reference)).toEqual([false, true, true]);
    // Framed on the rig and the 200 × 800 reference together: the picture got
    // wider to hold both, so the rig shrinks in it.
    expect(over[0]!.width / over[0]!.height).toBeGreaterThan(plain[0]!.width / plain[0]!.height);
    const span = (r: typeof over[0]) => Math.max(...r!.bones.map((b) => b.from[0])) - Math.min(...r!.bones.map((b) => b.from[0]));
    expect(span(over[0])).toBeLessThan(span(plain[0]));
  });
});

/** The stickman's library, and a root symbol with nothing in it. */
async function blank() {
  const { project } = await loadStickman();
  const original = new Store(project);
  const empty = structuredClone(project);
  Object.assign(empty.items[empty.rootSymbolId] as SymbolItem, { nodes: {}, layers: [], ik: [], animations: [createAnimation()] });
  const store = new Store(empty);
  return { original, store, api: new AgentApi(store) };
}

describe("rigging through the AI's tools", () => {
  type Pose = { bones: Record<string, { x: number; y: number; rotation: number; scaleX: number; scaleY: number }> };
  type Rig = { bones: Array<{ name: string; parent: string | null; length?: number }>; slots: unknown[]; ik: unknown[]; images: Array<{ name: string; width: number; height: number }> };

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

describe("rigging a PSD imported as layers", () => {
  /** A blank root holding `head` and `thigh` as layers, as File ▸ Import PSD
   *  as Layers leaves them: at canvas places, turning about their centres. */
  async function layered() {
    const { project } = await loadStickman();
    const empty = structuredClone(project);
    Object.assign(empty.items[empty.rootSymbolId] as SymbolItem, { nodes: {}, layers: [], ik: [], animations: [createAnimation()] });
    const store = new Store(empty);
    const byName = (n: string) => Object.values(empty.items).find((i) => i.name === n && isImage(i))!;
    const plan = buildFlatPsdImport([
      { kind: "image", name: "thigh", x: 300, y: 200, width: 100, height: 28, assetId: (byName("thigh") as { assetId: AssetId }).assetId, visible: true },
      { kind: "image", name: "head", x: 270, y: 100, width: 61, height: 58, assetId: (byName("head") as { assetId: AssetId }).assetId, visible: true },
    ], (n) => n === "thigh" || n === "head");
    store.transaction("Import", () => {
      for (const item of plan.items) store.apply(new AddLibraryItem("Import", item));
      for (const { node } of [...plan.layers].reverse()) store.apply(new AddNode("Import", store.currentSymbolId, node, createLayer(node.id, node.name, 0), 0));
    });
    return { store, api: new AgentApi(store) };
  }
  type Slot = { name: string; image?: string; size?: number[]; pivot: number[]; at: number[]; rotation: number };

  it("says where each layer's pixels are, and moving its pivot onto a bone leaves it in place", async () => {
    const { api } = await layered();
    const rig = await api.call("get_rig") as { slots: Slot[] };
    const thigh = rig.slots.find((s) => s.name === "thigh_2")!;
    expect(thigh).toMatchObject({ image: "thigh_2", size: [100, 28], pivot: [50, 14], at: [350, -214], rotation: 0 });
    // The joint is the picture's left end: pixel (0, 14), at x = 350 - 50.
    await api.call("add_bones", { bones: [{ name: "leg", from: [300, -214], to: [400, -214] }] });
    await api.call("attach", { items: [{ bone: "leg", layer: "thigh_2", pivot: [0, 14] }] });
    const after = (await api.call("get_rig") as { slots: Slot[] }).slots.find((s) => s.name === "thigh_2")!;
    expect(after).toMatchObject({ pivot: [0, 14], at: [300, -214], rotation: 0 });
    await api.call("new_animation", { name: "lift", frames: 4 });
    await api.call("set_keys", { animation: "lift", keys: [{ bone: "leg", frame: 2, rotation: 90 }] });
    const lifted = (await api.call("get_pose", { animation: "lift", frame: 2 }) as { bones: Record<string, { x: number; y: number; rotation: number }> }).bones.thigh_2!;
    expect(lifted).toMatchObject({ x: 300, y: -214, rotation: 90 });
  });
});

describe("the motion library through the AI's tools", () => {
  type Applied = { animation: string; frames: number; map: Record<string, string>; ground?: number; check: { matches: boolean; worstPixels: number }; notes: string[] };
  type Pose = { bones: Record<string, { x: number; y: number; rotation: number; scaleX: number }> };

  /** The lowest shin tip, where a stickman foot is. */
  async function feet(api: AgentApi, animation: string, frame: number) {
    const rig = await api.call("get_rig") as { bones: Array<{ name: string; length?: number }> };
    const len = (n: string) => rig.bones.find((b) => b.name === n)!.length!;
    const { bones } = await api.call("get_pose", { animation, frame }) as Pose;
    return Math.min(...["leg_near_shin", "leg_far_shin"].map((n) => bones[n]!.y + Math.sin((bones[n]!.rotation * Math.PI) / 180) * len(n) * bones[n]!.scaleX));
  }

  it("list the clips and the roles guessed for this rig", async () => {
    const { api } = await setup();
    const out = await api.call("list_motions") as { motions: Array<{ name: string; roles: string[] }>; guess: { side: Record<string, string> } };
    expect(out.motions.map((m) => m.name)).toEqual(["walk", "run", "idle", "jump", "idle_front", "wave", "jump_front"]);
    expect(out.guess.side).toMatchObject({ "thigh.near": "leg_near_thigh", "shin.far": "leg_far_shin", torso: "chest", hips: "hips" });
    expect(Object.values(out.guess.side)).not.toContain("foot_near_target");
  });

  it.each(["walk", "run", "idle", "jump", "idle_front", "wave", "jump_front"])("fit %s onto the stickman in one undo step, as the runtime plays it", async (motion) => {
    const { api, store } = await setup();
    const before = store.history.position;
    const out = await api.call("apply_motion", { motion, animation: `m_${motion}` }) as Applied;
    expect(store.history.position).toBe(before + 1);
    expect(store.history.undoLabel).toBe(`AI: Motion "${motion}" as "m_${motion}"`);
    expect(out.check.matches).toBe(true);
    // The IK chains are keyed through their targets only.
    const keyed = Object.keys((await api.call("get_animation", { animation: out.animation }) as { bones: Record<string, unknown> }).bones);
    expect(keyed).toEqual(expect.arrayContaining(["foot_near_target", "hand_far_target", "hips", "chest"]));
    expect(keyed).not.toContain("leg_near_shin");
    // Feet: on the ground on every frame of a walk or an idle, never below it.
    const grounded = ["walk", "idle", "idle_front", "wave"].includes(motion);
    for (let f = 0; f <= out.frames; f++) {
      const y = await feet(api, out.animation, f);
      if (grounded) expect(y, `frame ${f}`).toBeCloseTo(out.ground!, 0);
      else expect(y, `frame ${f}`).toBeGreaterThan(out.ground! - 0.5);
    }
    // The exported file plays it as the editor shows it.
    const names = new Map(exportSpine(store.project).names);
    for (const f of [0, Math.floor(out.frames / 3), Math.floor(out.frames / 2)]) {
      const runtime = played(store, out.animation, f);
      const { bones } = await api.call("get_pose", { animation: out.animation, frame: f }) as Pose;
      for (const [bone, v] of Object.entries(bones)) {
        const id = Object.values(store.currentSymbol.nodes).find((n) => n.name === bone)!.id;
        const w = runtime.world(names.get(id)!);
        expect(Math.hypot(v.x - w.worldX, v.y - w.worldY), `${bone} at ${f}`).toBeLessThan(0.02);
      }
    }
    store.undo();
    expect(store.currentSymbol.animations.some((a) => a.name === out.animation)).toBe(false);
  });

  it("mirror for a character facing left, stretch to a length, and take a map over the guess", async () => {
    const { api } = await setup();
    await api.call("apply_motion", { motion: "walk", animation: "r" });
    const left = await api.call("apply_motion", { motion: "walk", animation: "l", facing: "left", frames: 48 }) as Applied;
    expect(left.frames).toBe(48);
    expect(left.check.matches).toBe(true);
    const r = (await api.call("get_pose", { animation: "r", frame: 6 }) as Pose).bones;
    const l = (await api.call("get_pose", { animation: "l", frame: 12 }) as Pose).bones;
    // Mirrored about the hip joint (the stickman's sits 13 px forward of its hips bone).
    expect(r.foot_near_target!.x - r.leg_near_thigh!.x).toBeCloseTo(-(l.foot_near_target!.x - l.leg_near_thigh!.x), 1);
    expect(r.foot_near_target!.y).toBeCloseTo(l.foot_near_target!.y, 1);
    const swapped = await api.call("apply_motion", { motion: "walk", animation: "s", map: { "thigh.near": "leg_far_thigh", "shin.near": "leg_far_shin", "thigh.far": "leg_near_thigh", "shin.far": "leg_near_shin", head: null } }) as Applied;
    expect(swapped.map["thigh.near"]).toBe("leg_far_thigh");
    expect(swapped.map.head).toBeUndefined();
    expect(swapped.check.matches).toBe(true);
  });

  it("fit a rig without IK, keying the bones themselves", async () => {
    const { api } = await blank();
    await api.call("add_bones", { bones: [
      { name: "pelvis", from: [0, 100], to: [0, 110] },
      { name: "spine", parent: "pelvis", from: [0, 100], to: [0, 160] },
      { name: "thigh_l", parent: "pelvis", from: [0, 100], to: [5, 50] },
      { name: "calf_l", parent: "thigh_l", from: [5, 50], to: [0, 0] },
      { name: "thigh_r", parent: "pelvis", from: [0, 100], to: [-5, 50] },
      { name: "calf_r", parent: "thigh_r", from: [-5, 50], to: [0, 0] },
    ] });
    const out = await api.call("apply_motion", { motion: "walk" }) as Applied;
    expect(out.map).toMatchObject({ hips: "pelvis", torso: "spine", "thigh.near": "thigh_l", "shin.far": "calf_r" });
    expect(out.notes[0]).toMatch(/left\/right were read as near/);
    expect(out.check.matches).toBe(true);
    const pose = (await api.call("get_pose", { animation: "walk", frame: 6 }) as Pose).bones;
    // At frame 6 the near thigh is a quarter cycle on: 24° forward of hanging straight.
    expect(pose.thigh_l!.rotation).toBeCloseTo(-66, 1);
  });

  it("key a target that hangs from the moving hips in the hips' space", async () => {
    const { api } = await blank();
    await api.call("add_bones", { bones: [
      { name: "hips", from: [0, 100], to: [0, 110] },
      { name: "thigh", parent: "hips", from: [0, 100], to: [6, 52] },
      { name: "shin", parent: "thigh", from: [6, 52], to: [0, 0] },
    ] });
    // add_ik's own target hangs from the chain root's parent: the hips.
    expect(await api.call("add_ik", { bone: "shin" })).toMatchObject({ target: "shin_target" });
    const out = await api.call("apply_motion", { motion: "run", map: { hips: "hips", "thigh.near": "thigh", "shin.near": "shin" } }) as Applied;
    expect(out.check.matches).toBe(true);
    const rig = await api.call("get_rig") as { bones: Array<{ name: string; parent: string | null }> };
    expect(rig.bones.find((b) => b.name === "shin_target")!.parent).toBe("hips");
  });

  it("refuse what it cannot do, saying why", async () => {
    const { api, store } = await setup();
    const position = store.history.position;
    await expect(api.call("apply_motion", { motion: "moonwalk" })).rejects.toThrow(/no motion "moonwalk"/);
    await expect(api.call("apply_motion", { motion: "walk", animation: "run" })).rejects.toThrow(/already an animation "run"/);
    await expect(api.call("apply_motion", { motion: "walk", map: { torso: "torso" } })).rejects.toThrow(/slot/);
    await expect(api.call("apply_motion", { motion: "walk", map: { tail: "chest" } })).rejects.toThrow(/no role "tail"/);
    expect(store.history.position).toBe(position);
  });
});

describe("auto_rig through the AI's tools", () => {
  type Pose = { bones: Record<string, { x: number; y: number; rotation: number; scaleX: number }> };

  /** The stickman's pictures as loose layers where the stickman draws them,
   *  front first, and its joints read off its bones: what a model would see
   *  after Import PSD as Layers, and what it would read off the picture. */
  async function loose() {
    const { original, store, api } = await blank();
    const sym = original.currentSymbol;
    const setup = posedSymbol(original.project, sym, null, 0, "setup");
    const world = (name: string) => setup.byNode.get(Object.values(sym.nodes).find((n) => n.name === name)!.id)!.world;
    const rows = sym.layers.map((l) => sym.nodes[l.nodeId]!).filter((n) => n.kind === "image");
    store.transaction("Import", () => {
      for (const n of [...rows].reverse()) {
        const node = createNode("image", n.name, { itemId: n.itemId });
        node.pivot = { ...n.pivot };
        node.bind = fromMatrix(tf(), world(n.name));
        store.apply(new AddNode("Import", store.currentSymbolId, node, createLayer(node.id, node.name, 0), 0));
      }
    });
    const at = (name: string, along = 0): [number, number] => {
      const m = world(name), n = Object.values(sym.nodes).find((x) => x.name === name)!;
      const p = apply(pt(), m, along ? n.boneLength! : 0, 0);
      return [p.x, -p.y];
    };
    const joints = {
      pelvis: at("hips"), chest: at("chest"), neck: at("head"), head: at("head", 1),
      "shoulder.near": at("arm_near_up"), "elbow.near": at("arm_near_fore"), "wrist.near": at("arm_near_fore", 1),
      "shoulder.far": at("arm_far_up"), "elbow.far": at("arm_far_fore"), "wrist.far": at("arm_far_fore", 1),
      "hip.near": at("leg_near_thigh"), "knee.near": at("leg_near_shin"), "ankle.near": at("leg_near_shin", 1),
      "hip.far": at("leg_far_thigh"), "knee.far": at("leg_far_shin"), "ankle.far": at("leg_far_shin", 1),
    };
    return { store, api, joints };
  }

  type Slot = { name: string; size: number[]; pivot: number[]; at: number[]; rotation: number };
  /** Where each picture's corners are: what must not move when its pivot does. */
  async function corners(api: AgentApi) {
    const { slots } = await api.call("get_rig") as { slots: Slot[] };
    return Object.fromEntries(slots.map((s) => {
      const r = (s.rotation * Math.PI) / 180;
      const place = (u: number, v: number) => {
        const x = u - s.pivot[0]!, y = s.pivot[1]! - v;
        return [s.at[0]! + x * Math.cos(r) - y * Math.sin(r), s.at[1]! + x * Math.sin(r) + y * Math.cos(r)];
      };
      return [s.name, [place(0, 0), place(s.size[0]!, s.size[1]!)].flat()];
    }));
  }

  it.each([["with", true], ["without", false]] as const)("rig the stickman's loose pictures from its joints in one step, %s a chest joint, nothing moving", async (_, withChest) => {
    const { store, api, joints: all } = await loose();
    const { chest, ...rest } = all;
    const joints = withChest ? all : rest;
    expect(chest).toBeDefined();
    const before = await corners(api);
    const position = store.history.position;
    const out = await api.call("auto_rig", { joints }) as { attached: Array<{ layer: string; bone: string }>; ik: string[]; check: { matches: boolean }; notes: string[] };
    expect(store.history.position).toBe(position + 1);
    expect(store.history.undoLabel).toBe("AI: Auto Rig");
    // Bones the pictures already name get "_bone" after their names.
    expect(Object.fromEntries(out.attached.map((a) => [a.layer, a.bone]))).toEqual({
      thigh_near: "thigh_near_bone", shin_near: "shin_near_bone", pelvis: "hips", arm_near_1: "upper_arm_near", arm_near_2: "forearm_near",
      head_art: "head", torso: "torso_bone", arm_far_1: "upper_arm_far", arm_far_2: "forearm_far", thigh_far: "thigh_far_bone", shin_far: "shin_far_bone",
    });
    expect(out.ik).toEqual(["shin_near_bone_ik", "shin_far_bone_ik"]);
    // The joints are where they were read, the knees bent as drawn (the IK solves the setup pose).
    expect(out.check.matches).toBe(true);
    const after = await corners(api);
    for (const [name, c] of Object.entries(before)) {
      c.forEach((v, i) => expect(Math.abs(after[name]![i]! - v), name).toBeLessThan(0.02));
    }
    // Drawn as the artist stacked it: the near limbs in front, the far ones behind.
    const slots = (await api.call("get_rig") as { slots: Array<{ name: string }> }).slots.map((s) => s.name).reverse();
    expect(slots.indexOf("arm_near_1")).toBeLessThan(slots.indexOf("torso"));
    expect(slots.indexOf("torso")).toBeLessThan(slots.indexOf("arm_far_1"));
    expect(slots.indexOf("thigh_near")).toBeLessThan(slots.indexOf("thigh_far"));
    store.undo();
    expect(Object.values(store.currentSymbol.nodes).every((n) => n.kind === "image" && !n.parentId)).toBe(true);
  });

  it("make a straight leg bend its knee forward for the way the character faces", async () => {
    for (const facing of ["right", "left"] as const) {
      const { api } = await blank();
      const flip = facing === "right" ? 1 : -1;
      await api.call("auto_rig", { facing, joints: { pelvis: [0, 100], neck: [0, 160], "knee.near": [0, 50], "ankle.near": [0, 0] } });
      // Pull the foot up: the knee must come forward.
      await api.call("new_animation", { name: "lift", frames: 4 });
      // The target hangs from the hips (at 0, 100, pointing up): skeleton (0, 40) is x -60 along them.
      await api.call("set_keys", { animation: "lift", keys: [{ bone: "shin_near_target", frame: 2, x: -60, y: 0 }] });
      const knee = (await api.call("get_pose", { animation: "lift", frame: 2 }) as Pose).bones.shin_near!;
      expect(knee.x * flip, facing).toBeGreaterThan(10);
    }
  });

  it("walk with the library on what it built", async () => {
    const { api, joints } = await loose();
    await api.call("auto_rig", { joints });
    const walk = await api.call("apply_motion", { motion: "walk" }) as { map: Record<string, string>; check: { matches: boolean } };
    expect(walk.map).toMatchObject({ hips: "hips", torso: "torso_bone", "thigh.near": "thigh_near_bone", "forearm.far": "forearm_far" });
    expect(walk.check.matches).toBe(true);
  });

  it("refuse a second skeleton and a joint it does not know, leaving nothing behind", async () => {
    const { store, api, joints } = await loose();
    await api.call("auto_rig", { joints });
    const position = store.history.position;
    await expect(api.call("auto_rig", { joints })).rejects.toThrow(/already has "hips"/);
    await expect(api.call("auto_rig", { joints: { ...joints, tail: [0, 0] } })).rejects.toThrow(/no joint "tail"/);
    await expect(api.call("auto_rig", { joints, view: "top" })).rejects.toThrow(/view is/);
    expect(store.history.position).toBe(position);
  });
});

describe("cycles and bone paths through the AI's tools", () => {
  type Seam = { lastFrame: number; closes: boolean; gaps?: Array<{ bone: string; pixels?: number }> };

  it("key the draw order at a frame in one undo step", async () => {
    const { store, api } = await setup();
    const out = await api.call("key_draw_order", { animation: "dance", frame: 6, front: ["arm_far_1", "thigh_near"] }) as { frontToBack: string[] };
    expect(out.frontToBack[0]).toBe("arm_far_1");
    expect(store.history.undoLabel).toBe("AI: Draw Order at 7");
    const anim = await api.call("get_animation", { animation: "dance" }) as { drawOrder: Array<{ frame: number; frontToBack: string[] | "setup" }> };
    expect(anim.drawOrder).toHaveLength(1);
    expect(anim.drawOrder[0]!.frame).toBe(6);
    await api.call("key_draw_order", { animation: "dance", frame: 12, setup: true });
    const again = await api.call("get_animation", { animation: "dance" }) as { drawOrder: Array<{ frame: number; frontToBack: unknown }> };
    expect(again.drawOrder[1]).toEqual({ frame: 12, frontToBack: "setup" });
  });

  it("key an IK constraint's mix and bend in one undo step", async () => {
    const { store, api } = await setup();
    const rig = await api.call("get_rig", {}) as { ik: Array<{ name: string; mix: number }> };
    const name = rig.ik[0]!.name;
    await api.call("key_ik", { animation: "run", ik: name, frame: 4, mix: 0.25, ease: "stepped" });
    expect(store.history.undoLabel).toBe(`AI: IK "${name}" at 5`);
    const out = await api.call("key_ik", { animation: "run", ik: name, frame: 10 }) as { keys: unknown[] };
    // Left out, the mix and bend are what is in force there: key 4's, stepped.
    expect(out.keys).toEqual([
      { frame: 4, mix: 0.25, bendPositive: expect.any(Boolean), ease: "stepped" },
      { frame: 10, mix: 0.25, bendPositive: expect.any(Boolean), ease: "linear" },
    ]);
    const anim = await api.call("get_animation", { animation: "run" }) as { ik: Record<string, unknown[]> };
    expect(anim.ik[name]).toHaveLength(2);
    const soft = await api.call("key_ik", { animation: "run", ik: name, frame: 10, softness: 20 }) as { keys: Array<{ softness?: number }> };
    expect(soft.keys[1]!.softness).toBe(20);
    expect(soft.keys[0]).not.toHaveProperty("softness");
    await expect(api.call("key_ik", { animation: "run", ik: name, frame: 1, softness: -1 })).rejects.toThrow(/softness/);
    await api.call("key_ik", { animation: "run", ik: name, frame: 10, delete: true });
    await expect(api.call("key_ik", { animation: "run", ik: "nope", frame: 1 })).rejects.toThrow(/no IK constraint "nope"/);
  });

  it("define events and fire them at frames, each one undo step", async () => {
    const { store, api } = await setup();
    await api.call("define_event", { name: "step", int: 1, audio: "sfx/step.ogg", volume: 0.5 });
    expect(store.history.undoLabel).toBe('AI: Event "step"');
    await api.call("key_event", { animation: "run", frame: 3, event: "step" });
    await api.call("key_event", { animation: "run", frame: 3, event: "step", int: 4, balance: -1 });
    expect(store.history.undoLabel).toBe('AI: Event "step" at 4');
    const rig = await api.call("get_rig", {}) as { events: unknown[] };
    expect(rig.events).toEqual([{ name: "step", int: 1, audio: "sfx/step.ogg", volume: 0.5 }]);
    await api.call("define_event", { name: "step", rename: "foot" });
    const anim = await api.call("get_animation", { animation: "run" }) as { events: unknown[] };
    expect(anim.events).toEqual([{ frame: 3, name: "foot" }, { frame: 3, name: "foot", int: 4, balance: -1 }]);
    await expect(api.call("key_event", { animation: "run", frame: 1, event: "nope" })).rejects.toThrow(/no event "nope"/);
    const gone = await api.call("define_event", { name: "foot", delete: true }) as { keysRemoved: number };
    expect(gone.keysRemoved).toBe(2);
    expect(await api.call("get_animation", { animation: "run" })).not.toHaveProperty("events");
  });

  it("add a transform constraint and key its mixes, each one undo step", async () => {
    const { store, api } = await setup();
    const out = await api.call("add_transform_constraint", { bones: ["head"], source: "chest", mix: { x: 0.5 }, offsets: { rotate: 10 }, relative: true }) as { name: string };
    expect(store.history.undoLabel).toBe(`AI: Transform Constraint "${out.name}"`);
    const rig = await api.call("get_rig", {}) as { transforms: Array<{ name: string; mix: Record<string, number>; relative?: boolean; offsets?: unknown }> };
    expect(rig.transforms[0]).toMatchObject({ name: out.name, source: "chest", bones: ["head"], relative: true, offsets: { rotate: 10 } });
    expect(rig.transforms[0]!.mix.x).toBe(0.5);
    await api.call("key_transform", { animation: "run", constraint: out.name, frame: 3, mix: { rotate: 0 }, ease: "stepped" });
    const anim = await api.call("get_animation", { animation: "run" }) as { transforms: Record<string, Array<{ frame: number; mix: Record<string, number>; ease: string }>> };
    expect(anim.transforms[out.name]![0]).toMatchObject({ frame: 3, ease: "stepped" });
    expect(anim.transforms[out.name]![0]!.mix).toMatchObject({ rotate: 0, x: 0.5 });
    await expect(api.call("add_transform_constraint", { bones: ["chest"], source: "chest" })).rejects.toThrow(/cannot follow itself/);
    await expect(api.call("key_transform", { animation: "run", constraint: "nope", frame: 0 })).rejects.toThrow(/no transform constraint "nope"/);
  });

  it("make an image a mesh and bind it to bones, each one undo step", async () => {
    const { store, api } = await setup();
    const torso = Object.values(store.currentSymbol.nodes).find((n) => n.itemId && n.name.includes("torso"))!.name;
    const made = await api.call("make_mesh", { images: [torso], spacing: 10 }) as { meshes: Array<{ image: string; points: number; triangles: number }> };
    expect(store.history.undoLabel).toBe("AI: Make Mesh");
    expect(made.meshes[0]!.points).toBeGreaterThan(4);
    await api.call("bind_mesh", { image: torso, bones: ["chest", "hips"] });
    expect(store.history.undoLabel).toBe("AI: Bind Mesh");
    const node = Object.values(store.currentSymbol.nodes).find((n) => n.name === torso)!;
    expect(node.mesh!.weights!.every((w) => w.length > 0)).toBe(true);
    await expect(api.call("make_mesh", { images: [torso] })).rejects.toThrow(/without a mesh/);
    await expect(api.call("bind_mesh", { image: "head", bones: ["chest"] })).rejects.toThrow(/one mesh/);
  });

  it("make a cycle in one undo step, and say where the loop does not close", async () => {
    const { store, api } = await setup();
    expect(await api.call("get_animation", { animation: "run" })).toMatchObject({ cycle: false });
    const on = await api.call("set_cycle", { animation: "run", on: true }) as { cycle: boolean; frames: number; seam: Seam };
    expect(on).toMatchObject({ cycle: true, frames: 17, seam: { lastFrame: 17, closes: true } });
    expect(store.history.undoLabel).toBe('AI: Cycle "run"');

    await api.call("set_keys", { animation: "run", keys: [{ bone: "foot_near_target", frame: 17, x: 30 }] });
    const seam = (await api.call("get_animation", { animation: "run" }) as { seam: Seam }).seam;
    expect(seam.closes).toBe(false);
    expect(seam.gaps!.map((g) => g.bone)).toContain("foot_near_target");

    const off = await api.call("set_cycle", { animation: "run", on: false }) as { cycle: boolean; seam?: Seam };
    expect(off.cycle).toBe(false);
    expect(off.seam).toBeUndefined();
    await expect(api.call("set_cycle", { animation: "run", on: "yes" })).rejects.toBeInstanceOf(AgentError);
  });

  it("report the seam with check_preview", async () => {
    const { store } = await setup();
    const api = new AgentApi(store, { matricesAt: async () => ({}) });
    await api.call("set_cycle", { animation: "run", on: true });
    const out = await api.call("check_preview", { animation: "run", frames: [0] }) as { seam: Seam };
    expect(out.seam).toMatchObject({ lastFrame: 17, closes: true });
  });

  it("give a bone's path in get_pose's space, IK included, keys marked", async () => {
    const { api } = await setup();
    const path = await api.call("get_bone_path", { animation: "run", bone: "leg_near_shin" }) as {
      closed: boolean; points: Array<{ frame: number; x: number; y: number; key?: boolean }>;
    };
    expect(path.closed).toBe(false);
    expect(path.points.map((p) => p.frame)).toEqual(Array.from({ length: 17 }, (_, i) => i));
    // The shin is moved by IK: no keys of its own.
    expect(path.points.some((p) => p.key)).toBe(false);
    const target = await api.call("get_bone_path", { animation: "run", bone: "foot_near_target", point: "origin" }) as typeof path;
    const pose = await api.call("get_pose", { animation: "run", frame: 6, bones: ["foot_near_target"] }) as { bones: Record<string, { x: number; y: number }> };
    expect(target.points[6]).toMatchObject({ x: pose.bones.foot_near_target!.x, y: pose.bones.foot_near_target!.y, key: true });
    await expect(api.call("get_bone_path", { animation: "run", bone: "foot_near_target", point: "middle" })).rejects.toBeInstanceOf(AgentError);
  });

  it("key a path with handles as eases, in one undo step, and the export plays it", async () => {
    const { store, api } = await setup();
    await api.call("new_animation", { name: "hop", frames: 20 });
    const out = await api.call("set_bone_path", {
      animation: "hop", bone: "hand_near_target",
      keys: [{ frame: 0, x: 400, y: -300, out: [420, -200] }, { frame: 10, x: 500, y: -300, in: [480, -200] }, { frame: 20, x: 400, y: -300 }],
    }) as { keys: number; addedKeys?: number[] };
    // y does not move from 0 to 10, so bending it adds a key at 5.
    expect(out).toMatchObject({ keys: 3, addedKeys: [5] });
    expect(store.history.undoLabel).toBe('AI: Path of "hand_near_target"');
    const keyed = (await api.call("get_animation", { animation: "hop" }) as { bones: Record<string, Array<{ frame: number; y: number; eases?: unknown }>> }).bones.hand_near_target!;
    expect(keyed.map((k) => k.frame)).toEqual([0, 5, 10, 20]);
    // On the curve at its middle: a quarter of the way up to the handles' height.
    expect(keyed[1]!.y).toBeCloseTo(-300 + 0.75 * 100, 6);
    expect(keyed[0]!.eases).toBeDefined();
    // The runtime plays what the stage shows.
    const play = played(store, "hop", 3);
    const pose = await api.call("get_pose", { animation: "hop", frame: 3, bones: ["hand_near_target"] }) as { bones: Record<string, { x: number; y: number }> };
    expect(play.world("hand_near_target").worldX).toBeCloseTo(pose.bones.hand_near_target!.x, 1);
    expect(play.world("hand_near_target").worldY).toBeCloseTo(pose.bones.hand_near_target!.y, 1);

    store.undo();
    expect((await api.call("get_animation", { animation: "hop" }) as { bones: Record<string, unknown> }).bones.hand_near_target).toBeUndefined();
  });

  it("refuse a bone the IK moves, a key between two handled keys, and a frame twice", async () => {
    const { api } = await setup();
    await expect(api.call("set_bone_path", { animation: "run", bone: "leg_near_shin", keys: [{ frame: 0, x: 0, y: 0 }] }))
      .rejects.toThrow(/foot_near_target/);
    await expect(api.call("set_bone_path", { animation: "run", bone: "foot_near_target", keys: [{ frame: 0, x: 0, y: 0, out: [1, 1] }, { frame: 4, x: 9, y: 0 }] }))
      .rejects.toThrow(/between 0 and 4/);
    await expect(api.call("set_bone_path", { animation: "run", bone: "foot_near_target", keys: [{ frame: 2, x: 0, y: 0 }, { frame: 2, x: 1, y: 0 }] }))
      .rejects.toThrow(/same frame/);
  });

  it("draw named bones' paths in render_frame, framed to hold them", async () => {
    const { store } = await setup();
    const renders: Array<Parameters<AgentVision["render"]>[0]> = [];
    const vision: AgentVision = {
      image: async () => ({ mimeType: "image/png", data: "" }),
      render: async (req) => { renders.push(req); return { mimeType: "image/png", data: "RENDER" }; },
    };
    const api = new AgentApi(store, undefined, vision);
    const out = await api.call("render_frame", { animation: "run", frame: 4, paths: ["foot_near_target"] }) as { paths: Record<string, { frames: number; keyedFrames: number[] }> };
    expect(out.paths.foot_near_target).toMatchObject({ frames: 17, keyedFrames: [0, 2, 4, 6, 8, 10, 12, 14, 16] });
    const mark = renders[0]!.paths![0]!;
    expect(mark.points).toHaveLength(17);
    expect(mark.current).toBe(4);
    for (const [x, y] of mark.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(renders[0]!.view.width);
      expect(y).toBeLessThanOrEqual(renders[0]!.view.height);
    }
    await expect(api.call("render_frame", { frame: 0, paths: ["hips"] })).rejects.toBeInstanceOf(AgentError);
    await expect(api.call("render_frame", { animation: "run", paths: ["tail"] })).rejects.toBeInstanceOf(AgentError);
  });
});
