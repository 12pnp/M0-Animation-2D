import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type ItemId, type NodeId } from "@/core/doc/ids";
import { createNode, createSymbol } from "@/core/doc/defaults";
import { shownDisplay, skinDisplayOf } from "@/core/doc/skins";
import { meshOfDisplay } from "@/core/doc/displays";
import { editedMesh } from "@/core/mesh/meshPlan";
import { migrate, validateProject } from "@/core/doc/schema";
import { SetMesh } from "@/core/history/meshCommands";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import type { MeshData, Project, SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";
import { posedSymbol } from "@/core/boneburst/boneburstPose";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";

beforeEach(() => reseed());

const mesh = (w: number): MeshData => ({ width: w, height: 10, points: [0, 0, w, 0, w, 10], triangles: [0, 1, 2], hull: 3 });

/** A slot node with two displays; skin "a" fills display 1 with a mesh, skin "b" fills display 0. */
function rig(): { sym: SymbolItem; id: NodeId } {
  const sym = createSymbol("rig");
  const node = { ...createNode("image", "arm", { itemId: "own" as ItemId }), extraDisplays: [{ itemId: "own2" as ItemId, pivot: { x: 0, y: 0 }, skinOnly: true as const }] };
  sym.nodes[node.id] = node;
  sym.skins = [
    { name: "a", displays: { [node.id]: { 1: { itemId: "a1" as ItemId, pivot: { x: 1, y: 1 }, mesh: mesh(20), key: "arm2" } } } },
    { name: "b", displays: { [node.id]: { 0: { itemId: "b0" as ItemId, pivot: { x: 2, y: 2 } }, 1: { itemId: "b1" as ItemId, pivot: { x: 3, y: 3 }, linked: { to: 1, skin: "a" } } } } },
  ];
  return { sym, id: node.id };
}

describe("what the stage shows, and where it lives", () => {
  it.each([
    { name: "no skin: the node's own", index: 0, skins: [], want: { item: "own", skin: null } },
    { name: "a skin-only display with no skin filling it: nothing", index: 1, skins: [], want: null },
    { name: "the skin that fills it", index: 1, skins: ["a"], want: { item: "a1", skin: "a" } },
    { name: "the later of two skins", index: 1, skins: ["a", "b"], want: { item: "b1", skin: "b" } },
    { name: "a skin that does not fill it: the node's own", index: 0, skins: ["a"], want: { item: "own", skin: null } },
  ])("$name", ({ index, skins, want }) => {
    const { sym, id } = rig();
    const got = shownDisplay(sym, sym.nodes[id]!, index, skins);
    expect(got && { item: got.display.itemId, skin: got.skin }).toEqual(want);
  });

  it("the Mesh tool edits a skin's mesh there", () => {
    const { sym, id } = rig();
    expect(editedMesh(sym, sym.nodes[id]!, 1, ["a"])).toMatchObject({ index: 1, skin: "a", pivot: { x: 1, y: 1 } });
    expect(editedMesh(sym, sym.nodes[id]!, 1, ["a", "b"])).toBeNull();
    sym.nodes[id] = { ...sym.nodes[id]!, mesh: mesh(5) };
    expect(editedMesh(sym, sym.nodes[id]!, 0, [])).toMatchObject({ index: 0, skin: null });
  });

  it("a link naming a skin draws that skin's mesh, about that display's transform point", () => {
    const { sym, id } = rig();
    const node = sym.nodes[id]!;
    const linked = sym.skins![1]!.displays![id]![1]!;
    expect(meshOfDisplay(node, linked, skinDisplayOf(sym, node))).toEqual({ mesh: mesh(20), pivot: { x: 1, y: 1 }, deform: true });
    expect(meshOfDisplay(node, linked)).toBeNull();
  });
});

describe("a skin's mesh edited", () => {
  it("SetMesh replaces the skin's display's mesh, and undo puts it back", () => {
    const { sym, id } = rig();
    const project = { items: { [sym.id]: sym } } as unknown as Project;
    const before = sym.skins;
    const cmd = new SetMesh("Move", sym.id, id, 1, mesh(30), new Map(), "mesh.move", "a");
    cmd.apply(project);
    expect(sym.skins![0]!.displays![id]![1]!.mesh!.width).toBe(30);
    expect(sym.skins![1]).toBe(before![1]);
    expect(sym.nodes[id]!.mesh).toBeUndefined();
    cmd.revert(project);
    expect(sym.skins![0]!.displays![id]![1]!.mesh!.width).toBe(20);
  });
});

describe("loading", () => {
  it("a skin's mesh, its key and name are kept; a link to a mesh is kept, one to nothing dropped", async () => {
    const { project, rig: sym, node } = await loadStickman();
    const id = node("torso");
    const head = Object.values(project.items).find((i) => i.name === "head")!.id;
    sym.nodes[id] = { ...sym.nodes[id]!, itemId: head, extraDisplays: [{ itemId: head, pivot: { x: 0, y: 0 } }] };
    sym.skins = [
      { name: "a", displays: { [id]: { 1: { itemId: head, pivot: { x: 1, y: 1 }, mesh: mesh(20), key: "k", name: "n" } } } },
      { name: "b", displays: { [id]: { 0: { itemId: head, pivot: { x: 0, y: 0 }, linked: { to: 1, skin: "a" } }, 1: { itemId: head, pivot: { x: 0, y: 0 }, linked: { to: 0, skin: "a" } } } } },
    ];
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    const skins = (out.items[out.rootSymbolId] as SymbolItem).skins!;
    expect(skins[0]!.displays![id]![1]).toMatchObject({ mesh: { width: 20 }, key: "k", name: "n" });
    expect(skins[1]!.displays![id]![0]!.linked).toEqual({ to: 1, skin: "a" });
    expect(skins[1]!.displays![id]![1]!.linked).toBeUndefined();
  });
});

describe("spine-unity's samples", () => {
  it.skipIf(!sampleRigs().length)("other skins' meshes and links become the document's; written back as the file had them", () => {
    let meshes = 0, links = 0;
    for (const r of sampleRigs()) {
      const file = JSON.parse(r.json);
      const project = importBoneBurst(file, r.name, imagesOf(r.atlas)).project;
      const sym = project.items[project.rootSymbolId] as SymbolItem;
      for (const def of sym.skins ?? []) for (const byIndex of Object.values(def.displays ?? {})) for (const d of Object.values(byIndex)) { if (d.mesh) meshes++; if (d.linked) links++; }
      const out = exportBoneBurst(project).skeleton as unknown as { skins: Array<{ name: string; attachments: Record<string, Record<string, Record<string, unknown>>> }> };
      // Each linked mesh is written with its source and the skin it names.
      for (const skin of file.skins ?? []) for (const [slot, atts] of Object.entries(skin.attachments ?? {}) as Array<[string, Record<string, Record<string, unknown>>]>) {
        for (const [key, att] of Object.entries(atts)) {
          if (att.type !== "linkedmesh") continue;
          const written = out.skins.find((s) => s.name === skin.name)?.attachments[slot]?.[key];
          expect(written).toMatchObject({ type: "linkedmesh", source: att.source ?? att.parent, ...(att.skin ? { skin: att.skin } : {}) });
        }
      }
    }
    expect(meshes).toBeGreaterThan(200);
    expect(links).toBeGreaterThan(5);
  });

  it.skipIf(!sampleRigs().some((r) => r.name === "mix-and-match"))("the stage knows which display a skin shows, though the attachment is named apart from its key", () => {
    const r = sampleRigs().find((x) => x.name === "mix-and-match")!;
    const project = importBoneBurst(JSON.parse(r.json), r.name, imagesOf(r.atlas)).project;
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const pose = posedSymbol(project, sym, null, 0, "setup", ["skin-base", "full-skins/girl"]);
    const body = Object.values(sym.nodes).find((n) => n.name === "body" && n.kind === "image")!;
    const e = pose.byNode.get(body.id)!;
    expect(e.spine).toBeDefined();
    expect(e.displayIndex).toBe(0);
    expect(editedMesh(sym, body, e.displayIndex, ["skin-base", "full-skins/girl"])).toMatchObject({ skin: "full-skins/girl", index: 0 });
  });
});
