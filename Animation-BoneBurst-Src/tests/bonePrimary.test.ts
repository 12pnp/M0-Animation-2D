import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import { DOC_VERSION, type SymbolItem } from "@/core/doc/types";
import { migrate, validateProject } from "@/core/doc/schema";
import { History } from "@/core/history/History";
import { SetBonePrimary } from "@/core/history/commands";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";

beforeEach(() => reseed());

function scene() {
  const project = createProject("P");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const leg = createNode("bone", "leg"), toe = createNode("bone", "toe"), art = createNode("image", "art");
  for (const n of [leg, toe, art]) { sym.nodes[n.id] = n; sym.layers.push(createLayer(n.id, n.name, 0)); }
  return { project, sym, leg, toe, art };
}

describe("Node.primary", () => {
  it("is marked and unmarked by one undoable command, on bones only", () => {
    const { project, sym, leg, toe, art } = scene();
    const history = new History(project);
    history.apply(new SetBonePrimary(project.rootSymbolId, [leg.id, art.id], true));
    const nodes = () => sym.nodes;
    expect(nodes()[leg.id]!.primary).toBe(true);
    expect(nodes()[toe.id]!.primary).toBeUndefined();
    expect(nodes()[art.id]!.primary).toBeUndefined();
    history.undo();
    expect(nodes()[leg.id]!.primary).toBeUndefined();
  });

  it("survives a save, and a bad value or a non-bone is dropped", () => {
    const { project, leg, toe, art } = scene();
    leg.primary = true;
    (toe as { primary?: unknown }).primary = "yes";
    (art as { primary?: unknown }).primary = true;
    const raw = JSON.parse(JSON.stringify({ ...project, version: 13 }));
    const out = validateProject(migrate(raw)).project;
    const nodes = (out.items[out.rootSymbolId] as SymbolItem).nodes;
    expect(out.version).toBe(DOC_VERSION);
    expect(nodes[leg.id]!.primary).toBe(true);
    expect(nodes[toe.id]!.primary).toBeUndefined();
    expect(nodes[art.id]!.primary).toBeUndefined();
  });

  it("is never exported", () => {
    const { project, leg } = scene();
    leg.primary = true;
    expect(boneburstJson(exportBoneBurst(project).skeleton)).not.toContain("primary");
  });
});
