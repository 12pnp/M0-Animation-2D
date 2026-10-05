import { describe, it, expect, beforeEach } from "vitest";
import { lineColorIndex, treeLines } from "@/core/doc/treeLines";
import { reseed } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type SymbolItem } from "@/core/doc/types";
import { outlineRows } from "@/core/doc/outlineTree";

beforeEach(() => reseed());

describe("treeLines", () => {
  it("a branch: lines run down past every row until the last sibling", () => {
    // a ─┬─ b ─┬─ c
    //    │     └─ d
    //    └─ e
    // f
    const lines = treeLines([0, 1, 2, 2, 1, 0]);
    expect(lines.map((l) => l.last)).toEqual([false, false, false, true, true, true]);
    // Column 0 runs all the way down: a has a sibling, f, at the bottom.
    expect(lines.map((l) => l.guides)).toEqual([
      [], [true], [true, true], [true, true], [true], [],
    ]);
  });

  it("agrees with the Outline's own lines on a real tree", () => {
    const project = createProject("T");
    const sym = project.items[project.rootSymbolId];
    if (!isSymbol(sym)) throw new Error("no root");
    const ids: Record<string, string> = {};
    const add = (name: string, parent: string | null) => {
      const n = createNode("bone", name, { x: 0, y: 0, parentId: parent ? ids[parent] as never : null });
      sym.nodes[n.id] = n;
      sym.layers.push(createLayer(n.id, name, sym.layers.length));
      ids[name] = n.id;
    };
    add("hips", null); add("chest", "hips"); add("head", "chest"); add("arm", "chest");
    add("leg", "hips"); add("shin", "leg"); add("prop", null);
    const rows = outlineRows(sym as SymbolItem, { collapsed: new Set(), query: "", show: { bones: true, images: true } });
    expect(treeLines(rows.map((r) => r.depth))).toEqual(rows.map((r) => ({ guides: r.guides, last: r.last })));
  });

  it("an empty list has no lines", () => expect(treeLines([])).toEqual([]));
});

describe("lineColorIndex", () => {
  const cases: Array<[number, number]> = [[0, 0], [1, 1], [5, 5], [6, 0], [13, 1]];
  for (const [depth, want] of cases) it(`depth ${depth}`, () => expect(lineColorIndex(depth)).toBe(want));
});
