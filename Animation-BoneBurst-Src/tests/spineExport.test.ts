import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed, newIkId, type AssetId, type NodeId } from "@/core/doc/ids";
import { createSymbol } from "@/core/doc/defaults";
import { createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { isSymbol, type Keyframe, type Node, type Project, type SymbolItem } from "@/core/doc/types";
import { History } from "@/core/history/History";
import { SetParent } from "@/core/history/hierarchyCommands";
import { SetLayerExcluded } from "@/core/history/layerCommands";
import { tf, type Transform } from "@/core/math/Transform";
import type { PackedPage } from "@/core/atlas/packed";
import { atlasText } from "@/core/boneburst/atlas";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { type Channel, sliceRuns } from "@/core/boneburst/exportChannels";
import { colorHex } from "@/core/boneburst/exportColor";
import { ROOT_BONE } from "@/core/boneburst/exportTypes";
import { keyTime } from "@/core/boneburst/transform";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { BONEBURST_VERSION, type BoneBurstSkeletonFile } from "@/core/boneburst/types";

beforeEach(() => reseed());

/* ── helpers ── */

function scene(names: string[], size: [number, number] = [40, 30]): { project: Project; sym: SymbolItem } {
  const project = createProject("Rig");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  names.forEach((name, i) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, size[0], size[1]);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    const node = createNode("image", name, { itemId: item.id });
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, name, i));   // index 0 is the TOP row
  });
  return { project, sym };
}

function add(sym: SymbolItem, node: Node, at = 0): Node {
  sym.nodes[node.id] = node;
  sym.layers.splice(at, 0, createLayer(node.id, node.name, sym.layers.length));
  return node;
}

const nodeNamed = (sym: SymbolItem, name: string) => Object.values(sym.nodes).find((n) => n.name === name)!;

function key(frame: number, t: Transform, extra: Partial<Keyframe> = {}): Keyframe {
  return { frame, transform: t, displayIndex: 0, tween: { kind: "linear" }, ...extra };
}

function track(sym: SymbolItem, name: string, keys: Keyframe[], endFrame?: number, duration?: number): void {
  const node = nodeNamed(sym, name);
  const anim = sym.animations[0]!;
  if (duration !== undefined) anim.duration = duration;
  anim.tracks[node.id] = { nodeId: node.id, keys, endFrame: endFrame ?? anim.duration - 1 };
}

const file = (project: Project): BoneBurstSkeletonFile => exportBoneBurst(project).skeleton;
const messages = (project: Project) => exportBoneBurst(project).diagnostics.map((d) => `${d.severity}: ${d.message}`);

/** The export loaded by the runtime, with a plain untrimmed atlas. */
function load(project: Project): Skeleton {
  const exported = exportBoneBurst(project);
  const regions = exported.usedImages.map((id, i) => {
    const item = project.items[id] as { name: string; width: number; height: number };
    return { name: item.name, x: 0, y: i * 100, width: item.width, height: item.height, offsetX: 0, offsetY: 0,
      originalWidth: item.width, originalHeight: item.height, rotated: false };
  });
  const page: PackedPage = { name: "p", imagePath: "p.png", width: 512, height: 512, scale: 1, regions };
  const atlas = new TextureAtlas(atlasText([page]));
  return new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(boneburstJson(exported.skeleton))));
}

/* ── the file ── */

describe("skeleton structure", () => {
  it("writes the 4.3 header spine-unity checks, and the frame rate", () => {
    const { project } = scene(["a"]);
    expect(file(project).skeleton).toEqual({ hash: expect.stringMatching(/^[A-Za-z0-9+/]{11}$/), spine: BONEBURST_VERSION, fps: 24 });
    expect(BONEBURST_VERSION.split(".").slice(0, 2)).toEqual(["4", "3"]);
  });

  it("hashes the content, as spine-csharp requires: the same file the same hash", () => {
    const { project, sym } = scene(["a"]);
    const first = file(project).skeleton.hash;
    expect(file(project).skeleton.hash).toBe(first);
    nodeNamed(sym, "a").bind.x += 1;
    expect(file(project).skeleton.hash).not.toBe(first);
  });

  it("hangs every top-level node from a root bone, parents before children", () => {
    const { project, sym } = scene(["a", "b"]);
    const arm = add(sym, createNode("bone", "arm"));
    nodeNamed(sym, "a").parentId = arm.id;
    const bones = file(project).bones;
    expect(bones[0]).toEqual({ name: ROOT_BONE });
    const index = (n: string) => bones.findIndex((b) => b.name === n);
    expect(bones.find((b) => b.name === "a")!.parent).toBe("arm");
    expect(index("arm")).toBeLessThan(index("a"));
    expect(bones.find((b) => b.name === "b")!.parent).toBe(ROOT_BONE);
  });

  it("emits slots in reverse layer order, so the top layer draws in front", () => {
    const { project } = scene(["bottom", "middle", "top"]);
    expect(file(project).slots!.map((s) => s.name)).toEqual(["bottom", "middle", "top"]);
    expect(load(project).drawOrder.appliedPose.map((s) => s.data.name)).toEqual(["bottom", "middle", "top"]);
  });

  it("renames colliding names rather than emitting an ambiguous rig, and keeps root for the root", () => {
    const { project } = scene(["dup", "dup", "root"]);
    const names = file(project).bones.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("dup_2");
    expect(names).toContain("root_2");
    expect(messages(project).filter((m) => m.startsWith("warning"))).toHaveLength(2);
  });

  it("writes the bind pose mapped to y up, omitting defaults", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").bind = tf(10, 20, 30, 30, 2, 1);
    expect(file(project).bones[1]).toEqual({ name: "a", parent: ROOT_BONE, x: 10, y: -20, rotation: -30, scaleX: 2 });
  });

  it("places an image's centre from its transform point, full size", () => {
    const { project, sym } = scene(["a"], [100, 60]);
    nodeNamed(sym, "a").pivot = { x: 10, y: 20 };
    const region = file(project).skins![0]!.attachments!.a!.a!;
    expect(region).toEqual({ width: 100, height: 60, x: 40, y: -10 });
  });

  it("refuses two used images with one name, which would share one atlas region", () => {
    const { project } = scene(["same", "same"]);
    expect(messages(project).some((m) => m.startsWith("error") && m.includes('called "same"'))).toBe(true);
  });

  it("says nothing about a clash nothing on the stage uses", () => {
    const { project } = scene(["a"]);
    for (const n of [1, 2]) {
      const item = createImageItem("unused", `asset_u${n}` as AssetId, 10, 10);
      project.items[item.id] = item;
    }
    expect(messages(project)).toEqual([]);
  });

  it("refuses an image name the line-based atlas cannot hold", () => {
    const { project } = scene([" padded"]);
    expect(messages(project).some((m) => m.startsWith("error") && m.includes("atlas"))).toBe(true);
  });
});

describe("bone timelines", () => {
  it("writes offsets from the setup pose, and scale as a multiplier of it", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").bind = tf(10, 10, 0, 0, 2, 2);
    track(sym, "a", [key(0, tf(10, 10, 0, 0, 2, 2)), key(4, tf(30, 5, 20, 20, 3, 1))], undefined, 5);
    const bone = file(project).animations!.animation!.bones!.a!;
    expect(bone.translate).toEqual([{}, { time: keyTime(4, 24), x: 20, y: 5 }]);
    expect(bone.rotate).toEqual([{}, { time: keyTime(4, 24), value: -20 }]);
    expect(bone.scale).toEqual([{}, { time: keyTime(4, 24), x: 1.5, y: 0.5 }]);
    expect(bone.shear).toBeUndefined();
  });

  it("puts shear in shearY as skewY − skewX", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(4, tf(0, 0, 30, 10))], undefined, 5);
    const bone = file(project).animations!.animation!.bones!.a!;
    expect(bone.shear).toEqual([{}, { time: keyTime(4, 24), y: -20 }]);
    expect(bone.rotate).toEqual([{}, { time: keyTime(4, 24), value: -10 }]);
  });

  it("writes a hold as a stepped key and a linear tween with no curve", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [
      key(0, tf(), { tween: { kind: "none" } }), key(4, tf(10, 0)), key(8, tf(20, 0)),
    ], undefined, 9);
    const t = file(project).animations!.animation!.bones!.a!.translate!;
    expect(t.map((k) => k.curve)).toEqual(["stepped", undefined, undefined]);
  });

  it("writes nothing for a track that never leaves its setup pose", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(4, tf())], undefined, 5);
    expect(file(project).animations!.animation!.bones).toBeUndefined();
  });

  it("turns 720° in one linear key: Spine interpolates raw degrees", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(10, tf(0, 0, 720, 720))], undefined, 11);
    expect(file(project).animations!.animation!.bones!.a!.rotate).toEqual([{}, { time: keyTime(10, 24), value: -720 }]);
  });

  it("carries 'Rotate CCW × 2' as unwrapped degrees", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf(), { rotateDir: "ccw", rotateTurns: 2 }), key(10, tf(0, 0, 90, 90))], undefined, 11);
    // CCW from 0 to 90 is −270, plus two turns the same way; y up negates it.
    expect(file(project).animations!.animation!.bones!.a!.rotate![1]!.value).toBe(270 + 720);
  });

  it("bakes an eased interval into a key per frame, and only on the channels it eases", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [
      key(0, tf(), { eases: { position: { kind: "preset", family: "sine", dir: "in" } } }),
      key(6, tf(60, 0, 30, 30)),
    ], undefined, 7);
    const bone = file(project).animations!.animation!.bones!.a!;
    expect(bone.translate).toHaveLength(7);
    expect(bone.rotate).toHaveLength(2);
  });

  it("writes a timeline per axis only where the axes' eases part, and the runtime plays the stage", () => {
    const { project, sym } = scene(["a", "b"]);
    const sine = { kind: "preset", family: "sine", dir: "in" } as const;
    track(sym, "a", [
      key(0, tf(), { eases: { y: sine, scaleY: { kind: "curve", curve: [0.3, 0, 0.6, 1] } } }),
      key(6, tf(60, 30, 0, 0, 2, 3)),
    ], undefined, 7);
    track(sym, "b", [key(0, tf(), { eases: { x: sine, y: sine } }), key(6, tf(60, 30))], undefined, 7);
    const bones = file(project).animations!.animation!.bones!;
    const a = bones.a!, b = bones.b!;
    expect([a.translate, a.scale]).toEqual([undefined, undefined]);
    expect((a.translatex as unknown[]).length).toBe(2);   // linear: one key and the end
    expect((a.translatey as unknown[]).length).toBe(7);   // a preset: every frame
    expect((a.scaley as Array<{ curve?: unknown }>)[0]!.curve).toHaveLength(4);
    expect(b.translatex).toBeUndefined();
    expect(b.translate).toHaveLength(7);

    const sk = load(project);
    const anim = sk.data.findAnimation("animation")!;
    for (let f = 0; f <= 6; f++) {
      sk.setupPose();
      anim.apply(sk, 0, f / 24 + 1e-6, false, null, 1, MixFrom.setup, false, false, false);
      const stage = sampleTransformRaw(sym.animations[0]!.tracks[nodeNamed(sym, "a").id]!, f)!;
      const pose = sk.findBone("a")!.pose;
      const want = [stage.x, -stage.y, stage.scaleX, stage.scaleY];
      [pose.x, pose.y, pose.scaleX, pose.scaleY].forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 3));
    }
  });

  it("holds every channel across a hold, whatever the overrides say", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [
      key(0, tf(), { tween: { kind: "none" }, eases: { position: { kind: "preset", family: "sine", dir: "in" } } }),
      key(6, tf(60, 0, 30, 30)),
    ], undefined, 7);
    const bone = file(project).animations!.animation!.bones!.a!;
    expect(bone.translate!.map((k) => k.curve)).toEqual(["stepped", undefined]);
    expect(bone.rotate!.map((k) => k.curve)).toEqual(["stepped", undefined]);
  });

  it("refuses a key away from a setup scale of 0", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").bind = tf(0, 0, 0, 0, 0, 1);
    track(sym, "a", [key(0, tf(0, 0, 0, 0, 0, 1)), key(4, tf(0, 0, 0, 0, 1, 1))], undefined, 5);
    expect(messages(project).some((m) => m.startsWith("error") && m.includes("setup scale of 0"))).toBe(true);
  });
});

describe("animation length", () => {
  it("lasts the animation's duration even when the last key comes earlier", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(4, tf(10, 0))], undefined, 24);
    const animation = load(project).data.findAnimation("animation")!;
    expect(animation.duration).toBeCloseTo(24 / 24, 6);
  });

  it("adds nothing when a key already ends it", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(24, tf(10, 0))], 24, 24);
    expect(file(project).animations!.animation!.drawOrder).toBeUndefined();
  });
});

describe("colour and blend", () => {
  const red = { rM: 100, gM: 0, bM: 0, aM: 50, rO: 0, gO: 0, bO: 0, aO: 0 };
  const neutral = { rM: 100, gM: 100, bM: 100, aM: 100, rO: 0, gO: 0, bO: 0, aO: 0 };

  it("writes multipliers as rrggbbaa", () => {
    expect(colorHex(red)).toBe("ff000080");
    expect(colorHex(neutral)).toBeUndefined();
  });

  it("writes a non-neutral bind colour as the slot colour", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").color = red;
    expect(file(project).slots![0]!.color).toBe("ff000080");
  });

  it("emits an rgba timeline even when every authored colour is neutral", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").color = red;
    track(sym, "a", [key(0, tf(), { color: neutral })], undefined, 5);
    expect(file(project).animations!.animation!.slots!.a!.rgba).toEqual([{ color: "ffffffff" }]);
  });

  it("emits nothing when no key carries a colour", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(4, tf(1, 0))], undefined, 5);
    expect(file(project).animations!.animation!.slots).toBeUndefined();
  });

  it("writes colour offsets as two-colour tint: dark = offset, light = multiplier + offset", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").color = { ...neutral, rM: 50, rO: 60, gM: 80, gO: 20 };
    const slot = file(project).slots![0]!;
    expect(slot.dark).toBe("3c1400");
    // r: 0.5 + 60/255 = 0.7353 -> 187.5 -> bc; g: 0.8 + 20/255 = 0.8784 -> e0.
    expect(slot.color).toBe("bce0ffff");
    expect(messages(project)).toEqual([]);
  });

  it("keys offsets on an rgba2 timeline, curves over all seven channels", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [
      key(0, tf(), { color: { ...neutral, rM: 40, rO: 100 }, tween: { kind: "ease", value: 1 } }),
      key(6, tf(), { color: { ...neutral, bM: 50, bO: 50 } }),
    ], undefined, 7);
    const tl = file(project).animations!.animation!.slots!.a!;
    expect(tl.rgba).toBeUndefined();
    expect(tl.rgba2!.map((k) => [k.light, k.dark])).toEqual([["caffffff", "640000"], ["ffffb2ff", "000032"]]);
    expect((tl.rgba2![0]!.curve as number[]).length).toBe(28);
  });

  it("warns about offsets the tint cannot draw exactly, and clamps them", () => {
    const { project, sym } = scene(["a", "b"]);
    nodeNamed(sym, "a").color = { ...neutral, rO: 40 };          // 1 + 40/255 > 1
    nodeNamed(sym, "b").color = { ...neutral, rM: 50, gO: -30 }; // negative
    const warnings = messages(project).filter((m) => m.includes("two-colour tint"));
    expect(warnings).toHaveLength(2);
  });

  it("maps the blend modes to Spine's names, normal written as nothing", () => {
    const { project, sym } = scene(["a", "b", "c"]);
    nodeNamed(sym, "a").blendMode = "add";
    nodeNamed(sym, "b").blendMode = "screen";
    nodeNamed(sym, "c").blendMode = "normal";
    const slots = file(project).slots!;
    expect(slots.find((s) => s.name === "a")!.blend).toBe("additive");
    expect(slots.find((s) => s.name === "b")!.blend).toBe("screen");
    expect(slots.find((s) => s.name === "c")!.blend).toBeUndefined();
    expect(messages(project)).toEqual([]);
  });
});

describe("partial spans", () => {
  it("keeps a late track's keys on their frames, holding the setup pose before them", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(6, tf(10, 0)), key(10, tf(20, 0))], 19, 20);
    const t = file(project).animations!.animation!.bones!.a!.translate!;
    expect(t[0]).toEqual({ curve: "stepped" });
    expect(t.slice(1).map((k) => k.time)).toEqual([keyTime(6, 24), keyTime(10, 24)]);
  });

  it("hides the slot before the first key and after the span ends", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(6, tf())], 12, 20);
    expect(file(project).animations!.animation!.slots!.a!.attachment).toEqual([
      { name: null }, { time: keyTime(6, 24), name: "a" }, { time: keyTime(13, 24), name: null },
    ]);
  });

  it("emits no attachment timeline for a track that covers the whole animation", () => {
    const { project, sym } = scene(["a"]);
    track(sym, "a", [key(0, tf()), key(10, tf(5, 0))], 19, 20);
    expect(file(project).animations!.animation!.slots).toBeUndefined();
  });
});

describe("displays", () => {
  it("writes every used display with its own transform point, and leaves out unused ones", () => {
    const { project, sym } = scene(["a", "b", "c"]);
    const a = nodeNamed(sym, "a");
    const itemB = Object.values(project.items).find((i) => i.name === "b")!;
    const itemC = Object.values(project.items).find((i) => i.name === "c")!;
    a.extraDisplays = [{ itemId: itemC.id, pivot: { x: 0, y: 0 } }, { itemId: itemB.id, pivot: { x: 40, y: 30 } }];
    track(sym, "a", [key(0, tf()), key(4, tf(), { displayIndex: 2 })], undefined, 5);
    const slot = file(project).skins![0]!.attachments!.a!;
    expect(Object.keys(slot)).toEqual(["a", "b"]);
    expect(slot.b).toEqual({ width: 40, height: 30, x: -20, y: 15 });
    expect(file(project).animations!.animation!.slots!.a!.attachment!.map((k) => k.name)).toEqual(["a", "b"]);
  });

  it("gives the same image shown about two points two attachments on one region", () => {
    const { project, sym } = scene(["a"]);
    const a = nodeNamed(sym, "a");
    a.extraDisplays = [{ itemId: a.itemId!, pivot: { x: 40, y: 30 } }];
    track(sym, "a", [key(0, tf()), key(4, tf(), { displayIndex: 1 })], undefined, 5);
    const slot = file(project).skins![0]!.attachments!.a!;
    expect(slot["a (2)"]).toEqual({ path: "a", width: 40, height: 30, x: -20, y: 15 });
  });

  it("hides the slot where an extra display shows a symbol, and flattens the symbol there", () => {
    const { project, sym } = scene(["a"]);
    const inner = scene(["x"]);
    inner.sym.name = "Inner";
    for (const [id, item] of Object.entries(inner.project.items)) if (item.kind === "image") project.items[id as never] = item;
    project.items[inner.sym.id] = inner.sym;
    nodeNamed(sym, "a").extraDisplays = [{ itemId: inner.sym.id, pivot: { x: 0, y: 0 } }];
    track(sym, "a", [key(0, tf()), key(4, tf(), { displayIndex: 1 })], undefined, 5);
    const f = file(project);
    expect(f.animations!.animation!.slots!.a!.attachment!.map((k) => k.name)).toEqual(["a", null]);
    const x = "a/Inner/x";
    expect(f.slots!.map((s) => s.name)).toEqual(["a", x]);
    expect(f.slots!.find((s) => s.name === x)!.attachment).toBeUndefined();   // not display 0: hidden in the setup pose
    expect(f.animations!.animation!.slots![x]!.attachment!.map((k) => k.name)).toEqual([null, "x"]);
  });
});

describe("IK", () => {
  function chain(chainLength: 0 | 1, weight = 1, bendPositive = true) {
    const project = createProject("IK");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const upper = add(sym, createNode("bone", "upper"));
    const lower = add(sym, createNode("bone", "lower", { parentId: upper.id, x: 40 }));
    const target = add(sym, createNode("bone", "target", { x: 70, y: 20 }));
    sym.ik.push({ id: newIkId(), name: "leg", boneId: lower.id, targetId: target.id, chain: chainLength, bendPositive, weight });
    return project;
  }

  it("writes a two-bone chain as [parent, child] the way the parser reads it", () => {
    const project = chain(1);
    expect(file(project).constraints).toEqual([
      { type: "ik", name: "leg", bones: ["upper", "lower"], target: "target", bendPositive: false },
    ]);
    expect(load(project).data.constraints).toHaveLength(1);
  });

  it("writes a look-at as one bone, and what differs from the parser's defaults", () => {
    const project = chain(0, 0.5, false);
    expect(file(project).constraints).toEqual([{ type: "ik", name: "leg", bones: ["lower"], target: "target", mix: 0.5 }]);
  });

  it("inverts the bend: the y flip mirrors the chain", () => {
    // Checked against the runtime by the stickman in spineParity.test.ts.
    expect(file(chain(1, 1, true)).constraints![0]!.bendPositive).toBe(false);
    expect(file(chain(1, 1, false)).constraints![0]!.bendPositive).toBeUndefined();
  });

  it("writes every bone's length, which the two-bone solve uses", () => {
    const project = chain(1);
    expect(file(project).bones.find((b) => b.name === "lower")!.length).toBe(40);
  });
});

describe("what does not reach the file", () => {
  it("drops an excluded layer's bone, slot, timelines and image, and says so", () => {
    const { project, sym } = scene(["keep", "drop"]);
    track(sym, "drop", [key(0, tf()), key(4, tf(10, 0))], undefined, 5);
    sym.layers.find((l) => l.name === "drop")!.excludeFromExport = true;
    const result = exportBoneBurst(project);
    expect(result.skeleton.bones.map((b) => b.name)).toEqual([ROOT_BONE, "keep"]);
    expect(result.skeleton.slots!.map((s) => s.name)).toEqual(["keep"]);
    expect(result.skeleton.animations!.animation!.bones).toBeUndefined();
    expect(result.usedImages).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.message.includes('"drop"'))).toBe(true);
  });

  it("takes the whole subtree of an excluded group with it", () => {
    const { project, sym } = scene(["keep", "child"]);
    const group = add(sym, createNode("group", "grp"));
    new History(project).apply(new SetParent(sym.id, [nodeNamed(sym, "child").id as NodeId], group.id));
    new History(project).apply(new SetLayerExcluded(sym.id, [sym.layers.find((l) => l.name === "grp")!.id], true));
    expect(file(project).bones.map((b) => b.name)).toEqual([ROOT_BONE, "keep"]);
  });

  it("leaves the names of the layers it keeps alone", () => {
    const { project, sym } = scene(["art", "art"]);
    sym.layers[0]!.excludeFromExport = true;           // the top "art"
    expect(file(project).slots!.map((s) => s.name)).toEqual(["art_2"]);
  });

  it("exports an empty layer as nothing at all", () => {
    const { project, sym } = scene(["art"]);
    add(sym, createNode("empty", "Layer 1"));
    expect(file(project).bones.map((b) => b.name)).toEqual([ROOT_BONE, "art"]);
    expect(file(project).slots!.map((s) => s.name)).toEqual(["art"]);
  });

  it("keeps an empty node's bone when a kept node is parented under it", () => {
    const { project, sym } = scene(["art"]);
    const empty = add(sym, createNode("empty", "Layer 1"));
    nodeNamed(sym, "art").parentId = empty.id;
    const bones = file(project).bones;
    expect(bones.map((b) => b.name).sort()).toEqual(["Layer 1", "art", ROOT_BONE].sort());
    expect(bones.find((b) => b.name === "art")!.parent).toBe("Layer 1");
    expect(file(project).slots!.map((s) => s.name)).toEqual(["art"]);
  });

  it("clips a mask's layers with a clip slot right before them, through the last", () => {
    const { project, sym } = scene(["under", "a", "b", "mask"]);   // layers: mask, b, a, under
    const mask = sym.layers.find((l) => l.name === "mask")!;
    mask.isMask = true;
    for (const n of ["a", "b"]) sym.layers.find((l) => l.name === n)!.maskedBy = mask.id;
    const f = file(project);
    expect(f.slots!.map((s) => s.name)).toEqual(["under", "mask", "a", "b"]);
    const clip = f.skins![0]!.attachments!.mask!.mask as { type: string; end: string; vertexCount: number };
    expect(clip).toMatchObject({ type: "clipping", end: "b", vertexCount: 4 });
    expect(f.slots!.find((s) => s.name === "mask")!.attachment).toBe("mask");
  });

  it("draws a mask's layers together where the first is, as the stage does", () => {
    const { project, sym } = scene(["a", "between", "b", "mask"]);   // layers: mask, b, between, a
    const mask = sym.layers.find((l) => l.name === "mask")!;
    mask.isMask = true;
    for (const n of ["a", "b"]) sym.layers.find((l) => l.name === n)!.maskedBy = mask.id;
    expect(file(project).slots!.map((s) => s.name)).toEqual(["mask", "a", "b", "between"]);
  });

  it("drops the clip of an excluded mask, leaving its layers unclipped", () => {
    const { project, sym } = scene(["a", "mask"]);
    const mask = sym.layers.find((l) => l.name === "mask")!;
    mask.isMask = true;
    sym.layers.find((l) => l.name === "a")!.maskedBy = mask.id;
    mask.excludeFromExport = true;
    expect(file(project).slots!.map((s) => s.name)).toEqual(["a"]);
  });

  it("clips with the traced outline, placed about the mask's transform point", () => {
    const { project, sym } = scene(["a", "mask"], [40, 20]);
    const mask = sym.layers.find((l) => l.name === "mask")!;
    mask.isMask = true;
    sym.layers.find((l) => l.name === "a")!.maskedBy = mask.id;
    nodeNamed(sym, "mask").pivot = { x: 10, y: 5 };
    const out = exportBoneBurst(project, undefined, {
      maskShape: () => ({ points: [0, 0, 40, 0, 20, 20], islands: 0, holes: 0, soft: true }),
    });
    const clip = out.skeleton.skins![0]!.attachments!.mask!.mask as { vertices: number[] };
    expect(clip.vertices).toEqual([-10, 5, 30, 5, 10, -15]);
    expect(out.diagnostics.some((d) => d.message.includes("soft edges"))).toBe(true);
  });

  it("warns about a mask that shows a symbol, or is partly transparent", () => {
    const { project, sym } = scene(["a", "mask"]);
    const mask = sym.layers.find((l) => l.name === "mask")!;
    mask.isMask = true;
    sym.layers.find((l) => l.name === "a")!.maskedBy = mask.id;
    nodeNamed(sym, "mask").color = { rM: 100, gM: 100, bM: 100, aM: 50, rO: 0, gO: 0, bO: 0, aO: 0 };
    expect(messages(project).some((m) => m.includes("partly transparent"))).toBe(true);
  });
});

describe("nested symbols", () => {
  /** A scene holding one instance of a symbol with one image. */
  function withInstance(pivot = { x: 0, y: 0 }) {
    const { project, sym } = scene(["x"]);
    const inner = createSymbol("Inner");
    const xNode = nodeNamed(sym, "x");
    // Move the image into the symbol.
    delete sym.nodes[xNode.id];
    sym.layers = sym.layers.filter((l) => l.nodeId !== xNode.id);
    inner.nodes[xNode.id] = xNode;
    inner.layers.push(createLayer(xNode.id, "x", 0));
    project.items[inner.id] = inner;
    const inst = add(sym, createNode("symbol", "inst", { itemId: inner.id, x: 50, y: 60, pivotX: pivot.x, pivotY: pivot.y }));
    return { project, sym, inner, inst };
  }

  it("hangs the symbol's contents off a content bone at −pivot, leaving bones on the instance alone", () => {
    const { project, sym, inst } = withInstance({ x: 10, y: 20 });
    add(sym, createNode("bone", "hand", { parentId: inst.id, x: 5 }));
    const bones = file(project).bones;
    expect(bones.find((b) => b.name === "inst/Inner")).toEqual({ name: "inst/Inner", parent: "inst", x: -10, y: 20 });
    expect(bones.find((b) => b.name === "inst/Inner/x")!.parent).toBe("inst/Inner");
    expect(bones.find((b) => b.name === "hand")!.parent).toBe("inst");
  });

  it("writes no offset when the transform point is at the origin", () => {
    const { project } = withInstance();
    expect(file(project).bones.find((b) => b.name === "inst/Inner")).toEqual({ name: "inst/Inner", parent: "inst" });
  });

  it("leaves out a symbol only an excluded layer shows, art and all", () => {
    const { project, sym } = withInstance();
    sym.layers.find((l) => l.name === "inst")!.excludeFromExport = true;
    const out = exportBoneBurst(project);
    expect(out.skeleton.bones.map((b) => b.name)).toEqual([ROOT_BONE]);
    expect(out.usedImages).toEqual([]);
  });

  it("still exports a symbol a kept layer shows too", () => {
    const { project, sym, inner } = withInstance();
    add(sym, createNode("symbol", "second", { itemId: inner.id }));
    sym.layers.find((l) => l.name === "inst")!.excludeFromExport = true;
    expect(file(project).slots!.map((s) => s.name)).toEqual(["second/Inner/x"]);
  });

  it("refuses symbols that contain each other instead of recursing", () => {
    const { project, inner } = withInstance();
    const back = createNode("symbol", "back", { itemId: project.rootSymbolId });
    inner.nodes[back.id] = back;
    inner.layers.unshift(createLayer(back.id, "back", 1));
    expect(messages(project).some((m) => m.startsWith("error") && m.includes("contain each other"))).toBe(true);
  });

  it("names every bone uniquely, the path in the name", () => {
    const { project, sym, inner } = withInstance();
    add(sym, createNode("symbol", "inst2", { itemId: inner.id }));
    const names = file(project).bones.map((b) => b.name);
    expect(names).toContain("inst/Inner/x");
    expect(names).toContain("inst2/Inner/x");
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the .atlas file", () => {
  const trimmed: PackedPage = {
    name: "p", imagePath: "rig_tex.png", width: 128, height: 64, scale: 1,
    regions: [
      { name: "a", x: 2, y: 3, width: 30, height: 20, offsetX: 5, offsetY: 4,
        originalWidth: 40, originalHeight: 30, rotated: false },
      { name: "b", x: 40, y: 0, width: 16, height: 16, offsetX: 0, offsetY: 0,
        originalWidth: 16, originalHeight: 16, rotated: false },
    ],
  };

  it("writes the fields spine-core reads, offsets counted from the bottom", () => {
    expect(atlasText([trimmed])).toBe([
      "rig_tex.png", "size:128,64", "filter:Linear,Linear",
      "a", "bounds:2,3,30,20", "offsets:5,6,40,30",
      "b", "bounds:40,0,16,16", "",
    ].join("\n"));
    const region = new TextureAtlas(atlasText([trimmed])).findRegion("a")!;
    expect([region.x, region.y, region.width, region.height]).toEqual([2, 3, 30, 20]);
    expect([region.offsetX, region.offsetY, region.originalWidth, region.originalHeight]).toEqual([5, 6, 40, 30]);
  });

  /** The trimmed pixels' corners in the runtime, against where the stage
   *  draws the same pixels: inside the full image at −pivot. */
  function trimmedCorners(page: PackedPage, fullWidth: number, fullHeight: number) {
    const { project, sym } = scene(["a"], [fullWidth, fullHeight]);
    nodeNamed(sym, "a").pivot = { x: 7, y: 9 };
    nodeNamed(sym, "a").bind = tf(100, 50, 20, 20);
    const skeleton = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(atlasText([page]))))
      .readSkeletonData(JSON.parse(boneburstJson(exportBoneBurst(project).skeleton))));
    skeleton.updateWorldTransform(Physics.none);
    const slot = skeleton.findSlot("a")!;
    const attachment = slot.appliedPose.getAttachment() as RegionAttachment;
    const verts = new Array<number>(8);
    attachment.computeWorldVertices(slot, attachment.getOffsets(slot.appliedPose), verts, 0, 2);
    return verts;
  }

  it("puts a trimmed region's pixels where the stage draws them", () => {
    const verts = trimmedCorners(trimmed, 40, 30);
    // Stage: the trimmed rect spans x 5..35, y 4..24 of the image, drawn at
    // −pivot and rotated 20° about the bone at (100, 50), then y flipped.
    const r = 20 * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const at = (x: number, y: number) => {
      const lx = x - 7, ly = y - 9;
      return [100 + lx * c - ly * s, -(50 + lx * s + ly * c)];
    };
    const want = [at(5, 24), at(5, 4), at(35, 4), at(35, 24)].flat();
    verts.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 4));
  });

  it("draws a half-resolution atlas at full size", () => {
    const half: PackedPage = { ...trimmed, scale: 0.5, regions: [
      { name: "a", x: 1, y: 1, width: 15, height: 10, offsetX: 2, offsetY: 2,
        originalWidth: 20, originalHeight: 15, rotated: false },
    ] };
    const verts = trimmedCorners(half, 40, 30);
    const xs = [verts[0]!, verts[2]!, verts[4]!, verts[6]!];
    const ys = [verts[1]!, verts[3]!, verts[5]!, verts[7]!];
    // 15 of 20 atlas px across a 40px image: 30px wide on screen, whatever the rotation.
    const width = Math.hypot(xs[3]! - xs[0]!, ys[3]! - ys[0]!);
    expect(width).toBeCloseTo(30, 4);
  });

  it("refuses a rotated region rather than guess its direction", () => {
    const rotated = { ...trimmed, regions: [{ ...trimmed.regions[1]!, rotated: true }] };
    expect(() => atlasText([rotated])).toThrow(/rotated/);
  });
});

describe("the runtime plays the key times", () => {
  it("seeks each key onto its own frame", () => {
    const { project, sym } = scene(["a"]);
    project.frameRate = 60;
    track(sym, "a", Array.from({ length: 30 }, (_, f) => key(f, tf(f, 0), { tween: { kind: "none" } })), 29, 30);
    const skeleton = load(project);
    const animation = skeleton.data.findAnimation("animation")!;
    for (let f = 0; f < 30; f++) {
      skeleton.setupPose();
      animation.apply(skeleton, 0, f / 60, false, null, 1, MixFrom.setup, false, false, false);
      expect(skeleton.findBone("a")!.pose.x).toBe(f);
    }
  });
});

describe("symbol choice", () => {
  it("exports the symbol asked for", () => {
    const { project } = scene(["a"]);
    const inner = scene(["x", "y"]).sym;
    inner.name = "Inner";
    for (const n of Object.values(inner.nodes)) {
      const item = createImageItem(n.name, `asset_${n.name}` as AssetId, 10, 10);
      project.items[item.id] = item;
      n.itemId = item.id;
    }
    project.items[inner.id] = inner;
    expect(isSymbol(project.items[inner.id])).toBe(true);
    expect(exportBoneBurst(project, inner.id).skeleton.slots!.map((s) => s.name)).toEqual(["x", "y"]);
  });
});

/**
 * `sliceRuns` on its own: the stage's rules always start a nested run at
 * local frame 0, where a key sits, so a run starting inside a tween cannot
 * come from a document today. The path is kept for when it can.
 */
describe("laying a symbol's keys onto runs", () => {
  // One value, keyed 0 → 10 at frames 0 and 10, linear; the stage's value
  // at f is f.
  const channel: Channel<number> = {
    rows: [{ frame: 0, t: 0, stepped: false }, { frame: 10, t: 10, stepped: false }],
    at: (f) => Math.min(10, f),
  };
  const anim = {} as never;

  it("bakes from a start inside a tween up to the next key, then copies", () => {
    // Symbol frames 4..11 at root frames 0..7: 4..9 baked, the key at 10
    // copied (root frame 6), held after.
    const rows = sliceRuns([{ start: 0, end: 8, anim, local0: 4 }], () => channel);
    expect(rows.map((r) => [r.frame, r.t])).toEqual([[0, 4], [1, 5], [2, 6], [3, 7], [4, 8], [5, 9], [6, 10]]);
  });

  it("copies whole intervals, steps the last key before another run, and ends a tween on a key at the run's end", () => {
    const rows = sliceRuns([
      { start: 0, end: 10, anim, local0: 0 },
      { start: 12, end: 22, anim, local0: 0 },
    ], () => channel);
    expect(rows.map((r) => [r.frame, r.t, r.stepped])).toEqual([
      [0, 0, false], [10, 10, true], [12, 0, false], [22, 10, false],
    ]);
  });

  it("bakes a tween cut by the next run starting right where it ends", () => {
    const rows = sliceRuns([
      { start: 0, end: 5, anim, local0: 0 },
      { start: 5, end: 15, anim, local0: 0 },
    ], () => channel);
    expect(rows.slice(0, 5).map((r) => [r.frame, r.t])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(rows[4]!.stepped).toBe(true);
    expect(rows[5]).toMatchObject({ frame: 5, t: 0 });
  });
});
