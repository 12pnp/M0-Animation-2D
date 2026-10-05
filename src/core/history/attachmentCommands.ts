import type { Command, TouchSet } from "./Command";
import type { Node, Project, SequenceKey, SymbolItem } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

/**
 * A node replaced by `edit` of itself: one undo step for a change the plans
 * in `core/doc/` decided (a box's points, a sequence). Steps of one drag share
 * a `kind` and merge, keeping the first `before`.
 */
export class EditNode implements Command {
  readonly touches: TouchSet;
  private before: Node | null = null;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly nodeId: NodeId,
    private edit: (node: Node) => Node,
    readonly kind = "node.edit",
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const node = sym.nodes[this.nodeId];
    if (!node) return;
    this.before ??= node;
    sym.nodes[this.nodeId] = this.edit(node);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!this.before || !sym.nodes[this.nodeId]) return;
    sym.nodes[this.nodeId] = this.before;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof EditNode) || next.kind !== this.kind || this.kind === "node.edit") return false;
    if (next.symbolId !== this.symbolId || next.nodeId !== this.nodeId) return false;
    this.edit = next.edit;
    return true;
  }
}

/** A box node with `points`. */
export function boxEdit(label: string, symbolId: ItemId, nodeId: NodeId, points: number[], kind = "node.edit"): EditNode {
  return new EditNode(label, symbolId, nodeId, (n) => ({ ...n, box: { points } }), kind);
}

/** One node's sequence keys in an animation replaced. Steps of one drag merge. */
export class SetSequenceKeys implements Command {
  readonly touches: TouchSet;
  private before: SequenceKey[] | undefined;
  private captured = false;

  constructor(
    readonly label: string, private readonly symbolId: ItemId, private readonly animId: AnimId,
    private readonly nodeId: NodeId, private after: SequenceKey[], readonly kind = "timeline.sequence",
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], timeline: true, stage: true };
  }

  private write(p: Project, keys: SequenceKey[] | undefined): void {
    const anim = symbolOf(p, this.symbolId).animations.find((a) => a.id === this.animId);
    if (!anim) return;
    const out = { ...anim.sequences };
    if (keys?.length) out[this.nodeId] = keys; else delete out[this.nodeId];
    if (Object.keys(out).length) anim.sequences = out; else delete anim.sequences;
    invalidateBounds([this.symbolId]);
  }

  apply(p: Project): void {
    if (!this.captured) {
      this.before = symbolOf(p, this.symbolId).animations.find((a) => a.id === this.animId)?.sequences?.[this.nodeId];
      this.captured = true;
    }
    this.write(p, this.after);
  }

  revert(p: Project): void { this.write(p, this.before); }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetSequenceKeys) || next.kind !== this.kind || this.kind === "timeline.sequence") return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId || next.nodeId !== this.nodeId) return false;
    this.after = next.after;
    return true;
  }
}

export type ConstraintField = "physics" | "sliders" | "paths";

/**
 * A symbol's physics, slider or path constraints replaced, as one value
 * (ARCHITECTURE ▸ Physics, sliders and paths). Steps of one drag share a
 * `kind` and merge.
 */
export class SetConstraintList implements Command {
  readonly touches: TouchSet;
  private before: unknown;
  private captured = false;

  constructor(
    readonly label: string, private readonly symbolId: ItemId, private readonly field: ConstraintField,
    private after: SymbolItem[ConstraintField], readonly kind = "symbol.constraints",
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }

  private write(p: Project, list: unknown): void {
    const sym = symbolOf(p, this.symbolId);
    if (Array.isArray(list) && list.length) (sym as unknown as Record<string, unknown>)[this.field] = list;
    else delete sym[this.field];
    invalidateBounds([this.symbolId]);
  }

  apply(p: Project): void {
    if (!this.captured) { this.before = symbolOf(p, this.symbolId)[this.field]; this.captured = true; }
    this.write(p, this.after);
  }

  revert(p: Project): void { this.write(p, this.before); }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetConstraintList) || next.kind !== this.kind || this.kind === "symbol.constraints") return false;
    if (next.symbolId !== this.symbolId || next.field !== this.field) return false;
    this.after = next.after;
    return true;
  }
}
