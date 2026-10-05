import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import { DOC_VERSION, type SymbolItem } from "@/core/doc/types";
import { validateProject } from "@/core/doc/schema";
import { migrate } from "@/core/doc/migrations";

beforeEach(() => reseed());

describe("version 28: Spine's blend modes only, no motion blur", () => {
  function v27(blends: string[]) {
    const project = createProject();
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const ids = blends.map((b, i) => {
      const n = createNode("empty", `n${i}`);
      sym.nodes[n.id] = { ...n, blendMode: b, motionBlur: 0.5 } as typeof n;
      sym.layers.push(createLayer(n.id, `L${i}`, 0));
      return n.id;
    });
    const raw = JSON.parse(JSON.stringify({ ...project, version: 27, motionBlur: { enabled: true, shutter: 180, maxLength: 64 } }));
    const out = validateProject(migrate(raw)).project;
    return { out, nodes: (out.items[out.rootSymbolId] as SymbolItem).nodes, ids };
  }

  it("keeps add, multiply and screen, and drops the five Spine lacks", () => {
    const blends = ["add", "multiply", "screen", "overlay", "darken", "lighten", "difference", "hardlight"];
    const { out, nodes, ids } = v27(blends);
    expect(out.version).toBe(DOC_VERSION);
    expect(ids.map((id) => nodes[id]!.blendMode ?? "normal")).toEqual(
      ["add", "multiply", "screen", "normal", "normal", "normal", "normal", "normal"]);
  });

  it("drops the document's and every node's motion blur", () => {
    const { out, nodes, ids } = v27(["add"]);
    expect("motionBlur" in out).toBe(false);
    expect("motionBlur" in nodes[ids[0]!]!).toBe(false);
  });

  it("drops an unknown blend mode in a current file too", () => {
    const project = createProject();
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const n = createNode("empty", "n");
    sym.nodes[n.id] = { ...n, blendMode: "overlay" } as unknown as typeof n;
    sym.layers.push(createLayer(n.id, "L", 0));
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project;
    expect((out.items[out.rootSymbolId] as SymbolItem).nodes[n.id]!.blendMode).toBeUndefined();
  });
});
