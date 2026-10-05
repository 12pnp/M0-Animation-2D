import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import type { NodeKind, SymbolItem } from "@/core/doc/types";
import { bindPlan, swapTargets } from "@/core/doc/nodePlans";
import { toggleMaskedPlan, toggleMaskPlan } from "@/core/doc/layerTree";

beforeEach(() => reseed());

function scene(kinds: NodeKind[]) {
  const project = createProject("P");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const ids = kinds.map((k, i) => {
    const n = createNode(k, `${k}${i}`);
    sym.nodes[n.id] = n;
    sym.layers.push(createLayer(n.id, n.name, 0));
    return n.id;
  });
  return { sym, ids };
}

describe("swapTargets", () => {
  it("takes images, instances and empty layers only", () => {
    const kinds: NodeKind[] = ["image", "symbol", "empty", "bone", "group", "box", "point", "path"];
    const { sym, ids } = scene(kinds);
    expect(swapTargets(sym, ids).map((id) => sym.nodes[id]!.kind)).toEqual(["image", "symbol", "empty"]);
  });
  it("leaves a box selected beside an image alone (it used to become an image)", () => {
    const { sym, ids } = scene(["image", "box"]);
    expect(swapTargets(sym, ids)).toEqual([ids[0]]);
  });
});

describe("bindPlan", () => {
  it.each([
    [["bone", "image", "image"], true],
    [["bone"], false],
    [["bone", "bone", "image"], false],
    [["image"], false],
  ] as Array<[NodeKind[], boolean]>)("%s → %s", (kinds, ok) => {
    const { sym, ids } = scene(kinds);
    const plan = bindPlan(ids.map((id) => sym.nodes[id]!));
    expect(plan !== null).toBe(ok);
    if (plan) expect(plan.ids).toEqual(ids.slice(1));
  });
});

describe("mask plans", () => {
  // layers[0] is the top row.
  function masks() {
    const { sym, ids } = scene(["image", "image", "image"]);
    const [top, mid, low] = sym.layers as [typeof sym.layers[0], typeof sym.layers[0], typeof sym.layers[0]];
    return { sym, ids, top, mid, low };
  }
  it("turns a layer into a mask over the one below, and back off with its links", () => {
    const { sym, top, mid } = masks();
    expect(toggleMaskPlan(sym, top.id)).toEqual(new Map([[top.id, { isMask: true }], [mid.id, { maskedBy: top.id }]]));
    top.isMask = true; mid.maskedBy = top.id;
    expect(toggleMaskPlan(sym, top.id)).toEqual(new Map([[top.id, {}], [mid.id, { isMask: undefined }]]));
  });
  it("has nothing to clip under the bottom layer", () => {
    const { sym, low } = masks();
    expect(toggleMaskPlan(sym, low.id)).toBeNull();
  });
  it("joins the nearest mask above, or leaves it; a mask is never masked", () => {
    const { sym, top, mid, low } = masks();
    expect(toggleMaskedPlan(sym, low.id)).toBeNull();
    top.isMask = true; mid.maskedBy = top.id;
    expect(toggleMaskedPlan(sym, low.id)).toEqual(new Map([[low.id, { maskedBy: top.id }]]));
    expect(toggleMaskedPlan(sym, mid.id)).toEqual(new Map([[mid.id, {}]]));
    expect(toggleMaskedPlan(sym, top.id)).toBeNull();
  });
});
