import { beforeEach, describe, expect, it } from "vitest";
import { reseed, newIkId, newTcId, newCnId } from "@/core/doc/ids";
import { byOrder, constraintEntries, orderAfterEdit, orderFrom, withConstraintMoved } from "@/core/doc/constraintOrder";
import { createProject } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { identityProperties } from "@/core/doc/transformKeys";
import type { SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";
import { History } from "@/core/history/History";
import { SetConstraintOrder } from "@/core/history/attachmentCommands";
import { SetIkOptions } from "@/core/history/ikCommands";

beforeEach(() => reseed());

/** A symbol with IK a, b, transform t, physics p and a carried path c. */
function symbol(order?: string[]): SymbolItem {
  const project = createProject("O");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const n = "n" as never;
  sym.ik = ["a", "b"].map((name) => ({ id: newIkId(), name, boneId: n, targetId: n, chain: 0 as const, bendPositive: false, weight: 1 }));
  sym.transforms = [{ id: newTcId(), name: "t", boneIds: [], sourceId: n, mix: { rotate: 1, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 }, properties: identityProperties() }];
  sym.physics = [{ id: newCnId(), name: "p", boneId: n }];
  sym.spine = { header: {}, constraints: [{ type: "path", name: "c" }], skins: [] };
  if (order) sym.constraintOrder = order;
  return sym;
}

const names = (sym: SymbolItem) => constraintEntries(sym).map((e) => e.name);

describe("the order constraints are applied in", () => {
  it.each([
    { name: "none: IK, transform, physics, carried", order: undefined, want: ["a", "b", "t", "p", "c"] },
    { name: "the listed ones first, in the list's order", order: ["t", "c", "a"], want: ["t", "c", "a", "b", "p"] },
    { name: "a name of nothing is passed over", order: ["gone", "p"], want: ["p", "a", "b", "t", "c"] },
  ])("$name", ({ order, want }) => {
    expect(names(symbol(order))).toEqual(want);
  });

  it("byOrder is stable for names the list lacks", () => {
    expect(byOrder(["x", "y", "z", "w"], ["z"], (s) => s)).toEqual(["z", "x", "y", "w"]);
    expect(byOrder(["x", "y"], undefined, (s) => s)).toEqual(["x", "y"]);
  });
});

describe("changing the order", () => {
  it.each([
    { name: "down one", move: "a", to: 1, want: ["b", "a", "t", "p", "c"] },
    { name: "to the top", move: "c", to: 0, want: ["c", "a", "b", "t", "p"] },
    { name: "past the end: last", move: "a", to: 99, want: ["b", "t", "p", "c", "a"] },
  ])("$name", ({ move, to, want }) => {
    expect(withConstraintMoved(symbol(), move, to)).toEqual(want);
  });

  it("nothing moves: null", () => {
    expect(withConstraintMoved(symbol(), "a", 0)).toBeNull();
    expect(withConstraintMoved(symbol(), "gone", 2)).toBeNull();
  });

  it.each([
    { names: ["p", "a"], want: ["p", "a", "b", "t", "c"] },
    { names: ["x"], want: "has no constraint called \"x\"" },
    { names: ["a", "a"], want: "named twice" },
  ])("given $names", ({ names: given, want }) => {
    const out = orderFrom(symbol(), given);
    if (Array.isArray(want)) expect(out).toEqual(want);
    else expect(out).toContain(want);
  });

  it("a renamed constraint keeps its place; no rename keeps the same array", () => {
    const order = ["t", "a"];
    expect(orderAfterEdit(order, [{ id: "k1", name: "a" }], [{ id: "k1", name: "arm" }])).toEqual(["t", "arm"]);
    expect(orderAfterEdit(order, [{ id: "k1", name: "a" }], [{ id: "k1", name: "a" }])).toBe(order);
    expect(orderAfterEdit(undefined, [{ id: "k1", name: "a" }], [])).toBeUndefined();
  });
});

describe("the order in the file", () => {
  it("the export writes the symbol's order; without one, IK then transform", async () => {
    const { project, rig } = await loadStickman();
    rig.transforms = [{ id: newTcId(), name: "follow", boneIds: [rig.ik[0]!.boneId], sourceId: rig.ik[1]!.boneId, mix: { rotate: 1, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 }, properties: identityProperties() }];
    const plain = exportBoneBurst(project).skeleton.constraints!.map((c) => c.name);
    expect(plain).toEqual([...rig.ik.map((k) => k.name), "follow"]);
    rig.constraintOrder = ["follow", rig.ik[2]!.name];
    const ordered = exportBoneBurst(project).skeleton.constraints!.map((c) => c.name);
    expect(ordered).toEqual(["follow", rig.ik[2]!.name, ...rig.ik.filter((_, i) => i !== 2).map((k) => k.name)]);
  });

  it("an opened file keeps its order, the carried ones among the model's", async () => {
    const { project, rig } = await loadStickman();
    rig.constraintOrder = [rig.ik[3]!.name, rig.ik[0]!.name];
    const file = exportBoneBurst(project).skeleton;
    const opened = importBoneBurst(file as never, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    expect(sym.constraintOrder!.slice(0, 2)).toEqual([rig.ik[3]!.name, rig.ik[0]!.name]);
    sym.spine!.constraints.push({ type: "path", name: "carried", bones: [], slot: "x" });
    sym.constraintOrder = ["carried", ...sym.constraintOrder!];
    expect(exportBoneBurst(opened).skeleton.constraints!.map((c) => c.name)[0]).toBe("carried");
  });

  it("load: a version 23 file's carried order moves to the symbol; the list keeps names, once", () => {
    const project = createProject("M");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    (sym as unknown as { spine: unknown }).spine = { header: {}, constraints: [], skins: [], constraintOrder: ["b", "a"] };
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 23 })))).project;
    const s = out.items[out.rootSymbolId] as SymbolItem;
    expect(s.constraintOrder).toEqual(["b", "a"]);
    expect(s.spine).not.toHaveProperty("constraintOrder");
    const odd = validateProject(migrate(JSON.parse(JSON.stringify({ ...out, items: { ...out.items, [out.rootSymbolId]: { ...s, constraintOrder: ["a", 3, "a", "b"] } } })))).project;
    expect((odd.items[odd.rootSymbolId] as SymbolItem).constraintOrder).toEqual(["a", "b"]);
  });
});

describe("the commands", () => {
  it("Set Constraint Order replaces the list and undoes; renaming an IK keeps its place", async () => {
    const { project, rig } = await loadStickman();
    const history = new History(project);
    const [first, , third] = rig.ik.map((k) => k.name);
    history.apply(new SetConstraintOrder("Constraint Order", rig.id, [third!, first!]));
    expect(rig.constraintOrder).toEqual([third, first]);
    history.apply(new SetIkOptions(rig.id, rig.ik[2]!.id, { name: "renamed" }));
    expect(rig.constraintOrder).toEqual(["renamed", first]);
    expect(names(rig).slice(0, 2)).toEqual(["renamed", first]);
    history.undo();
    expect(rig.constraintOrder).toEqual([third, first]);
    history.undo();
    expect(rig.constraintOrder).toBeUndefined();
  });
});
