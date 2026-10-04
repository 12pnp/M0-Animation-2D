import { describe, it, expect, beforeEach } from "vitest";
import { reseed, newIkId, type NodeId } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type SymbolItem } from "@/core/doc/types";
import { evaluateSymbol } from "@/core/doc/pose";
import { Store } from "@/app/Store";
import { hitAt } from "@/view/tools/SelectTool";
import type { ToolContext } from "@/view/tools/Tool";

beforeEach(() => reseed());

/**
 * The stage toolbar's visibility table decides what a click picks. Artwork is
 * stubbed: `hitTest` reports the image under every point unless it is in the
 * skip set, which is exactly what the table's "Images" switches feed it.
 */
function scene() {
  const project = createProject("Pick");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");
  const add = (kind: "bone" | "image", name: string, x: number, length = 100) => {
    const n = createNode(kind, name, { x, y: 0, parentId: null });
    if (kind === "bone") n.boneLength = length;
    root.nodes[n.id] = n;
    root.layers.unshift(createLayer(n.id, name, root.layers.length));
    return n;
  };
  const art = add("image", "art", 0);
  const arm = add("bone", "arm", 0, 100);
  const target = add("bone", "target", 300, 20);
  const tip = add("bone", "tip", 200, 50);
  root.ik.push({ id: newIkId(), name: "ik", boneId: tip.id, targetId: target.id, chain: 0, bendPositive: true, weight: 1 });

  const store = new Store(project);
  const ctx = {
    store,
    pose: () => evaluateSymbol(store.currentSymbol as SymbolItem, null, 0, "setup"),
    camera: { screenScale: 1 },
    hitTest: (_x: number, _y: number, skip?: Set<string>) => (skip?.has(art.id) ? null : art.id),
  } as unknown as ToolContext;
  return { store, ctx, art, arm, target };
}

describe("what a click picks", () => {
  const cases: Array<[string, Record<string, boolean>, { x: number; y: number }, "arm" | "art" | "target" | null]> = [
    ["a bone, close to its line, over artwork", {}, { x: 50, y: 2 }, "arm"],
    ["the artwork beside a bone", {}, { x: 50, y: 20 }, "art"],
    ["artwork, when bones cannot be picked", { selectBones: false }, { x: 50, y: 2 }, "art"],
    ["nothing, when images cannot be picked either", { selectBones: false, selectImages: false }, { x: 50, y: 2 }, null],
    ["nothing through hidden images", { selectBones: false, showImages: false }, { x: 50, y: 2 }, null],
    ["an IK target", {}, { x: 300, y: 3 }, "target"],
    ["not an IK target the table makes unpickable", { selectIk: false }, { x: 300, y: 3 }, "art"],
    ["not a hidden IK target", { showIk: false }, { x: 300, y: 3 }, "art"],
  ];
  for (const [name, prefs, p, want] of cases) {
    it(name, () => {
      const { store, ctx, art, arm, target } = scene();
      store.prefs.set("gizmos", prefs);
      const ids: Record<string, NodeId> = { arm: arm.id, art: art.id, target: target.id };
      expect(hitAt(ctx, p.x, p.y)).toBe(want ? ids[want] : null);
    });
  }

  it("hidden bones are never picked, whatever the table says", () => {
    const { store, ctx, art } = scene();
    store.setViewFlag("showBones", false);
    expect(hitAt(ctx, 50, 2)).toBe(art.id);
    store.setViewFlag("showBones", true);
  });
});
