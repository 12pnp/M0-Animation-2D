import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MeshAttachment, MixFrom, Physics, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { reseed, type ItemId, type NodeId } from "@/core/doc/ids";
import { deformKeysOf, drawnDeformTarget, withDeformKeysOf } from "@/core/mesh/deform";
import { deformRow } from "@/core/mesh/meshPlan";
import { evaluateSymbol } from "@/core/doc/pose";
import { validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { atlasText } from "@/core/boneburst/atlas";
import { isImage, type Animation, type DeformKey, type MeshData, type Project, type SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";

beforeEach(() => reseed());

const N = "n1" as NodeId;
const k = (frame: number, ...offsets: number[]): DeformKey => ({ frame, offsets });

describe("which display a list of deform keys is", () => {
  it.each([
    { name: "the default skin's display 0: Animation.deforms", t: { nodeId: N, skin: null, index: 0 }, field: "deforms" },
    { name: "the node's own display 2", t: { nodeId: N, skin: null, index: 2 }, field: "displayDeforms.default" },
    { name: "a skin's display 0", t: { nodeId: N, skin: "alt", index: 0 }, field: "displayDeforms.alt" },
  ])("$name", ({ t, field }) => {
    const anim = { id: "a", name: "a", duration: 10, playTimes: 0, tracks: {} } as unknown as Animation;
    const set = { ...anim, ...withDeformKeysOf(anim, t, [k(0, 1, 2)]) };
    expect(deformKeysOf(set, t)).toEqual([k(0, 1, 2)]);
    expect(field === "deforms" ? !!set.deforms : !!set.displayDeforms?.[field.split(".")[1]!]).toBe(true);
    const cleared = withDeformKeysOf(set, t, undefined);
    expect([cleared.deforms, cleared.displayDeforms]).toEqual([undefined, undefined]);
  });

  it.each([
    { name: "a mesh: its own keys, in its skin", d: { mesh: {} }, skin: "alt", index: 1, want: { nodeId: N, skin: "alt", index: 1 } },
    { name: "a link: its source's, in the skin the link names", d: { linked: { to: 0, skin: "alt" } }, skin: "other", index: 1, want: { nodeId: N, skin: "alt", index: 0 } },
    { name: "a link naming no skin: the default skin's", d: { linked: { to: 2 } }, skin: "alt", index: 1, want: { nodeId: N, skin: null, index: 2 } },
    { name: "a link without its source's keys: none", d: { linked: { to: 0, deform: false } }, skin: null, index: 1, want: null },
    { name: "an image: none", d: {}, skin: null, index: 0, want: null },
  ])("drawn with: $name", ({ d, skin, index, want }) => {
    expect(drawnDeformTarget(N, { itemId: "i" as ItemId, pivot: { x: 0, y: 0 }, ...d } as never, skin, index)).toEqual(want);
  });
});

/** spine-core playing the export: each mesh slot's world vertices, y down. */
function runtime(project: Project, skin: string | null): Skeleton {
  const out = exportBoneBurst(project);
  expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const regions = out.usedImages.map((id, i) => { const it = project.items[id]; if (!isImage(it)) throw new Error("image"); return { name: it.name, x: 0, y: i * 200, width: it.width, height: it.height, offsetX: 0, offsetY: 0, originalWidth: it.width, originalHeight: it.height, rotated: false }; });
  const atlas = new TextureAtlas(atlasText([{ name: "p", imagePath: "p.png", width: 512, height: 4096, scale: 1, regions }]));
  const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(boneburstJson(out.skeleton))));
  if (skin) sk.setSkin(skin);
  return sk;
}

describe("the stage plays every display's deform keys as spine-core plays the export", () => {
  it("display 0, another display and a skin's display, each with its own keys", async () => {
    const { project, rig } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!;
    const head = Object.values(project.items).find((i) => i.name === "head")!;
    const box = (w: number, h: number): MeshData => ({ width: w, height: h, points: [0, 0, w, 0, w, h, 0, h], triangles: [0, 1, 2, 0, 2, 3], hull: 4 });
    const t = project.items[torso.itemId!] as { width: number; height: number };
    const hd = head as unknown as { width: number; height: number };
    rig.nodes[torso.id] = { ...torso, mesh: box(t.width, t.height), extraDisplays: [{ itemId: head.id, pivot: { x: hd.width / 2, y: hd.height / 2 }, mesh: box(hd.width, hd.height) }] };
    rig.skins = [{ name: "alt", displays: { [torso.id]: { 0: { itemId: head.id, pivot: { x: 4, y: 4 }, mesh: box(hd.width, hd.height), key: torso.name } } } }];
    const anim = rig.animations[0]!;
    const tk = anim.tracks[torso.id];
    // Display 0 for frames 0-4, display 1 after.
    anim.tracks[torso.id] = { nodeId: torso.id, endFrame: anim.duration - 1, keys: [{ ...(tk?.keys[0] ?? { transform: torso.bind, tween: { kind: "none" } }), frame: 0, displayIndex: 0 }, { ...(tk?.keys[0] ?? { transform: torso.bind, tween: { kind: "none" } }), frame: 5, displayIndex: 1 }] } as never;
    anim.deforms = { [torso.id]: [k(0, 0, 0, 0, 0, 0, 0, 0, 0), k(4, 8, 0, 8, 0, 0, 0, 0, 0)] };
    anim.displayDeforms = {
      default: { [torso.id]: { 1: [k(5, 0, 0, 0, 0, 0, 0, 0, 0), { ...k(9, 0, -6, 0, -6, 0, 0, 0, 0), tween: { kind: "none" } }, k(12, 3, 3, 3, 3, 3, 3, 3, 3)] } },
      alt: { [torso.id]: { 0: [k(0, 0, 0, 0, 0, 0, 0, 0, 0), k(4, -5, 2, -5, 2, 0, 0, 0, 0)] } },
    };
    for (const skin of [null, "alt"] as const) {
      const sk = runtime(project, skin);
      let checked = 0, moved = 0;
      for (let f = 0; f < Math.min(anim.duration, 14); f++) {
        sk.setupPose();
        sk.data.findAnimation(anim.name)!.apply(sk, 0, f / project.frameRate, false, null, 1, MixFrom.setup, false, false, false);
        sk.updateWorldTransform(Physics.reset);
        const e = evaluateSymbol(rig, anim, f, "animate", skin ? [skin] : []).byNode.get(torso.id)!;
        const slot = sk.slots.find((s) => s.data.name === torso.name)!;
        const att = slot.appliedPose.getAttachment();
        if (!(att instanceof MeshAttachment) || !e.spine) continue;
        const v = new Array<number>(att.worldVerticesLength);
        att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, v, 0, 2);
        const still = evaluateSymbol(rig, null, 0, "setup", skin ? [skin] : []).byNode.get(torso.id)!;
        v.forEach((x, i) => expect(i % 2 ? -x : x, `${skin} frame ${f} vertex ${i >> 1}`).toBeCloseTo(e.spine!.vertices[i]!, 3));
        if (e.displayIndex === (f < 5 ? 0 : 1)) checked++;
        moved = Math.max(moved, ...e.spine.vertices.map((x, i) => Math.abs(x - (still.spine?.vertices[i] ?? x))));
      }
      expect(checked, `${skin}`).toBeGreaterThan(8);
      expect(moved, `${skin}: the keys moved something`).toBeGreaterThan(1);
    }
  });

  it("export then open: each display's keys come back where they were; loading keeps them", async () => {
    const { project, rig } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!;
    const t = project.items[torso.itemId!] as { width: number; height: number };
    const mesh: MeshData = { width: t.width, height: t.height, points: [0, 0, t.width, 0, t.width, t.height], triangles: [0, 1, 2], hull: 3 };
    rig.nodes[torso.id] = { ...torso, mesh, extraDisplays: [{ itemId: torso.itemId!, pivot: torso.pivot, mesh, key: "second" }] };
    rig.animations[0]!.displayDeforms = { default: { [torso.id]: { 1: [k(0, 0, 0, 0, 0, 0, 0), k(6, 2, 2, 0, 0, 0, 0)] } } };
    const images = new Map(Object.values(project.items).filter((i) => i.kind === "image").map((i) => [i.name, { name: i.name, width: (i as { width: number }).width, height: (i as { height: number }).height, assetId: (i as unknown as { assetId: never }).assetId }]));
    const opened = importBoneBurst(exportBoneBurst(project).skeleton as never, "stickman", images).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const back = Object.values(sym.nodes).find((n) => n.name === torso.name && n.kind === "image")!;
    const anim = sym.animations.find((a) => a.name === rig.animations[0]!.name)!;
    expect(deformKeysOf(anim, { nodeId: back.id, skin: null, index: 1 })?.map((x) => x.frame)).toEqual([0, 6]);
    expect(anim.spine?.attachments).toBeUndefined();
    const loaded = validateProject(migrate(JSON.parse(JSON.stringify(opened)))).project.items[opened.rootSymbolId] as SymbolItem;
    expect(loaded.animations.find((a) => a.name === anim.name)!.displayDeforms).toEqual(anim.displayDeforms);
  });
});

describe("the Deform row", () => {
  it("shows the mesh the stage shows: a skin's when a shown skin fills the display", async () => {
    const { rig } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!;
    const mesh: MeshData = { width: 4, height: 4, points: [0, 0, 4, 0, 4, 4], triangles: [0, 1, 2], hull: 3 };
    rig.nodes[torso.id] = { ...torso, mesh };
    rig.skins = [{ name: "alt", displays: { [torso.id]: { 0: { itemId: torso.itemId!, pivot: torso.pivot, mesh } } } }];
    expect(deformRow(rig, rig.nodes[torso.id]!, [])!.target).toEqual({ nodeId: torso.id, skin: null, index: 0 });
    expect(deformRow(rig, rig.nodes[torso.id]!, ["alt"])!.target).toEqual({ nodeId: torso.id, skin: "alt", index: 0 });
  });
});

describe("spine-unity's samples", () => {
  it.skipIf(!sampleRigs().some((r) => r.name === "Goblins"))("Goblins' skin deform timelines become keys", () => {
    const r = sampleRigs().find((x) => x.name === "Goblins")!;
    const project = importBoneBurst(JSON.parse(r.json), r.name, imagesOf(r.atlas)).project;
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const lists = sym.animations.flatMap((a) => Object.values(a.displayDeforms?.goblin ?? {}).concat(Object.values(a.displayDeforms?.goblingirl ?? {})));
    expect(lists.length).toBeGreaterThan(0);
    expect(sym.animations.some((a) => (a.spine?.attachments as Record<string, unknown> | undefined)?.goblin)).toBe(false);
  });
});
