import { describe, it, expect, beforeEach } from "vitest";
import { reseed, newIkId, type NodeId } from "@/core/doc/ids";
import { createProject, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type SymbolItem } from "@/core/doc/types";
import { evaluateSymbol, invalidateBounds } from "@/core/doc/pose";
import { LooseBones } from "@/core/boneburst/runtime/bones";
import { oneBone } from "@/core/boneburst/runtime/ik";

beforeEach(() => { reseed(); invalidateBounds(); });

/**
 * The solver is the runtime's (`core/boneburst/runtime/ik.ts`), held to
 * spine-core in runtimeConstraints.test.ts and, on the stage, on whole rigs
 * in spineParity.test.ts. These are the behaviours the editor relies on.
 */
describe("IK solver", () => {
  /** A bone at the origin under an identity parent, local rotation `rotation`, pointed at (x, y). */
  const aim = (rotation: number, x: number, y: number, mix: number): number => {
    const bones = new LooseBones([{ parent: -1, length: 0 }, { parent: 0, length: 50 }]);
    bones.world.set([1, 0, 0, 1, 0, 0], 0);
    bones.setBone(1, 0, 0, rotation, 1, 1, 0, 0);
    oneBone(bones, 1, x, y, false, false, "none", mix);
    return bones.local[1 * 7 + 2]!;
  };

  it("points one bone at the target, in local degrees", () => {
    expect(aim(0, 0, 50, 1)).toBeCloseTo(90, 4);
  });

  it("blends the rotation by the mix", () => {
    expect(aim(0, 0, 50, 0.5)).toBeCloseTo(45, 4);
  });

  it("takes the short way round from where the bone is", () => {
    const r = aim(170, -100, -10, 1);
    // From 170 to the target at about -174: 16 degrees on, not 344 back.
    expect(r).toBeGreaterThan(170);
    expect(r).toBeLessThan(190);
  });
});

function rig(chain: 0 | 1 = 1) {
  const project = createProject("Rig");
  const root = project.items[project.rootSymbolId];
  if (!isSymbol(root)) throw new Error("no root");

  const add = (name: string, x: number, y: number, parentId: NodeId | null, length: number) => {
    const n = createNode("bone", name, { x, y, parentId });
    n.boneLength = length;
    root.nodes[n.id] = n;
    root.layers.unshift(createLayer(n.id, name, root.layers.length));
    return n;
  };

  const upper = add("upper", 0, 0, null, 100);
  const lower = add("lower", 100, 0, upper.id, 100);
  const target = add("target", 200, 0, null, 20);

  root.ik.push({
    id: newIkId(), name: "arm_ik",
    boneId: lower.id, targetId: target.id,
    chain, bendPositive: true, weight: 1,
  });

  return { project, root, upper, lower, target };
}

const tipOfEntry = (world: { a: number; b: number; tx: number; ty: number }, len: number) =>
  ({ x: world.tx + world.a * len, y: world.ty + world.b * len });

describe("IK in a pose", () => {
  it("moves the chain so the effector's tip reaches the target", () => {
    const { root, target, lower } = rig(1);
    target.bind.x = 100;
    target.bind.y = 120;

    const pose = evaluateSymbol(root as SymbolItem, null, 0, "setup");
    const tip = tipOfEntry(pose.byNode.get(lower.id)!.world, 100);
    // To the runtime's precision: Spine's solver uses its own pi, 3.1415927.
    expect(tip.x).toBeCloseTo(100, 4);
    expect(tip.y).toBeCloseTo(120, 4);
  });

  it("carries the effector's children along", () => {
    const { root, target, lower } = rig(1);
    // A hand hanging off the end of the lower bone.
    const hand = createNode("bone", "hand", { x: 100, y: 0, parentId: lower.id });
    hand.boneLength = 10;
    (root as SymbolItem).nodes[hand.id] = hand;
    (root as SymbolItem).layers.unshift(createLayer(hand.id, "hand", 9));

    target.bind.x = 100;
    target.bind.y = 120;

    const pose = evaluateSymbol(root as SymbolItem, null, 0, "setup");
    const handWorld = pose.byNode.get(hand.id)!.world;
    // The hand sits exactly where the solved lower bone's tip is.
    const tip = tipOfEntry(pose.byNode.get(lower.id)!.world, 100);
    expect(handWorld.tx).toBeCloseTo(tip.x, 6);
    expect(handWorld.ty).toBeCloseTo(tip.y, 6);
  });

  it("never writes the solve back into the document", () => {
    const { root, target, upper, lower } = rig(1);
    target.bind.x = 40;
    target.bind.y = 90;
    evaluateSymbol(root as SymbolItem, null, 0, "setup");

    // The file still describes the rest pose; the runtime does the solving.
    expect(upper.bind.skewY).toBe(0);
    expect(lower.bind.x).toBe(100);
    expect(lower.bind.skewY).toBe(0);
  });

  it("solves one bone when the chain is 0", () => {
    const { root, target, upper, lower } = rig(0);
    // Straight below the lower bone's own root, which is at world (100, 0).
    target.bind.x = 100;
    target.bind.y = 200;

    const pose = evaluateSymbol(root as SymbolItem, null, 0, "setup");
    const lowerWorld = pose.byNode.get(lower.id)!.world;
    const upperWorld = pose.byNode.get(upper.id)!.world;

    expect(Math.atan2(lowerWorld.b, lowerWorld.a)).toBeCloseTo(Math.PI / 2, 6);
    // Only the constrained bone moves: the parent keeps its rest rotation.
    expect(Math.atan2(upperWorld.b, upperWorld.a)).toBeCloseTo(0, 9);
  });

  it("refuses a target that hangs off the chain it drives", () => {
    const circular = rig(1);
    // Parent the target to the very bone it is supposed to move.
    circular.target.parentId = circular.lower.id;
    const posed = evaluateSymbol(circular.root as SymbolItem, null, 0, "setup");
    expect(posed.byNode.get(circular.lower.id)!.world.b).toBeCloseTo(0, 9);

    // The same rig with the target outside the chain does solve, so the test
    // above is the guard working rather than the rig doing nothing.
    invalidateBounds();
    const sane = rig(1);
    sane.target.bind.x = 100;
    sane.target.bind.y = 120;
    const ok = evaluateSymbol(sane.root as SymbolItem, null, 0, "setup");
    expect(ok.byNode.get(sane.lower.id)!.world.b).not.toBeCloseTo(0, 3);
  });
});
