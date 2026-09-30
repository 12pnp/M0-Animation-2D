import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MixFrom, Physics, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import { Store } from "@/app/Store";
import { AGENT_TOOLS, AgentApi, AgentError } from "@/app/agent/AgentApi";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { atlasText } from "@/core/spine/atlas";
import { isImage } from "@/core/doc/types";
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
});
