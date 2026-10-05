import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, RegionAttachment, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createImageItem, createLayer, createNode } from "@/core/doc/defaults";
import { bakedSequenceKeys, sequenceIndexAt } from "@/core/doc/sequence";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { atlasText } from "@/core/boneburst/atlas";
import { isImage, type MeshData, type Project, type SequenceKey, type SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

/** spine-core over `file`, the project's images packed one under another. */
function skeletonOf(project: Project, file: unknown): Skeleton {
  const images = Object.values(project.items).filter(isImage);
  const regions = images.map((it, i) => ({ name: it.name, x: 0, y: i * 200, width: it.width, height: it.height, offsetX: 0, offsetY: 0, originalWidth: it.width, originalHeight: it.height, rotated: false }));
  const atlas = new TextureAtlas(atlasText([{ name: "p", imagePath: "p.png", width: 512, height: 8192, scale: 1, regions }]));
  return new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(typeof file === "string" ? file : JSON.stringify(file))));
}

const imagesOf = (project: Project) => new Map(Object.values(project.items).filter(isImage).map((i) => [i.name, { name: i.name, width: i.width, height: i.height, assetId: i.assetId }]));

/** Each slot's world vertices at every whole frame of `anim`. */
function vertices(sk: Skeleton, anim: string, fps: number, frames: number, slot: string): number[][] {
  const out: number[][] = [];
  for (let f = 0; f < frames; f++) {
    sk.setupPose();
    sk.data.findAnimation(anim)!.apply(sk, 0, f / fps, false, null, 1, MixFrom.setup, false, false, false);
    sk.updateWorldTransform(Physics.reset);
    const s = sk.slots.find((x) => x.data.name === slot)!, att = s.appliedPose.getAttachment();
    if (att instanceof MeshAttachment) {
      const v = new Array<number>(att.worldVerticesLength);
      att.computeWorldVertices(sk, s, 0, att.worldVerticesLength, v, 0, 2);
      out.push(v);
    } else if (att instanceof RegionAttachment) {
      out.push([att.sequence.resolveIndex(s.appliedPose)]);
    } else out.push([]);
  }
  return out;
}

describe("deform keys between frames", () => {
  it("open: written frame by frame, played as spine-core plays the file at every frame", async () => {
    const { project, rig } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!;
    const t = project.items[torso.itemId!] as { width: number; height: number };
    const mesh: MeshData = { width: t.width, height: t.height, points: [0, 0, t.width, 0, t.width, t.height, 0, t.height], triangles: [0, 1, 2, 0, 2, 3], hull: 4 };
    rig.nodes[torso.id] = { ...torso, mesh };
    const anim = rig.animations[0]!;
    anim.deforms = { [torso.id]: [{ frame: 0, offsets: new Array(8).fill(0), tween: { kind: "curve", curve: [0.3, 0, 0.6, 1] } }, { frame: 6, offsets: [10, 0, 10, 0, 0, 5, 0, 5] }, { frame: 12, offsets: new Array(8).fill(0), tween: { kind: "none" } }, { frame: 15, offsets: [0, -8, 0, -8, 0, 0, 0, 0] }] };
    const file = exportBoneBurst(project).skeleton as unknown as { animations: Record<string, { attachments: Record<string, Record<string, Record<string, { deform: Array<{ time?: number; curve?: number[] }> }>>> }> };
    const deform = file.animations[anim.name]!.attachments.default![torso.name]![Object.keys(file.animations[anim.name]!.attachments.default![torso.name]!)[0]!]!.deform;
    // Move the middle keys off the frames (their curves with them).
    const fps = project.frameRate;
    for (const k of deform) {
      if (!k.time || k.time >= 15 / fps) continue;
      const shift = 0.37 / fps;
      k.time += shift;
      if (Array.isArray(k.curve)) { k.curve[0] += shift; k.curve[2] += shift; }
    }
    const result = importBoneBurst(file as never, "stickman", imagesOf(project));
    const sym = result.project.items[result.project.rootSymbolId] as SymbolItem;
    const opened = sym.animations.find((a) => a.name === anim.name)!;
    const node = Object.values(sym.nodes).find((n) => n.name === torso.name && n.kind === "image")!;
    expect(node.mesh).toBeDefined();
    expect(opened.deforms?.[node.id]?.length).toBeGreaterThan(8);
    expect((opened.spine?.attachments as Record<string, unknown> | undefined)?.default).toBeUndefined();
    const frames = Math.min(anim.duration, 20);
    const want = vertices(skeletonOf(project, file), anim.name, fps, frames, torso.name);
    const got = vertices(skeletonOf(result.project, boneburstJson(exportBoneBurst(result.project).skeleton)), anim.name, fps, frames, torso.name);
    got.forEach((v, f) => v.forEach((x, i) => expect(x, `frame ${f} ${i}`).toBeCloseTo(want[f]![i]!, 3)));
  });
});

describe("sequence keys between frames", () => {
  const k = (frame: number, mode: SequenceKey["mode"], index: number, delay: number): SequenceKey => ({ frame, mode, index, delay });
  it.each([
    { name: "a loop starting between frames", keys: [k(2.4, "loop", 0, 1.5)] },
    { name: "a hold, then a ping-pong between frames", keys: [k(0, "hold", 2, 1), k(3.6, "pingpong", 1, 0.8)] },
  ])("held keys showing at every frame what the keys show: $name", ({ keys }) => {
    const baked = bakedSequenceKeys(keys, 20, 5, 1);
    expect(baked.every((x) => Number.isInteger(x.frame) && x.mode === "hold")).toBe(true);
    for (let f = 0; f <= 20; f++) expect(sequenceIndexAt(baked, f, 5, 1), `frame ${f}`).toBe(sequenceIndexAt(keys, f, 5, 1));
  });

  it("open: the images spine-core shows, at every frame", async () => {
    const { project, rig, node } = await loadStickman();
    const frames = ["fx_08", "fx_09", "fx_10", "fx_11", "fx_12"].map((n) => {
      const item = createImageItem(n, `asset_${n}` as AssetId, 24, 16);
      project.items[item.id] = item;
      project.itemOrder.push(item.id);
      return item.id;
    });
    const fx = createNode("image", "fx", { parentId: node("arm_near_fore"), itemId: frames[0], pivotX: 4, pivotY: 8 });
    fx.sequence = { items: frames, setup: 2 };
    rig.nodes[fx.id] = fx;
    rig.layers.unshift(createLayer(fx.id, fx.name, rig.layers.length));
    const anim = rig.animations[0]!;
    anim.sequences = { [fx.id]: [k(2, "loop", 0, 1), k(9, "pingpong", 3, 2)] };
    const file = exportBoneBurst(project).skeleton as unknown as { animations: Record<string, { attachments: { default: Record<string, Record<string, { sequence: Array<{ time?: number }> }>> } }> };
    const seq = file.animations[anim.name]!.attachments.default.fx!.fx_08!.sequence;
    const fps = project.frameRate;
    for (const key of seq) key.time = (key.time ?? 0) + 0.45 / fps;
    const result = importBoneBurst(file as never, "stickman", imagesOf(project));
    const sym = result.project.items[result.project.rootSymbolId] as SymbolItem;
    const opened = sym.animations.find((a) => a.name === anim.name)!;
    const back = Object.values(sym.nodes).find((n) => n.name === "fx" && n.kind === "image")!;
    expect(opened.sequences?.[back.id]?.every((x) => x.mode === "hold")).toBe(true);
    const n = Math.min(anim.duration, 24);
    const want = vertices(skeletonOf(project, file), anim.name, fps, n, "fx");
    const got = vertices(skeletonOf(result.project, boneburstJson(exportBoneBurst(result.project).skeleton)), anim.name, fps, n, "fx");
    expect(got).toEqual(want);
  });
});
