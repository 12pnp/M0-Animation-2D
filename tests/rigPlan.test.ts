import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createLayer, createNode, createSymbol } from "@/core/doc/defaults";
import { normalizeLayerOrder } from "@/core/doc/layerTree";
import type { Node, SymbolItem } from "@/core/doc/types";
import { apply, type Matrix2D, mul } from "@/core/math/Matrix2D";
import { matrixOf, tf } from "@/core/math/Transform";
import { boneFromWorld, placeOnBone, siblingOrder, type BoneBurstPoint } from "@/core/rig/rigPlan";
import { toBoneBurstLocal } from "@/core/boneburst/transform";

beforeEach(() => reseed());

/** Where a local pose under `parent` lands: its origin and the end of its
 *  x axis `length` along, in skeleton space (y up). */
function landed(parent: Matrix2D | undefined, local: Matrix2D, length: number): { from: BoneBurstPoint; to: BoneBurstPoint } {
  const world = parent ? mul(matrixOf(tf()), parent, local) : local;
  const tip = apply({ x: 0, y: 0 }, world, length, 0);
  return { from: [world.tx, -world.ty], to: [tip.x, -tip.y] };
}

const PARENTS: Array<[string, Matrix2D | undefined]> = [
  ["no parent", undefined],
  ["moved", matrixOf(tf(40, -30))],
  ["turned", matrixOf(tf(5, 7, 70, 70))],
  ["scaled", matrixOf(tf(0, 0, -30, -30, 2, 2))],
  ["squashed", matrixOf(tf(10, 0, 20, 20, 3, 0.5))],
  ["mirrored", matrixOf(tf(0, 0, 15, 15, -1, 1))],
  ["sheared", matrixOf(tf(0, 0, 10, 40, 1.5, 1))],
];

describe("boneFromWorld", () => {
  it.each(PARENTS)("puts the joint and tip where asked under a %s parent", (_, parent) => {
    for (const [from, to] of [[[0, 0], [0, 50]], [[10, 20], [-30, -10]], [[-100, 3], [-99, 3]]] as Array<[BoneBurstPoint, BoneBurstPoint]>) {
      const placed = boneFromWorld(parent, from, to)!;
      const got = landed(parent, matrixOf(placed.bind), placed.length);
      expect(got.from[0]).toBeCloseTo(from[0], 9);
      expect(got.from[1]).toBeCloseTo(from[1], 9);
      expect(got.to[0]).toBeCloseTo(to[0], 9);
      expect(got.to[1]).toBeCloseTo(to[1], 9);
      expect(placed.length).toBeCloseTo(Math.hypot(to[0] - from[0], to[1] - from[1]), 9);
    }
  });

  it("is Spine's rotation at the root: counter-clockwise from +x, y up", () => {
    expect(toBoneBurstLocal(boneFromWorld(undefined, [10, 20], [10, 50])!.bind)).toMatchObject({ x: 10, y: 20, rotation: 90, scaleX: 1, scaleY: 1 });
    expect(toBoneBurstLocal(boneFromWorld(undefined, [0, 0], [-5, 0])!.bind).rotation).toBeCloseTo(180, 9);
  });

  it("refuses a bone of no length and a parent scaled to nothing", () => {
    expect(boneFromWorld(undefined, [3, 4], [3, 4])).toBeNull();
    expect(boneFromWorld(matrixOf(tf(0, 0, 0, 0, 0, 1)), [0, 0], [1, 0])).toBeNull();
  });
});

describe("placeOnBone", () => {
  it.each(PARENTS)("keeps a picture upright, or turned as asked, under a %s parent", (_, parent) => {
    for (const rotation of [0, 35, -120]) {
      const local = placeOnBone(parent, [12, -8], rotation)!;
      const got = landed(parent, matrixOf(local), 10);
      expect(got.from[0]).toBeCloseTo(12, 9);
      expect(got.from[1]).toBeCloseTo(-8, 9);
      const r = (rotation * Math.PI) / 180;
      expect(got.to[0]).toBeCloseTo(12 + 10 * Math.cos(r), 9);
      expect(got.to[1]).toBeCloseTo(-8 + 10 * Math.sin(r), 9);
    }
  });

  it("scales the picture in the world, whatever the bone's scale", () => {
    const parent = matrixOf(tf(0, 0, 0, 0, 4, 4));
    const got = landed(parent, matrixOf(placeOnBone(parent, [0, 0], 0, 0.5)!), 10);
    expect(got.to[0]).toBeCloseTo(5, 9);
  });
});

describe("siblingOrder", () => {
  /** root ─ a, b (─ e), c, d, with f a second root. */
  function rig(): { sym: SymbolItem; n: Record<string, Node> } {
    const sym = createSymbol("rig");
    const n: Record<string, Node> = {};
    const add = (name: string, parent: string | null) => {
      const node = createNode("bone", name, { parentId: parent ? n[parent]!.id : null });
      n[name] = node;
      sym.nodes[node.id] = node;
      sym.layers.push(createLayer(node.id, name, sym.layers.length));
    };
    add("root", null); add("a", "root"); add("b", "root"); add("e", "b"); add("c", "root"); add("d", "root"); add("f", null);
    normalizeLayerOrder(sym);
    return { sym, n };
  }
  const names = (sym: SymbolItem, layers: SymbolItem["layers"]) => layers.map((l) => sym.nodes[l.nodeId]!.name);

  it.each([
    [["d", "a"], ["root", "d", "b", "e", "c", "a", "f"]],
    [["c", "b"], ["root", "a", "c", "b", "e", "d", "f"]],
    [["d", "c", "b", "a"], ["root", "d", "c", "b", "e", "a", "f"]],
    [["a"], ["root", "a", "b", "e", "c", "d", "f"]],
  ])("orders root's children %j front first, subtrees with them", (front, expected) => {
    const { sym, n } = rig();
    const out = siblingOrder(sym, n.root!.id, front.map((x) => n[x]!.id));
    expect(Array.isArray(out) && names(sym, out)).toEqual(expected);
  });

  it("orders the roots", () => {
    const { sym, n } = rig();
    const out = siblingOrder(sym, null, [n.f!.id, n.root!.id]);
    expect(Array.isArray(out) && names(sym, out)).toEqual(["f", "root", "a", "b", "e", "c", "d"]);
  });

  it("says what is wrong", () => {
    const { sym, n } = rig();
    expect(siblingOrder(sym, n.root!.id, [n.e!.id])).toBe('"e" is not a child of "root".');
    expect(siblingOrder(sym, n.root!.id, [n.a!.id, n.a!.id])).toBe("A name is listed twice.");
    expect(siblingOrder(sym, null, [n.a!.id])).toBe(`"a" is not a child of the skeleton's root.`);
  });
});
