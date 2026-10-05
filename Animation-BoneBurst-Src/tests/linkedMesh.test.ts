import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type ItemId } from "@/core/doc/ids";
import { linkableDisplays, meshOfDisplay, withLink, displaysOf } from "@/core/doc/displays";
import { createNode } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import type { MeshData, SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

const mesh: MeshData = { width: 10, height: 10, points: [0, 0, 10, 0, 10, 10], triangles: [0, 1, 2], hull: 3 };
const node = () => ({
  ...createNode("image", "face", { itemId: "a" as ItemId }), mesh, pivot: { x: 5, y: 5 },
  extraDisplays: [{ itemId: "b" as ItemId, pivot: { x: 1, y: 1 } }, { itemId: "c" as ItemId, pivot: { x: 2, y: 2 }, mesh }],
});

describe("linking a display to a mesh", () => {
  it("the images without a mesh of their own can be linked to display 0's", () => {
    expect(linkableDisplays(node(), 0)).toEqual([1]);
  });

  it("linked, it draws the mesh about the mesh's own transform point, with or without its deform keys", () => {
    const n = withLink(node(), 1, { to: 0 });
    expect(meshOfDisplay(n, displaysOf(n)[1]!)).toEqual({ mesh, pivot: { x: 5, y: 5 }, deform: true });
    const m = withLink(n, 1, { to: 0, deform: false });
    expect(meshOfDisplay(m, displaysOf(m)[1]!)!.deform).toBe(false);
    expect(meshOfDisplay(withLink(m, 1, undefined), displaysOf(m)[1]!)!.deform).toBe(false);
    expect(displaysOf(withLink(m, 1, undefined))[1]!.linked).toBeUndefined();
  });

  it.each([
    { name: "to itself", index: 1, link: { to: 1 } },
    { name: "a display that does not exist", index: 7, link: { to: 0 } },
  ])("refused: $name", ({ index, link }) => {
    const n = node();
    expect(withLink(n, index, link)).toBe(n);
  });

  it("a mesh it is linked to that goes, or a link to no mesh: drawn as an image", () => {
    const n = withLink(node(), 1, { to: 0 });
    const { mesh: _m, ...plain } = n;
    expect(meshOfDisplay(plain, displaysOf(plain)[1]!)).toBeNull();
  });

  it("load: a link to a display with a mesh is kept, any other dropped", async () => {
    const { project, rig, node: id } = await loadStickman();
    const torso = Object.values(rig.nodes).find((x) => x.itemId && x.name.includes("torso"))!;
    const head = Object.values(project.items).find((i) => i.name === "head")!;
    rig.nodes[torso.id] = { ...torso, mesh, extraDisplays: [{ itemId: head.id, pivot: { x: 0, y: 0 }, linked: { to: 0, deform: false } }, { itemId: head.id, pivot: { x: 1, y: 0 }, linked: { to: 5 } }] };
    void id;
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    const extras = (out.items[out.rootSymbolId] as SymbolItem).nodes[torso.id]!.extraDisplays!;
    expect(extras[0]!.linked).toEqual({ to: 0, deform: false });
    expect(extras[1]!.linked).toBeUndefined();
  });

  it("export then open: the linked display comes back linked, under its key", async () => {
    const { project, rig } = await loadStickman();
    const torso = Object.values(rig.nodes).find((x) => x.itemId && x.name.includes("torso"))!;
    const item = project.items[torso.itemId!] as { width: number; height: number };
    const head = Object.values(project.items).find((i) => i.name === "head")!;
    const box: MeshData = { width: item.width, height: item.height, points: [0, 0, item.width, 0, item.width, item.height, 0, item.height], triangles: [0, 1, 2, 0, 2, 3], hull: 4 };
    rig.nodes[torso.id] = { ...torso, mesh: box, extraDisplays: [{ itemId: head.id, pivot: torso.pivot, linked: { to: 0, deform: false } }] };
    const anim = rig.animations[0]!;
    anim.tracks[torso.id] = { nodeId: torso.id, endFrame: anim.duration - 1, keys: [{ frame: 0, transform: torso.bind, displayIndex: 0, tween: { kind: "none" } }, { frame: 3, transform: torso.bind, displayIndex: 1, tween: { kind: "none" } }] };
    const images = new Map(Object.values(project.items).filter((i) => i.kind === "image").map((i) => [i.name, { name: i.name, width: (i as { width: number }).width, height: (i as { height: number }).height, assetId: (i as unknown as { assetId: never }).assetId }]));
    const opened = importBoneBurst(exportBoneBurst(project).skeleton as never, "stickman", images).project;
    const back = Object.values((opened.items[opened.rootSymbolId] as SymbolItem).nodes).find((x) => x.name === torso.name && x.kind === "image")!;
    expect(back.mesh).toBeDefined();
    expect(back.extraDisplays?.[0]).toMatchObject({ key: "head", linked: { to: 0, deform: false } });
    expect(back.extraDisplays?.[0]!.attachment).toBeUndefined();
  });
});
