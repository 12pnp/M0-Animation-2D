import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type NodeId } from "@/core/doc/ids";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import { editTargets } from "@/core/doc/transformOps";

beforeEach(() => reseed());

describe("editTargets", () => {
  function scene() {
    const project = createProject("P");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const add = (name: string, parent: NodeId | null = null) => {
      const n = createNode("bone", name, { parentId: parent });
      sym.nodes[n.id] = n;
      sym.layers.push(createLayer(n.id, name, 0));
      return n.id;
    };
    const hip = add("hip"), leg = add("leg", hip), arm = add("arm"), lock = add("lock");
    sym.layers.find((l) => l.nodeId === lock)!.locked = true;
    return { sym, hip, leg, arm, lock };
  }
  it("keeps the topmost of a chain, drops missing and locked nodes", () => {
    const { sym, hip, leg, arm, lock } = scene();
    expect(editTargets(sym, [leg, hip, arm, lock, "gone" as NodeId])).toEqual([hip, arm]);
  });
  it("keeps locked layers when asked to", () => {
    const { sym, arm, lock } = scene();
    expect(editTargets(sym, [arm, lock], false)).toEqual([arm, lock]);
  });
  it("a child alone is its own target", () => {
    const { sym, leg } = scene();
    expect(editTargets(sym, [leg])).toEqual([leg]);
  });
});
