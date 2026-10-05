import type { LayerId, ItemId } from "@/core/doc/ids";
import { type Normalization, maskStateOf, assignMask, normalizeMasks, denormalize, normalizeLayerOrder } from "@/core/doc/layerTree";
import type { Project, Layer } from "@/core/doc/types";
import type { Command, TouchSet } from "./Command";
import type { MaskState } from "@/core/doc/layerTree";
import { symbolOf } from "./lookup";

/**
 * Set the mask links of several layers at once.
 *
 * One command rather than a "make mask" and an "unlink" pair, because every
 * mask edit touches BOTH ends of the relationship — making a layer a mask
 * links the one below it, and clearing a mask has to clear every link
 * pointing at it. The caller computes the whole desired state; this just
 * swaps it in and remembers what was there.
 */

export class SetLayerMasks implements Command {
  readonly kind = "layer.mask";
  readonly touches: TouchSet;
  readonly label = "Mask";
  /** The layers this set, as they were. */
  private before = new Map<LayerId, MaskState>();
  /** What `normalizeMasks` changed on top: unlinking the last target
   *  demotes its mask, which `next` does not mention. */
  private norm: Normalization | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly next: Map<LayerId, MaskState>
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before = new Map();
    for (const [id, state] of this.next) {
      const l = sym.layers.find((x) => x.id === id);
      if (!l) continue;
      this.before.set(id, maskStateOf(l));
      assignMask(l, state);
    }
    this.norm = normalizeMasks(sym);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    for (const [id, state] of this.before) {
      const l = sym.layers.find((x) => x.id === id);
      if (l) assignMask(l, state);
    }
  }
}

export class ReorderLayer implements Command {
  readonly kind = "layer.reorder";
  readonly touches: TouchSet;
  readonly label = "Reorder Layer";
  private from = -1;
  private norm: Normalization | null = null;
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerId: string,
    private readonly to: number
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.from = sym.layers.findIndex((l) => l.id === this.layerId);
    if (this.from < 0) return;
    const [layer] = sym.layers.splice(this.from, 1);
    sym.layers.splice(Math.max(0, Math.min(this.to, sym.layers.length)), 0, layer!);
    this.norm = normalizeLayerOrder(sym);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.from < 0) return;
    if (this.norm) denormalize(sym, this.norm);
    const i = sym.layers.findIndex((l) => l.id === this.layerId);
    if (i < 0) return;
    const [layer] = sym.layers.splice(i, 1);
    sym.layers.splice(this.from, 0, layer!);
  }
}
/** The whole layer list in a new order, by id: what `siblingOrder` plans.
 *  Ids rather than the layer objects, so a redo uses the layers as they are. */

export class SetLayerOrder implements Command {
  readonly kind = "layer.order";
  readonly touches: TouchSet;
  private before: Layer[] | null = null;
  private norm: Normalization | null = null;
  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly order: readonly LayerId[]
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before = sym.layers;
    const byId = new Map(sym.layers.map((l) => [l.id, l]));
    const listed = this.order.map((id) => byId.get(id)).filter((l): l is Layer => !!l);
    sym.layers = [...listed, ...sym.layers.filter((l) => !this.order.includes(l.id))];
    this.norm = normalizeLayerOrder(sym);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    if (this.before) sym.layers = this.before;
  }
}

export class SetLayerFlag implements Command {
  readonly kind = "layer.flag";
  readonly touches: TouchSet;
  private before = false;
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerId: string,
    private readonly flag: "visible" | "locked" | "outline",
    private readonly value: boolean
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }
  get label(): string { return `Toggle ${this.flag}`; }
  apply(p: Project): void {
    const l = symbolOf(p, this.symbolId).layers.find((x) => x.id === this.layerId);
    if (!l) return;
    this.before = l[this.flag];
    l[this.flag] = this.value;
  }
  revert(p: Project): void {
    const l = symbolOf(p, this.symbolId).layers.find((x) => x.id === this.layerId);
    if (l) l[this.flag] = this.before;
  }
}
/**
 * "Exclude from Export" — reference art and test rigs that must not reach the
 * file.
 *
 * A sibling of `SetLayerFlag` rather than a fourth entry in its union: that
 * command indexes `l[this.flag]` and assumes a required boolean, while this
 * flag has to be ABSENT when off so a saved file stays clean.
 */

export class SetLayerExcluded implements Command {
  readonly kind = "layer.flag";
  readonly touches: TouchSet;
  private before = new Map<LayerId, boolean>();
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerIds: LayerId[],
    private readonly value: boolean
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  get label(): string { return this.value ? "Exclude from Export" : "Include in Export"; }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const id of this.layerIds) {
      const l = sym.layers.find((x) => x.id === id);
      if (!l) continue;
      this.before.set(id, l.excludeFromExport === true);
      if (this.value) l.excludeFromExport = true;
      else delete l.excludeFromExport;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, was] of this.before) {
      const l = sym.layers.find((x) => x.id === id);
      if (!l) continue;
      if (was) l.excludeFromExport = true;
      else delete l.excludeFromExport;
    }
  }
}

export class RenameLayer implements Command {
  readonly kind = "layer.rename";
  readonly touches: TouchSet;
  readonly label = "Rename Layer";
  private before = "";
  private beforeNode = "";
  constructor(
    private readonly symbolId: ItemId,
    private readonly layerId: string,
    private readonly name: string
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const l = sym.layers.find((x) => x.id === this.layerId);
    if (!l) return;
    this.before = l.name;
    l.name = this.name;
    const n = sym.nodes[l.nodeId];
    if (n) { this.beforeNode = n.name; n.name = this.name; }
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const l = sym.layers.find((x) => x.id === this.layerId);
    if (!l) return;
    l.name = this.before;
    const n = sym.nodes[l.nodeId];
    if (n) n.name = this.beforeNode;
  }
}
