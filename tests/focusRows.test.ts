import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import type { SymbolItem } from "@/core/doc/types";
import { focusRows } from "@/core/doc/layerTree";

beforeEach(() => reseed());

/** hips ▸ thigh ▸ shin, and a picture on the shin; the hips group collapsed. */
function rig() {
  const project = createProject("F");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const hips = createNode("bone", "hips");
  const thigh = createNode("bone", "thigh", { parentId: hips.id });
  const shin = createNode("bone", "shin", { parentId: thigh.id });
  const art = createNode("image", "art", { parentId: shin.id });
  const nodes = { hips, thigh, shin, art };
  for (const n of [hips, thigh, shin, art]) sym.nodes[n.id] = n;
  sym.layers = [hips, thigh, shin, art].map((n, i) => createLayer(n.id, n.name, i));
  sym.layers[0]!.collapsed = true;
  return { sym, nodes };
}

describe("focusRows", () => {
  it.each([
    { name: "no focus: the list as it is", focus: [], on: true, want: ["hips"], flat: false },
    { name: "a bone: only its row", focus: ["shin"], on: true, want: ["shin", "shin.rotate", "shin.x", "shin.y", "shin.scale", "shin.shear"], flat: true },
    { name: "two bones, in layer order", focus: ["shin", "hips"], on: true, want: ["hips", "hips.rotate", "hips.x", "hips.y", "hips.scale", "hips.shear", "shin", "shin.rotate", "shin.x", "shin.y", "shin.scale", "shin.shear"], flat: true },
    { name: "a bone and a picture", focus: ["art", "thigh"], on: true, want: ["thigh", "thigh.rotate", "thigh.x", "thigh.y", "thigh.scale", "thigh.shear", "art"], flat: true },
    { name: "pictures only: every row", focus: ["art"], on: true, want: ["hips"], flat: false },
    { name: "switched off", focus: ["shin"], on: false, want: ["hips"], flat: false },
  ])("$name", ({ focus, on, want, flat }) => {
    const { sym, nodes } = rig();
    const ids = focus.map((k) => nodes[k as keyof typeof nodes].id);
    const rows = focusRows(sym, ids, on);
    expect(rows.map((r) => (r.prop ? `${r.node.name}.${r.prop}` : r.node.name))).toEqual(want);
    // Flat: the focused rows at the top level, each bone's properties one in.
    if (flat) expect(rows.every((r) => r.depth === (r.prop ? 1 : 0) && !r.hasChildren)).toBe(true);
  });
});
