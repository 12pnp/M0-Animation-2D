import type { Command, TouchSet } from "./Command";
import type { Project, SymbolItem, TcKey, TransformConstraint } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { AnimId, ItemId, TcId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { orderAfterEdit } from "@/core/doc/constraintOrder";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

/**
 * A symbol's transform constraints replaced, the list as a whole: adding,
 * removing and editing one are all this (ARCHITECTURE ▸ Transform
 * constraints). Steps of one field scrub share a `kind` and merge.
 */
export class SetTransforms implements Command {
  readonly touches: TouchSet;
  private before: TransformConstraint[] | undefined;
  private orderBefore: string[] | undefined;
  private captured = false;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private after: TransformConstraint[],
    readonly kind = "transforms.list",
  ) {
    this.touches = { symbols: [symbolId], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!this.captured) { this.before = sym.transforms; this.orderBefore = sym.constraintOrder; this.captured = true; }
    if (this.after.length) sym.transforms = this.after;
    else delete sym.transforms;
    // A renamed constraint keeps its place in the order.
    const order = orderAfterEdit(this.orderBefore, this.before, this.after);
    if (order !== sym.constraintOrder && order) sym.constraintOrder = [...order];
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before) sym.transforms = this.before;
    else delete sym.transforms;
    if (this.orderBefore) sym.constraintOrder = this.orderBefore; else delete sym.constraintOrder;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetTransforms) || next.kind !== this.kind || next.symbolId !== this.symbolId) return false;
    this.after = next.after;
    return true;
  }
}

/** One transform constraint's keys in an animation replaced
 *  (`core/doc/transformKeys.ts`). Steps of one drag merge. */
export class SetTcKeys implements Command {
  readonly touches: TouchSet;
  private before: TcKey[] | undefined;
  private captured = false;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private readonly tcId: TcId,
    private after: TcKey[],
    readonly kind = "timeline.transform",
  ) {
    this.touches = { symbols: [symbolId], timeline: true, stage: true };
  }

  private write(p: Project, keys: TcKey[] | undefined): void {
    const anim = symbolOf(p, this.symbolId).animations.find((a) => a.id === this.animId);
    if (!anim) return;
    const out = { ...anim.transforms };
    if (keys?.length) out[this.tcId] = keys;
    else delete out[this.tcId];
    if (Object.keys(out).length) anim.transforms = out;
    else delete anim.transforms;
    invalidateBounds([this.symbolId]);
  }

  apply(p: Project): void {
    if (!this.captured) {
      this.before = symbolOf(p, this.symbolId).animations.find((a) => a.id === this.animId)?.transforms?.[this.tcId];
      this.captured = true;
    }
    this.write(p, this.after);
  }

  revert(p: Project): void { this.write(p, this.before); }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetTcKeys) || next.kind !== this.kind) return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId || next.tcId !== this.tcId) return false;
    this.after = next.after;
    return true;
  }
}
