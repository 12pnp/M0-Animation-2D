import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type NodeId } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type SymbolItem } from "@/core/doc/types";
import {
  type OutlineOptions, ancestorsOf, canDropOn, outlineRows, rowRange,
} from "@/core/doc/outlineTree";

beforeEach(() => reseed());

/**
 * hips ─┬─ chest ─┬─ head ── face (image)
 *       │         └─ torso (image)
 *       └─ leg ──── shin
 * prop (image, top level)
 */
function rig() {
  const project = createProject("T");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  const ids: Record<string, NodeId> = {};
  const add = (kind: "bone" | "image", name: string, parent: string | null) => {
    const n = createNode(kind, name, { x: 0, y: 0, parentId: parent ? ids[parent]! : null });
    sym.nodes[n.id] = n;
    // Layers are top first: push keeps the order written here.
    sym.layers.push(createLayer(n.id, name, sym.layers.length));
    ids[name] = n.id;
  };
  add("bone", "hips", null);
  add("bone", "chest", "hips");
  add("bone", "head", "chest");
  add("image", "face", "head");
  add("image", "torso", "chest");
  add("bone", "leg", "hips");
  add("bone", "shin", "leg");
  add("image", "prop", null);
  return { sym: sym as SymbolItem, ids };
}

const all: OutlineOptions = { collapsed: new Set(), query: "", show: { bones: true, images: true } };
const names = (sym: SymbolItem, rows: ReturnType<typeof outlineRows>) =>
  rows.map((r) => `${"  ".repeat(r.depth)}${sym.nodes[r.id]!.name}`);

describe("outlineRows", () => {
  it("nests every node under its parent, in layer order", () => {
    const { sym } = rig();
    expect(names(sym, outlineRows(sym, all))).toEqual([
      "hips", "  chest", "    head", "      face", "    torso", "  leg", "    shin", "prop",
    ]);
  });

  it("a collapsed branch hides its rows but keeps its triangle", () => {
    const { sym, ids } = rig();
    const rows = outlineRows(sym, { ...all, collapsed: new Set([ids.chest!]) });
    expect(names(sym, rows)).toEqual(["hips", "  chest", "  leg", "    shin", "prop"]);
    const chest = rows.find((r) => r.id === ids.chest)!;
    expect(chest.hasChildren).toBe(true);
    expect(chest.open).toBe(false);
  });

  it("a search keeps matches and the path to them, opening collapsed branches", () => {
    const { sym, ids } = rig();
    const rows = outlineRows(sym, { ...all, query: "FAC", collapsed: new Set([ids.hips!]) });
    expect(names(sym, rows)).toEqual(["hips", "  chest", "    head", "      face"]);
    expect(rows.filter((r) => r.match).map((r) => sym.nodes[r.id]!.name)).toEqual(["face"]);
  });

  it("hiding images keeps the skeleton", () => {
    const { sym } = rig();
    const rows = outlineRows(sym, { ...all, show: { bones: true, images: false } });
    expect(names(sym, rows)).toEqual(["hips", "  chest", "    head", "  leg", "    shin"]);
  });

  it("hiding bones lifts the images to the nearest shown ancestor", () => {
    const { sym } = rig();
    const rows = outlineRows(sym, { ...all, show: { bones: false, images: true } });
    expect(names(sym, rows)).toEqual(["face", "torso", "prop"]);
  });

  it("draws the lines: a guide continues while an ancestor has siblings below", () => {
    const { sym, ids } = rig();
    const rows = outlineRows(sym, all);
    const at = (name: string) => rows.find((r) => r.id === ids[name])!;
    expect(at("chest")).toMatchObject({ guides: [true], last: false });
    expect(at("face")).toMatchObject({ guides: [true, true, true], last: true });
    expect(at("torso")).toMatchObject({ guides: [true, true], last: true });
    expect(at("shin")).toMatchObject({ guides: [true, false], last: true });
    expect(at("prop")).toMatchObject({ guides: [], last: true });
  });
});

describe("rowRange", () => {
  it("takes every row between the two, either way round", () => {
    const { sym, ids } = rig();
    const rows = outlineRows(sym, all);
    const want = [ids.head, ids.face, ids.torso, ids.leg];
    expect(rowRange(rows, ids.head!, ids.leg!)).toEqual(want);
    expect(rowRange(rows, ids.leg!, ids.head!)).toEqual(want);
  });

  it("falls back to the clicked row when the anchor is not shown", () => {
    const { sym, ids } = rig();
    const rows = outlineRows(sym, { ...all, collapsed: new Set([ids.chest!]) });
    expect(rowRange(rows, ids.face!, ids.leg!)).toEqual([ids.leg]);
  });
});

describe("ancestorsOf / canDropOn", () => {
  it("lists the branches to open, nearest first", () => {
    const { sym, ids } = rig();
    expect(ancestorsOf(sym, ids.face!)).toEqual([ids.head, ids.chest, ids.hips]);
    expect(ancestorsOf(sym, ids.prop!)).toEqual([]);
  });

  const cases: Array<[string, string, string | null, boolean]> = [
    ["onto another branch", "shin", "chest", true],
    ["onto itself", "chest", "chest", false],
    ["onto its own descendant (a loop)", "chest", "face", false],
    ["onto the parent it already has", "head", "chest", false],
    ["to the top level", "head", null, true],
    ["to the top level, already there", "prop", null, false],
  ];
  for (const [name, dragged, target, want] of cases) {
    it(name, () => {
      const { sym, ids } = rig();
      expect(canDropOn(sym, ids[dragged]!, target ? ids[target]! : null)).toBe(want);
    });
  }
});
