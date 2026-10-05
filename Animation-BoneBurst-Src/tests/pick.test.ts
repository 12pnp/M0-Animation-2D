import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import { evaluateSymbol, SETUP_CONTEXT } from "@/core/doc/pose";
import { pickNode } from "@/core/doc/pick";

beforeEach(() => reseed());

describe("pickNode", () => {
  // A 200×100 image centred on (0, 0) behind a 100×100 one centred on (50, 0); the front one has a
  // transparent left half. layers[0] is the top (front) row.
  function scene() {
    const project = createProject("P");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const back = createImageItem("back", "a-back" as AssetId, 200, 100);
    const front = createImageItem("front", "a-front" as AssetId, 100, 100);
    project.items[back.id] = back; project.items[front.id] = front;
    const nf = createNode("image", "front", { itemId: front.id, x: 50, y: 0, pivotX: 50, pivotY: 50 });
    const nb = createNode("image", "back", { itemId: back.id, x: 0, y: 0, pivotX: 100, pivotY: 50 });
    for (const n of [nf, nb]) { sym.nodes[n.id] = n; sym.layers.push(createLayer(n.id, n.name, 0)); }
    const pose = evaluateSymbol(sym, null, 0, "setup");
    const alphaAt = (asset: AssetId, x: number) => (asset === "a-front" && x < 50 ? 0 : 255);
    return { project, poses: [{ pose, when: SETUP_CONTEXT }], nf, nb, alphaAt };
  }
  it.each([
    ["the front image where it is opaque", 80, 0, "front"],
    ["through its transparent half to the back one", 20, 0, "back"],
    ["the back image where only it is", -40, 0, "back"],
    ["nothing outside both", 300, 0, null],
  ])("picks %s", (_what, x, y, want) => {
    const { project, poses, nf, nb, alphaAt } = scene();
    const got = pickNode(project, poses, x, y, alphaAt, 8);
    expect(got === nf.id ? "front" : got === nb.id ? "back" : got).toBe(want);
  });
  it("skips excluded nodes", () => {
    const { project, poses, nf, nb, alphaAt } = scene();
    expect(pickNode(project, poses, 80, 0, alphaAt, 8, new Set([nf.id]))).toBe(nb.id);
  });
});
