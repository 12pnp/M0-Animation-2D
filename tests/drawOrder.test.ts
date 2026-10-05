import { beforeEach, describe, expect, it } from "vitest";
import { AtlasAttachmentLoader, MixFrom, Skeleton, SkeletonJson, TextureAtlas } from "@esotericsoftware/spine-core";
import { type NodeId, reseed } from "@/core/doc/ids";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import {
  drawingLayers, fromOffsets, orderAt, reordered, toOffsets, withDrawOrderKey, withOrder,
} from "@/core/doc/drawOrder";
import { migrate, validateProject } from "@/core/doc/schema";
import { evaluateSymbol } from "@/core/doc/pose";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import {
  deleteDrawOrderKeys, dropOrderAt, drawUnits, moveDrawOrderKeys, placedInFront, reorderAt, withFront,
} from "@/core/doc/drawOrder";

beforeEach(() => reseed());

const ids = (...s: string[]) => s as NodeId[];

describe("withOrder", () => {
  it.each([
    { name: "a full order stays", order: ["c", "a", "b"], setup: ["a", "b", "c"], want: ["c", "a", "b"] },
    { name: "a layer gone is dropped", order: ["c", "x", "a", "b"], setup: ["a", "b", "c"], want: ["c", "a", "b"] },
    { name: "a new layer goes above the one below it in the stack", order: ["c", "a"], setup: ["a", "b", "c"], want: ["c", "a", "b"] },
    { name: "a new bottom layer goes to the back", order: ["c", "b"], setup: ["a", "b", "c"], want: ["a", "c", "b"] },
    { name: "a repeated id counts once", order: ["b", "b", "a"], setup: ["a", "b"], want: ["b", "a"] },
  ])("$name", ({ order, setup, want }) => {
    expect(withOrder(ids(...order), ids(...setup))).toEqual(want);
  });
});

describe("reordered", () => {
  const order = ids("a", "b", "c", "d");
  it.each([
    { how: "forward", pick: ["b"], want: ["a", "c", "b", "d"] },
    { how: "forward", pick: ["d"], want: ["a", "b", "c", "d"] },
    { how: "forward", pick: ["a", "b"], want: ["c", "a", "b", "d"] },
    { how: "backward", pick: ["c"], want: ["a", "c", "b", "d"] },
    { how: "front", pick: ["a", "c"], want: ["b", "d", "a", "c"] },
    { how: "back", pick: ["d", "b"], want: ["b", "d", "a", "c"] },
  ] as const)("$how $pick", ({ how, pick, want }) => {
    expect(reordered(order, ids(...pick), how)).toEqual(want);
  });
});

describe("offsets, as spine-core reads them", () => {
  const setup = ["a", "b", "c", "d", "e"];
  /** The order spine-core draws after a draw order key with these offsets. */
  function runtime(offsets: Array<{ item: string; offset: number }>): string[] {
    const json = {
      skeleton: { spine: "4.3.00" },
      bones: [{ name: "root" }],
      slots: setup.map((name) => ({ name, bone: "root" })),
      animations: { a: { drawOrder: [{ time: 0, offsets: offsets.map((o) => ({ slot: o.item, offset: o.offset })) }] } },
    };
    const sk = new Skeleton(new SkeletonJson(new AtlasAttachmentLoader(new TextureAtlas(""))).readSkeletonData(json));
    sk.data.findAnimation("a")!.apply(sk, 0, 0, false, null, 1, MixFrom.setup, false, false, false);
    return sk.drawOrder.appliedPose.map((s) => s.data.name);
  }

  it.each([
    ["e", "a", "b", "c", "d"],
    ["b", "a", "c", "d", "e"],
    ["e", "d", "c", "b", "a"],
    ["a", "c", "e", "b", "d"],
    ["a", "b", "c", "d", "e"],
  ])("%s %s %s %s %s round-trips through the runtime", (...order) => {
    const offsets = toOffsets(order, setup);
    expect(runtime(offsets)).toEqual(order);
    expect(fromOffsets(offsets, setup)).toEqual(order);
  });

  it("offsets that put two slots on one place are no order", () => {
    expect(fromOffsets([{ item: "a", offset: 1 }, { item: "b", offset: 0 }], setup)).toBeNull();
  });
});

describe("keys", () => {
  function sym() {
    const project = createProject("D");
    const s = project.items[project.rootSymbolId] as SymbolItem;
    const add = (kind: "image" | "bone" | "group", name: string) => {
      const n = createNode(kind, name);
      s.nodes[n.id] = n;
      s.layers.push(createLayer(n.id, name, s.layers.length));
      return n.id;
    };
    // The stack top first: front, bone, back.
    const front = add("image", "front"), bone = add("bone", "bone"), back = add("image", "back");
    return { project, s, front, bone, back };
  }

  it("bones and groups do not draw", () => {
    const { s, front, back } = sym();
    expect(drawingLayers(s)).toEqual([back, front]);
  });

  it("the key at or before a frame holds; none, the stack", () => {
    const { s, front, back } = sym();
    const anim = s.animations[0]!;
    anim.drawOrder = withDrawOrderKey([], 5, [front, back], drawingLayers(s));
    anim.drawOrder = withDrawOrderKey(anim.drawOrder, 10, null, drawingLayers(s));
    expect(orderAt(s, anim, 4)).toEqual([back, front]);
    expect(orderAt(s, anim, 5)).toEqual([front, back]);
    expect(orderAt(s, anim, 9)).toEqual([front, back]);
    expect(orderAt(s, anim, 10)).toEqual([back, front]);
    expect(anim.drawOrder[1]).toEqual({ frame: 10 });
  });

  it("a file's keys: one a frame, in order, of this symbol's layers", () => {
    const { project, s, front, back } = sym();
    s.animations[0]!.drawOrder = [
      { frame: 8, order: [front, "ghost" as NodeId, back] }, { frame: 2 }, { frame: 8, order: [back] },
    ];
    const raw = JSON.parse(JSON.stringify({ ...project, version: 15 }));
    const out = validateProject(migrate(raw)).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).animations[0]!.drawOrder).toEqual([
      { frame: 2 }, { frame: 8, order: [back] },
    ]);
  });

  it("the stage draws in the key's order, and the stack in Setup", () => {
    const { s, front, back } = sym();
    const anim = s.animations[0]!;
    anim.duration = 20;
    anim.drawOrder = [{ frame: 5, order: [front, back] }];
    const drawn = (frame: number, mode: "animate" | "setup" = "animate") =>
      evaluateSymbol(s, anim, frame, mode).entries.filter((e) => e.node.kind === "image").map((e) => e.nodeId);
    expect(drawn(0)).toEqual([back, front]);
    expect(drawn(5)).toEqual([front, back]);
    expect(drawn(12.5)).toEqual([front, back]);
    expect(drawn(5, "setup")).toEqual([back, front]);
  });

  it("a mask and the layers it clips move as one", () => {
    const { s, front, back } = sym();
    const maskNode = createNode("image", "mask");
    const mask = maskNode.id;
    s.nodes[mask] = maskNode;
    s.layers.unshift(createLayer(mask, "mask", s.layers.length));
    const maskLayer = s.layers[0]!;
    maskLayer.isMask = true;
    s.layers.find((l) => l.nodeId === front)!.maskedBy = maskLayer.id;
    expect(drawUnits(s)).toEqual([[back], [front, mask]]);
    const anim = s.animations[0]!;
    // Asking for the clipped layer alone at the back takes the mask with it.
    anim.drawOrder = [{ frame: 0, order: [front, back, mask] }];
    expect(orderAt(s, anim, 0)).toEqual([front, mask, back]);
  });
});

describe("an opened file's draw order keys", () => {
  const file = (time: number) => ({
    skeleton: { spine: "4.3.74", fps: 30 }, bones: [{ name: "root" }],
    slots: ["a", "b", "c"].map((name) => ({ name, bone: "root" })),
    animations: { go: { drawOrder: [{ time, offsets: [{ slot: "a", offset: 2 }] }, { time: 1 }] } },
  });
  const open = (time: number) => {
    const { project } = importBoneBurst(file(time) as never, "f", new Map());
    const s = project.items[project.rootSymbolId] as SymbolItem;
    const name = (id: NodeId) => s.nodes[id]!.name;
    return { anim: s.animations.find((a) => a.name === "go")!, name };
  };

  it("become the document's when each lands on a frame", () => {
    const { anim, name } = open(0.5);
    expect(anim.drawOrder!.map((k) => ({ frame: k.frame, order: k.order?.map(name) }))).toEqual([
      { frame: 15, order: ["b", "c", "a"] }, { frame: 30, order: undefined },
    ]);
    expect(anim.spine?.drawOrder).toBeUndefined();
  });

  it("are carried as they came when one falls between frames", () => {
    const { anim } = open(0.51);
    expect(anim.drawOrder).toBeUndefined();
    expect(anim.spine?.drawOrder).toBeTruthy();
  });
});

describe("Modify ▸ Draw Order", () => {
  it("keys the reorder at the frame, and a bone moves the layers on it", () => {
    const project = createProject("R");
    const s = project.items[project.rootSymbolId] as SymbolItem;
    const add = (kind: "image" | "bone", name: string, parentId: NodeId | null = null) => {
      const n = createNode(kind, name, { parentId });
      s.nodes[n.id] = n;
      s.layers.push(createLayer(n.id, name, s.layers.length));
      return n.id;
    };
    // Stack top first: top, arm (a bone), hand on the arm, bottom.
    const top = add("image", "top");
    const arm = add("bone", "arm");
    const hand = add("image", "hand", arm);
    const bottom = add("image", "bottom");
    const anim = s.animations[0]!;
    expect(orderAt(s, anim, 0)).toEqual([bottom, hand, top]);
    const keys = reorderAt(s, anim, 6, [arm], "front")!;
    expect(keys).toEqual([{ frame: 6, order: [bottom, top, hand] }]);
    anim.drawOrder = keys;
    expect(orderAt(s, anim, 5)).toEqual([bottom, hand, top]);
    expect(orderAt(s, anim, 6)).toEqual([bottom, top, hand]);
    expect(reorderAt(s, anim, 6, [hand], "front")).toBeNull();
    expect(moveDrawOrderKeys(keys, [6], 3)).toEqual([{ frame: 9, order: [bottom, top, hand] }]);
    expect(deleteDrawOrderKeys(keys, [6])).toEqual([]);
  });
});

describe("withFront", () => {
  it.each([
    { front: ["a", "c"], want: ["c", "b", "a", "d"] },
    { front: ["d", "a"], want: ["a", "b", "c", "d"] },
    { front: ["b"], want: ["a", "b", "c", "d"] },
    { front: ["c", "x", "c"], want: ["a", "b", "c", "d"] },
  ])("$front front first", ({ front, want }) => {
    expect(withFront(ids("a", "b", "c", "d"), ids(...front))).toEqual(want);
  });
});

describe("placedInFront", () => {
  it.each([
    { moving: ["a"], ref: ["c"], want: ["b", "c", "a", "d"] },
    { moving: ["d"], ref: ["a"], want: ["a", "d", "b", "c"] },
    { moving: ["a", "b"], ref: ["c"], want: ["c", "a", "b", "d"] },
    { moving: ["b"], ref: ["a", "c"], want: ["a", "c", "b", "d"] },
    { moving: ["x"], ref: ["a"], want: null },
    { moving: ["a"], ref: ["a"], want: null },
  ])("$moving in front of $ref", ({ moving, ref, want }) => {
    expect(placedInFront(ids("a", "b", "c", "d"), ids(...moving), ids(...ref))).toEqual(want);
  });
});

describe("a layer dropped on a row in Animate", () => {
  it("keys the draw order: in front of that row's layer, from the playhead on", () => {
    const project = createProject("L");
    const s = project.items[project.rootSymbolId] as SymbolItem;
    const add = (name: string) => {
      const n = createNode("image", name);
      s.nodes[n.id] = n;
      s.layers.push(createLayer(n.id, name, s.layers.length));
      return n.id;
    };
    const top = add("top"), mid = add("mid"), bottom = add("bottom");
    const anim = s.animations[0]!;
    const keys = dropOrderAt(s, anim, 4, bottom, top)!;
    expect(keys).toEqual([{ frame: 4, order: [mid, top, bottom] }]);
    anim.drawOrder = keys;
    // Already in front of it: nothing to key.
    expect(dropOrderAt(s, anim, 4, bottom, top)).toBeNull();
    expect(dropOrderAt(s, anim, 4, top, bottom)).toEqual([{ frame: 4, order: [mid, bottom, top] }]);
  });
});
