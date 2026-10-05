import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, BoundingBoxAttachment, Physics, PointAttachment, Skeleton, SkeletonJson, TextureAtlas, Vector2 } from "@esotericsoftware/spine-core";
import { reseed } from "@/core/doc/ids";
import { createLayer, createNode } from "@/core/doc/defaults";
import { outlineSkin, skinnedOutline } from "@/core/doc/boxes";
import { evaluateSymbol } from "@/core/doc/pose";
import { validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";
import { SetSkinOutline } from "@/core/history/skinCommands";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { atlasText } from "@/core/boneburst/atlas";
import { apply } from "@/core/math/Matrix2D";
import type { Project, SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

/** The stickman with a box on the chest and a point on the head, each with a skin's own. */
async function rig() {
  const { project, rig: sym, node } = await loadStickman();
  const box = { ...createNode("box", "hurt", { parentId: node("chest") }), box: { points: [-10, -10, 10, -10, 10, 10] } };
  const point = createNode("point", "eye", { parentId: node("head") });
  for (const n of [box, point]) { sym.nodes[n.id] = n; sym.layers.unshift(createLayer(n.id, n.name, 0)); }
  sym.skins = [
    { name: "big", outlines: { [box.id]: { box: { points: [-30, -30, 30, -30, 30, 30, -30, 30] } }, [point.id]: { point: { x: 12, y: -4, rotation: 30 } } } },
    { name: "plain" },
  ];
  return { project, sym, box, point };
}

describe("a skin's own box, point or path", () => {
  it.each([
    { name: "no skin shown: the node's own", skins: [] as string[], want: null, points: 3 },
    { name: "a skin with its own: that", skins: ["big"], want: "big", points: 4 },
    { name: "a skin without one: the node's own", skins: ["plain"], want: null, points: 3 },
    { name: "the last shown skin with one wins", skins: ["big", "plain"], want: "big", points: 4 },
  ])("$name", async ({ skins, want, points }) => {
    const { sym, box } = await rig();
    expect(outlineSkin(sym, sym.nodes[box.id]!, skins)).toBe(want);
    expect(skinnedOutline(sym, sym.nodes[box.id]!, skins).box!.points.length / 2).toBe(points);
    expect(evaluateSymbol(sym, null, 0, "setup", skins).byNode.get(box.id)!.node.box!.points.length / 2).toBe(points);
  });

  it("an edit replaces the skin's own, and undo puts it back; the node's own is untouched", async () => {
    const { project, sym, box } = await rig();
    const cmd = new SetSkinOutline("Move Box Points", sym.id, "big", box.id, { box: { points: [0, 0, 5, 0, 5, 5] } }, "box.move");
    cmd.apply(project);
    expect(sym.skins![0]!.outlines![box.id]!.box!.points).toEqual([0, 0, 5, 0, 5, 5]);
    expect(sym.nodes[box.id]!.box!.points).toEqual([-10, -10, 10, -10, 10, 10]);
    cmd.revert(project);
    expect(sym.skins![0]!.outlines![box.id]!.box!.points).toHaveLength(8);
  });

  it("loading keeps outlines of nodes of that kind and drops the rest", async () => {
    const { project, sym, box, point } = await rig();
    sym.skins![1]!.outlines = { [point.id]: { box: { points: [0, 0, 1, 0, 1, 1] } }, [box.id]: { box: { points: [0, 0] } } };
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project.items[sym.id] as SymbolItem;
    expect(Object.keys(out.skins![0]!.outlines!)).toEqual([box.id, point.id]);
    expect(out.skins![1]!.outlines?.[box.id]).toBeUndefined();
    expect(out.skins![1]!.outlines?.[point.id]).toEqual({ point: { x: 0, y: 0, rotation: 0 } });
  });
});

function runtime(project: Project, skin: string): Skeleton {
  const out = exportBoneBurst(project);
  expect(out.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const regions = out.usedImages.map((id, i) => { const it = project.items[id] as { name: string; width: number; height: number }; return { name: it.name, x: 0, y: i * 200, width: it.width, height: it.height, offsetX: 0, offsetY: 0, originalWidth: it.width, originalHeight: it.height, rotated: false }; });
  const atlas = new TextureAtlas(atlasText([{ name: "p", imagePath: "p.png", width: 512, height: 4096, scale: 1, regions }]));
  const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(atlas)).readSkeletonData(JSON.parse(boneburstJson(out.skeleton))));
  sk.setSkin(skin);
  sk.setupPose();
  sk.updateWorldTransform(Physics.reset);
  return sk;
}

describe("in the file", () => {
  it("each skin's own is written under the node's key; spine-core puts it where the stage does", async () => {
    const { project, sym, box, point } = await rig();
    for (const skin of ["big", "plain"]) {
      const sk = runtime(project, skin);
      const pose = evaluateSymbol(sym, null, 0, "setup", [skin]).byNode;
      const bs = sk.slots.find((s) => s.data.name === "hurt")!, ba = bs.appliedPose.getAttachment() as BoundingBoxAttachment;
      const v = new Array<number>(ba.worldVerticesLength);
      ba.computeWorldVertices(sk, bs, 0, ba.worldVerticesLength, v, 0, 2);
      const e = pose.get(box.id)!, pts = e.node.box!.points;
      expect(v.length).toBe(pts.length);
      for (let i = 0; i < pts.length; i += 2) {
        const w = apply({ x: 0, y: 0 }, e.world, pts[i]!, pts[i + 1]!);
        expect(v[i]!).toBeCloseTo(w.x, 3);
        expect(-v[i + 1]!).toBeCloseTo(w.y, 3);
      }
      const ps = sk.slots.find((s) => s.data.name === "eye")!, pa = ps.appliedPose.getAttachment() as PointAttachment;
      const at = pa.computeWorldPosition(ps.bone.appliedPose, new Vector2());
      const pe = pose.get(point.id)!, off = pe.node.point ?? { x: 0, y: 0 };
      const want = apply({ x: 0, y: 0 }, pe.world, off.x, off.y);
      expect(at.x).toBeCloseTo(want.x, 3);
      expect(-at.y).toBeCloseTo(want.y, 3);
    }
  });

  it("export then open: the node and each skin's own come back", async () => {
    const { project } = await rig();
    const opened = importBoneBurst(exportBoneBurst(project).skeleton as never, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const hurt = Object.values(sym.nodes).find((n) => n.name === "hurt" && n.kind !== "bone")!, eye = Object.values(sym.nodes).find((n) => n.name === "eye" && n.kind !== "bone")!;
    expect(hurt.kind).toBe("box");
    expect(eye.kind).toBe("point");
    const big = sym.skins!.find((d) => d.name === "big")!;
    expect(big.outlines![hurt.id]!.box!.points).toHaveLength(8);
    expect(big.outlines![eye.id]!.point).toEqual({ x: 12, y: -4, rotation: 30 });
    const carriedSlots = sym.spine!.skins.flatMap((sk) => Object.keys((sk.attachments as Record<string, unknown>) ?? {}));
    expect(carriedSlots.filter((n) => n === "hurt" || n === "eye")).toEqual([]);
  });
});
