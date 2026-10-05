import { describe, it, expect, beforeEach } from "vitest";
import { reseed, type AssetId } from "@/core/doc/ids";
import { createProject, createImageItem, createNode, createLayer } from "@/core/doc/defaults";
import { isSymbol, type Project, type SymbolItem } from "@/core/doc/types";
import {
  normalizeMasks, maskRepairs, maskGroups, maskCandidate, nearestMaskAbove,
} from "@/core/doc/layerTree";
import { History } from "@/core/history/History";
import { AddNode, RemoveNodes } from "@/core/history/commands";
import { ReorderLayer, SetLayerMasks } from "@/core/history/layerCommands";
import { Store } from "@/app/Store";
import { Clipboard } from "@/app/Clipboard";

beforeEach(() => reseed());

/**
 * Masks are an EDITOR + Pixi-host feature: DragonBones 5.x has no mask in the
 * format, no key in the parser and no `display.mask` anywhere in PixiSlot.
 * These pin down the document invariants and the sidecar, because none of it
 * can be caught later by the skeleton failing to parse.
 */
function scene(names: string[]): { project: Project; sym: SymbolItem } {
  const project = createProject("Clip");
  const sym = project.items[project.rootSymbolId];
  if (!isSymbol(sym)) throw new Error("no root");
  names.forEach((name, i) => {
    const item = createImageItem(name, `asset_${name}` as AssetId, 50, 50);
    project.items[item.id] = item;
    project.itemOrder.push(item.id);
    const node = createNode("image", name, { itemId: item.id });
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, name, i));   // index 0 is the TOP row
  });
  return { project, sym };
}

/** Link `layers[maskIdx]` as a mask over `layers[targetIdx]`. */
function link(sym: SymbolItem, maskIdx: number, targetIdx: number): void {
  sym.layers[maskIdx]!.isMask = true;
  sym.layers[targetIdx]!.maskedBy = sym.layers[maskIdx]!.id;
}

describe("mask links", () => {
  it("groups masked layers under their mask", () => {
    const { sym } = scene(["bottom", "middle", "top"]);   // layers: top, middle, bottom
    link(sym, 0, 1);
    const groups = maskGroups(sym);
    expect(groups.size).toBe(1);
    expect(groups.get(sym.layers[0]!.id)!.map((l) => l.name)).toEqual(["middle"]);
  });

  it("drops a link whose mask sits BELOW what it clips", () => {
    // layers[0] is the top row, so "above" is a smaller index. A mask under
    // its target cannot clip it and the link is meaningless.
    const { sym } = scene(["bottom", "middle", "top"]);
    sym.layers[2]!.isMask = true;
    sym.layers[0]!.maskedBy = sym.layers[2]!.id;
    normalizeMasks(sym);
    expect(sym.layers[0]!.maskedBy).toBeUndefined();
  });

  it("drops a link to a layer that is no longer a mask", () => {
    const { sym } = scene(["bottom", "top"]);
    link(sym, 0, 1);
    delete sym.layers[0]!.isMask;
    normalizeMasks(sym);
    expect(sym.layers[1]!.maskedBy).toBeUndefined();
  });

  it("demotes a mask that has nothing left linked to it", () => {
    // Otherwise its artwork would stay invisible on the stage — a mask never
    // draws itself — for no reason the user can see.
    const { sym } = scene(["bottom", "top"]);
    link(sym, 0, 1);
    delete sym.layers[1]!.maskedBy;
    normalizeMasks(sym);
    expect(sym.layers[0]!.isMask).toBeUndefined();
  });

  it("refuses a layer that masks itself", () => {
    const { sym } = scene(["only", "top"]);
    sym.layers[0]!.isMask = true;
    sym.layers[0]!.maskedBy = sym.layers[0]!.id;
    normalizeMasks(sym);
    expect(sym.layers[0]!.maskedBy).toBeUndefined();
  });

  it("works out the repairs without touching a layer", () => {
    const { sym } = scene(["bottom", "middle", "top"]);
    sym.layers[2]!.isMask = true;
    sym.layers[0]!.maskedBy = sym.layers[2]!.id;          // mask BELOW its target
    const [top, , bottom] = sym.layers;
    const repairs = maskRepairs(sym.layers);
    expect(repairs).toEqual(new Map([
      [top!.id, { isMask: false, maskedBy: undefined }],
      [bottom!.id, { isMask: false, maskedBy: undefined }],
    ]));
    expect(top!.maskedBy).toBe(bottom!.id);
    expect(bottom!.isMask).toBe(true);
    expect(maskRepairs(sym.layers.slice(1, 2)).size).toBe(0);
  });

  it("offers exactly the layer directly below, as Flash does", () => {
    const { sym } = scene(["bottom", "middle", "top"]);
    expect(maskCandidate(sym, sym.layers[0]!.id)!.name).toBe("middle");
    // Not the whole run below: swallowing extra layers silently is worse than
    // making the user link the second one by hand.
    expect(maskCandidate(sym, sym.layers[2]!.id)).toBeNull();
  });

  it("will not take a layer that is already spoken for", () => {
    const { sym } = scene(["bottom", "middle", "top"]);
    link(sym, 1, 2);                                   // middle masks bottom
    expect(maskCandidate(sym, sym.layers[0]!.id)).toBeNull();
  });

  it("finds the nearest mask above for the Masked toggle", () => {
    const { sym } = scene(["bottom", "middle", "top"]);
    sym.layers[0]!.isMask = true;
    expect(nearestMaskAbove(sym, sym.layers[2]!.id)!.name).toBe("top");
    expect(nearestMaskAbove(sym, sym.layers[0]!.id)).toBeNull();
  });
});

/* ── Undo keeps both ends of a link ──────────────────────────────────────
   Every structural command re-runs `normalizeMasks`, which drops links and
   demotes masks as a side effect. The inverse has to put that back too, or
   an undo returns a layer to its place under the mask and leaves it unclipped. */

describe("mask links survive undo and redo", () => {
  /** mask over target, plus a spare layer at the bottom. */
  function linked() {
    const { project, sym } = scene(["spare", "target", "mask"]);   // mask, target, spare
    link(sym, 0, 1);
    const [mask, target, spare] = sym.layers;
    return { project, sym, mask: mask!, target: target!, spare: spare!, history: new History(project) };
  }
  const state = (sym: SymbolItem) => sym.layers.map((l) => [l.name, !!l.isMask, l.maskedBy ?? null]);

  it("after reordering a masked layer out from under its mask", () => {
    const { sym, target, history } = linked();
    const before = state(sym);
    history.apply(new ReorderLayer(sym.id, target.id, 0));
    expect(target.maskedBy).toBeUndefined();
    history.undo();
    expect(state(sym)).toEqual(before);
  });

  it("after unlinking the last layer a mask clips", () => {
    const { sym, target, history } = linked();
    const before = state(sym);
    history.apply(new SetLayerMasks(sym.id, new Map([[target.id, {}]])));
    history.undo();
    expect(state(sym)).toEqual(before);
  });

  it("after deleting a target and adding a layer in between", () => {
    const { sym, target, history } = linked();
    const before = state(sym);
    history.apply(new RemoveNodes(sym.id, [target.nodeId]));
    const extra = createNode("empty", "Layer 1");
    history.apply(new AddNode("New Layer", sym.id, extra, createLayer(extra.id, "Layer 1", 9), 0));
    history.undo();
    history.undo();
    expect(state(sym)).toEqual(before);
  });

  // Deleting used to leave the targets linked to a layer that no longer
  // existed, until some later structural command dropped the links.
  it("after deleting the mask itself", () => {
    const { sym, mask, target, history } = linked();
    const before = state(sym);
    history.apply(new RemoveNodes(sym.id, [mask.nodeId]));
    expect(target.maskedBy).toBeUndefined();
    history.undo();
    expect(state(sym)).toEqual(before);
    history.redo();
    expect(target.maskedBy).toBeUndefined();
  });

  it("after pasting a mask and what it clips, undone and redone", () => {
    const { project, sym, mask, target } = linked();
    const store = new Store(project);
    const clipboard = new Clipboard();
    store.selectNodes([mask.nodeId, target.nodeId]);
    clipboard.copyLayers(store);
    store.selectNodes([]);
    clipboard.pasteLayers(store);

    const pasted = () => sym.layers.slice(0, 2);
    const check = () => {
      const [m, t] = pasted();
      expect(m!.isMask).toBe(true);
      expect(t!.maskedBy).toBe(m!.id);
      expect(mask.isMask).toBe(true);
      expect(target.maskedBy).toBe(mask.id);
    };
    check();
    store.undo();
    expect(sym.layers).toHaveLength(3);
    store.redo();
    check();
  });
});
