import type { Command, TouchSet } from "./Command";
import type { Animation, Project, TcKey, TransformConstraint } from "@/core/doc/types";
import type { AnimId, ItemId, TcId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { orderAfterEdit } from "@/core/doc/constraintOrder";
import { symbolOf } from "./lookup";
import { SetAnimKeys, withListAt } from "./animKeysCommand";

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
export class SetTcKeys extends SetAnimKeys<TcKey[]> {
  constructor(label: string, symbolId: ItemId, animId: AnimId, private readonly tcId: TcId, after: TcKey[], kind = "timeline.transform") {
    super(label, symbolId, animId, after, kind);
  }
  protected read(anim: Animation): TcKey[] | undefined { return anim.transforms?.[this.tcId]; }
  protected write(anim: Animation, keys: TcKey[] | undefined): void {
    const transforms = withListAt(anim.transforms, this.tcId, keys);
    if (transforms) anim.transforms = transforms; else delete anim.transforms;
  }
  protected sameList(next: this): boolean { return next.tcId === this.tcId; }
}
