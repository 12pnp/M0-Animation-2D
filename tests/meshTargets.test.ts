import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type ItemId, type NodeId } from "@/core/doc/ids";
import { createNode, createSymbol } from "@/core/doc/defaults";
import { meshTargets, shownMeshes } from "@/core/mesh/meshPlan";
import type { MeshData, Node, SymbolItem } from "@/core/doc/types";

beforeEach(() => reseed());

const mesh: MeshData = { width: 4, height: 4, points: [0, 0, 4, 0, 4, 4], triangles: [0, 1, 2], hull: 3 };

/** A layer with two images; skin "alt" puts its own image in display 0, skin "m" a mesh. */
function rig(): { sym: SymbolItem; id: NodeId } {
  const sym = createSymbol("rig");
  const node: Node = { ...createNode("image", "arm", { itemId: "own" as ItemId }), extraDisplays: [{ itemId: "two" as ItemId, pivot: { x: 0, y: 0 } }] };
  sym.nodes[node.id] = node;
  sym.skins = [
    { name: "alt", displays: { [node.id]: { 0: { itemId: "alt0" as ItemId, pivot: { x: 1, y: 1 } } } } },
    { name: "m", displays: { [node.id]: { 0: { itemId: "m0" as ItemId, pivot: { x: 1, y: 1 }, mesh } } } },
  ];
  return { sym, id: node.id };
}

describe("where Make Mesh puts a mesh", () => {
  it.each([
    { name: "no skin, display 0: the node's own", skins: [], index: 0, want: { index: 0, skin: null, itemId: "own" } },
    { name: "the display the playhead shows", skins: [], index: 1, want: { index: 1, skin: null, itemId: "two" } },
    { name: "a skin that fills it: the skin's own image", skins: ["alt"], index: 0, want: { index: 0, skin: "alt", itemId: "alt0" } },
    { name: "already a mesh: nothing", skins: ["m"], index: 0, want: null },
  ])("$name", ({ skins, index, want }) => {
    const { sym, id } = rig();
    const got = meshTargets(sym, [id], skins, () => index);
    expect(got[0] ? { index: got[0].index, skin: got[0].skin, itemId: got[0].itemId } : null).toEqual(want);
  });

  it.each([
    { name: "a link", patch: { linked: { to: 1 } } },
    { name: "a sequence", patch: { sequence: { items: ["own", "two"] } } },
    { name: "an opened file's attachment", patch: { attachment: { name: "arm", data: {} } } },
  ])("refused on $name", ({ patch }) => {
    const { sym, id } = rig();
    sym.nodes[id] = { ...sym.nodes[id]!, ...patch } as Node;
    expect(meshTargets(sym, [id], [], () => 0)).toEqual([]);
  });
});

describe("the meshes Remove, Bind and Unbind act on", () => {
  it("the mesh the stage shows: a skin's when a shown skin fills the display, else the node's own", () => {
    const { sym, id } = rig();
    sym.nodes[id] = { ...sym.nodes[id]!, mesh };
    expect(shownMeshes(sym, [id], [], () => 0).map((m) => [m.index, m.skin])).toEqual([[0, null]]);
    expect(shownMeshes(sym, [id], ["m"], () => 0).map((m) => [m.index, m.skin, m.pivot])).toEqual([[0, "m", { x: 1, y: 1 }]]);
    expect(shownMeshes(sym, [id], ["alt"], () => 0)).toEqual([]);
    expect(shownMeshes(sym, [id], [], () => 1)).toEqual([]);
  });
});
