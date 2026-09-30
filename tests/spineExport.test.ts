import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasAttachmentLoader, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas,
} from "@esotericsoftware/spine-core";
import { reseed, newIkId, type AssetId, type NodeId } from "@/core/doc/ids";
import { createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { isSymbol, type Keyframe, type Node, type Project, type SymbolItem } from "@/core/doc/types";
import { History } from "@/core/history/History";
import { SetLayerExcluded, SetParent } from "@/core/history/commands";
import { tf, type Transform } from "@/core/math/Transform";
import type { PackedPage } from "@/core/atlas/packed";
import { atlasText } from "@/core/spine/atlas";
import { colorHex, exportSpine, ROOT_BONE, spineJson } from "@/core/spine/exportSpine";
import { keyTime } from "@/core/spine/transform";
import { SPINE_VERSION, type SpineSkeletonFile } from "@/core/spine/types";

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

const file = (project: Project): SpineSkeletonFile => exportSpine(project).skeleton;
const messages = (project: Project) => exportSpine(project).diagnostics.map((d) => `${d.severity}: ${d.message}`);

/** The export loaded by the runtime, with a plain untrimmed atlas. */
function load(project: Project): Skeleton {
  const exported = exportSpine(project);
  const regions = exported.usedImages.map((id, i) => {
    const item = project.items[id] as { name: string; width: number; height: number };
    return { name: item.name, x: 0, y: i * 100, width: item.width, height: item.height, offsetX: 0, offsetY: 0,
      originalWidth: item.width, originalHeight: item.height, rotated: false };
  });
  const page: PackedPage = { name: "p", imagePath: "p.png", width: 512, height: 512, scale: 1, regions };
  const atlas = new TextureAtlas(atlasText([page]));
  return new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(spineJson(exported.skeleton))));
}

/* ── the file ── */

describe("skeleton structure", () => {
  it("writes the 4.3 header spine-unity checks, and the frame rate", () => {
    const { project } = scene(["a"]);
    expect(file(project).skeleton).toEqual({ spine: SPINE_VERSION, fps: 24 });
    expect(SPINE_VERSION.split(".").slice(0, 2)).toEqual(["4", "3"]);
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

  it("warns that colour offsets are not carried yet", () => {
    const { project, sym } = scene(["a"]);
    nodeNamed(sym, "a").color = { ...neutral, rO: 40 };
    expect(messages(project).some((m) => m.includes("colour offsets"))).toBe(true);
  });

  it("maps the blend modes Spine has, and warns for the rest", () => {
    const { project, sym } = scene(["a", "b"]);
    nodeNamed(sym, "a").blendMode = "add";
    nodeNamed(sym, "b").blendMode = "overlay";
    const slots = file(project).slots!;
    expect(slots.find((s) => s.name === "a")!.blend).toBe("additive");
    expect(slots.find((s) => s.name === "b")!.blend).toBeUndefined();
    expect(messages(project).some((m) => m.includes('"overlay"'))).toBe(true);
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

  it("warns about a symbol reached through an extra display, and hides the slot there", () => {
    const { project, sym } = scene(["a"]);
    const inner = scene(["x"]).sym;
    inner.name = "Inner";
    project.items[inner.id] = inner;
    nodeNamed(sym, "a").extraDisplays = [{ itemId: inner.id, pivot: { x: 0, y: 0 } }];
    track(sym, "a", [key(0, tf()), key(4, tf(), { displayIndex: 1 })], undefined, 5);
    expect(messages(project).some((m) => m.includes('"Inner"'))).toBe(true);
    expect(file(project).animations!.animation!.slots!.a!.attachment!.map((k) => k.name)).toEqual(["a", null]);
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
    expect(file(project).constraints).toEqual([{ type: "ik", name: "leg", bones: ["upper", "lower"], target: "target" }]);
    expect(load(project).data.constraints).toHaveLength(1);
  });

  it("writes a look-at as one bone, and what differs from the parser's defaults", () => {
    const project = chain(0, 0.5, false);
    expect(file(project).constraints).toEqual([
      { type: "ik", name: "leg", bones: ["lower"], target: "target", mix: 0.5, bendPositive: false },
    ]);
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
    const result = exportSpine(project);
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

  it("warns that nested symbols and masks are not carried yet", () => {
    const { project, sym } = scene(["art", "mask"]);
    sym.layers.find((l) => l.name === "mask")!.isMask = true;
    const inner = scene(["x"]).sym;
    project.items[inner.id] = inner;
    add(sym, createNode("symbol", "instance", { itemId: inner.id }));
    const text = messages(project).join("\n");
    expect(text).toContain("mask layers");
    expect(text).toContain("symbol instances");
    expect(file(project).slots!.map((s) => s.name)).toEqual(["art"]);
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
      .readSkeletonData(JSON.parse(spineJson(exportSpine(project).skeleton))));
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
    expect(exportSpine(project, inner.id).skeleton.slots!.map((s) => s.name)).toEqual(["x", "y"]);
  });
});
