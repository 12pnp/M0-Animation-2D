import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { moveKeys, sequenceFor, sequenceIndexAt, sequenceNaming, withSequenceKey } from "@/core/doc/sequence";
import { createImageItem, createLayer, createNode, createProject } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import type { Project, SequenceKey, SymbolItem } from "@/core/doc/types";

beforeEach(() => reseed());

const key = (frame: number, mode: SequenceKey["mode"], index = 0, delay = 1): SequenceKey => ({ frame, mode, index, delay });

describe("which image a sequence shows", () => {
  it.each([
    { name: "no keys: the setup image", keys: [], frame: 9, want: 2 },
    { name: "before the first key: the setup image", keys: [key(4, "loop")], frame: 3, want: 2 },
    { name: "hold: the key's image", keys: [key(0, "hold", 3)], frame: 9, want: 3 },
    { name: "loop wraps", keys: [key(0, "loop", 0, 1)], frame: 6, want: 1 },
    { name: "once stops at the last", keys: [key(0, "once", 0, 1)], frame: 9, want: 4 },
    { name: "pingpong turns at the ends", keys: [key(0, "pingpong", 0, 1)], frame: 6, want: 2 },
    { name: "loop, reversed", keys: [key(0, "loopReverse", 0, 1)], frame: 1, want: 3 },
    { name: "once, reversed, stops at the first", keys: [key(0, "onceReverse", 0, 1)], frame: 9, want: 0 },
    { name: "a delay of two frames per image", keys: [key(0, "loop", 0, 2)], frame: 5, want: 2 },
    { name: "the later key rules", keys: [key(0, "hold", 1), key(5, "hold", 4)], frame: 7, want: 4 },
  ])("$name", ({ keys, frame, want }) => {
    expect(sequenceIndexAt(keys, frame, 5, 2)).toBe(want);
  });
});

describe("sequence names", () => {
  it.each([
    { names: ["fire_01", "fire_02", "fire_03"], want: { path: "fire_", start: 1, digits: 2 } },
    { names: ["run8", "run9", "run10"], want: { path: "run", start: 8, digits: 0 } },
    { names: ["a_08", "a_09", "a_10"], want: { path: "a_", start: 8, digits: 2 } },
    { names: ["fire_01", "fire_03"], want: null },
    { names: ["fire_1", "fire_02"], want: null },
    { names: ["fire", "fire2"], want: null },
  ])("$names", ({ names, want }) => {
    expect(sequenceNaming(names)).toEqual(want);
  });
});

function library(names: Array<[string, number, number]>): { project: Project; id: (n: string) => string } {
  const project = createProject("S");
  for (const [n, w, h] of names) {
    const item = createImageItem(n, `a_${n}` as AssetId, w, h);
    project.items[item.id] = item;
  }
  return { project, id: (n) => Object.values(project.items).find((i) => i.name === n)!.id };
}

describe("making a sequence from numbered images", () => {
  it("runs from the lowest number next to the image, the image the setup frame", () => {
    const { project, id } = library([["fx_03", 8, 8], ["fx_04", 8, 8], ["fx_05", 8, 8], ["fx_07", 8, 8], ["other_04", 8, 8]]);
    expect(sequenceFor(project, id("fx_04") as never)).toEqual({ items: [id("fx_03"), id("fx_04"), id("fx_05")], setup: 1 });
  });
  it.each([
    { name: "no number", lib: [["fx", 8, 8]], pick: "fx", problem: "does not end in a number" },
    { name: "nothing next to it", lib: [["fx_01", 8, 8], ["fx_03", 8, 8]], pick: "fx_01", problem: "no \"fx_\" image numbered next" },
    { name: "sizes differ", lib: [["fx_01", 8, 8], ["fx_02", 9, 8]], pick: "fx_01", problem: "all one size" },
  ])("refused: $name", ({ lib, pick, problem }) => {
    const { project, id } = library(lib as Array<[string, number, number]>);
    expect(sequenceFor(project, id(pick) as never)).toContain(problem);
  });
});

describe("sequence keys", () => {
  it("keyed, replaced and moved", () => {
    const keys = withSequenceKey([key(0, "loop"), key(6, "hold")], key(6, "once", 2));
    expect(keys).toEqual([key(0, "loop"), key(6, "once", 2)]);
    expect(moveKeys(keys, [6], -2)).toEqual([key(0, "loop"), key(4, "once", 2)]);
    expect(moveKeys(keys, [6], -9)).toEqual([key(0, "once", 2)]);
  });

  it("load: images that exist, a setup in range, keys of sequence nodes with known modes and a delay", () => {
    const { project, id } = library([["fx_01", 8, 8], ["fx_02", 8, 8]]);
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const fx = createNode("image", "fx", { itemId: id("fx_01") as never });
    fx.sequence = { items: [id("fx_01"), id("fx_02"), "gone"] as never, setup: 9 };
    const plain = createNode("image", "plain", { itemId: id("fx_01") as never });
    for (const n of [fx, plain]) { sym.nodes[n.id] = n; sym.layers.push(createLayer(n.id, n.name, 0)); }
    sym.animations[0]!.sequences = {
      [fx.id]: [{ frame: 3, mode: "bounce", index: 1, delay: -2 }, key(1, "loop", 0, 0.5)] as never,
      [plain.id]: [key(0, "loop")],
    };
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 22 })))).project;
    const s = out.items[out.rootSymbolId] as SymbolItem;
    expect(s.nodes[fx.id]!.sequence).toEqual({ items: [id("fx_01"), id("fx_02")], setup: 1 });
    expect(s.animations[0]!.sequences).toEqual({ [fx.id]: [key(1, "loop", 0, 0.5), key(3, "hold", 1, 1)] });
  });
});
