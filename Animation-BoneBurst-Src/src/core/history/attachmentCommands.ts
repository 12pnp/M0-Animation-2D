import type { Command, TouchSet } from "./Command";
import type { Animation, InheritKey, Node, Project, SequenceKey, SymbolItem } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { orderAfterEdit } from "@/core/doc/constraintOrder";
import { symbolOf, animOf } from "./lookup";
import { SetAnimKeys, withListAt } from "./animKeysCommand";

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

/** An animation's per-node key lists: sequence keys and inherit keys. */
export type NodeKeyField = "sequences" | "inherits";
type NodeKeys<F extends NodeKeyField> = NonNullable<Animation[F]>[NodeId];

/** One node's keys of `field` in an animation replaced. Steps of one drag merge. */
export class SetNodeKeys<F extends NodeKeyField> extends SetAnimKeys<NodeKeys<F>> {
  protected override readonly discreteKind: string;

  constructor(
    label: string, symbolId: ItemId, animId: AnimId,
    private readonly nodeId: NodeId, after: NodeKeys<F>, kind: string, private readonly field: F,
  ) {
    super(label, symbolId, animId, after, kind, [nodeId]);
    this.discreteKind = `timeline.${field}`;
  }
  protected read(anim: Animation): NodeKeys<F> | undefined { return anim[this.field]?.[this.nodeId] as NodeKeys<F> | undefined; }
  protected write(anim: Animation, keys: NodeKeys<F> | undefined): void {
    const out = withListAt(anim[this.field] as Record<NodeId, NodeKeys<F>> | undefined, this.nodeId, keys);
    if (out) (anim as unknown as Record<string, unknown>)[this.field] = out; else delete anim[this.field];
  }
  protected sameList(next: this): boolean { return next.field === this.field && next.nodeId === this.nodeId; }
}

/** One node's sequence keys in an animation replaced. */
export class SetSequenceKeys extends SetNodeKeys<"sequences"> {
  constructor(label: string, symbolId: ItemId, animId: AnimId, nodeId: NodeId, after: SequenceKey[], kind = "timeline.sequence") {
    super(label, symbolId, animId, nodeId, after, kind === "timeline.sequence" ? "timeline.sequences" : kind, "sequences");
  }
}

/** One bone's inherit keys in an animation replaced (`core/doc/inherit.ts`). */
export class SetInheritKeys extends SetNodeKeys<"inherits"> {
  constructor(label: string, symbolId: ItemId, animId: AnimId, nodeId: NodeId, after: InheritKey[], kind = "timeline.inherits") {
    super(label, symbolId, animId, nodeId, after, kind, "inherits");
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
  private orderBefore: string[] | undefined;
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
    const sym = symbolOf(p, this.symbolId);
    if (!this.captured) { this.before = sym[this.field]; this.orderBefore = sym.constraintOrder; this.captured = true; }
    this.write(p, this.after);
    setOrder(sym, orderAfterEdit(this.orderBefore, this.before as never, this.after));
  }

  revert(p: Project): void {
    this.write(p, this.before);
    setOrder(symbolOf(p, this.symbolId), this.orderBefore);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetConstraintList) || next.kind !== this.kind || this.kind === "symbol.constraints") return false;
    if (next.symbolId !== this.symbolId || next.field !== this.field) return false;
    this.after = next.after;
    return true;
  }
}

function setOrder(sym: SymbolItem, order: readonly string[] | undefined): void {
  if (order === sym.constraintOrder) return;
  if (order?.length) sym.constraintOrder = [...order]; else delete sym.constraintOrder;
}

/** The order a symbol's constraints are applied in replaced (ARCHITECTURE ▸
 *  Constraint order); an empty list is the default order. */
export class SetConstraintOrder implements Command {
  readonly touches: TouchSet;
  readonly kind = "symbol.constraintOrder";
  private before: string[] | undefined;
  private captured = false;

  constructor(readonly label: string, private readonly symbolId: ItemId, private readonly after: readonly string[]) {
    this.touches = { symbols: [symbolId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!this.captured) { this.before = sym.constraintOrder; this.captured = true; }
    setOrder(sym, this.after);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    setOrder(symbolOf(p, this.symbolId), this.before);
    invalidateBounds([this.symbolId]);
  }
}

/** An animation's physics, slider and path keys replaced as one value
 *  (`core/doc/constraintKeys.ts`). Steps of one drag or scrub share a `kind` and merge. */
export class SetConstraintKeys implements Command {
  readonly touches: TouchSet;
  private before: Animation["constraintKeys"];
  private captured = false;

  constructor(
    readonly label: string, private readonly symbolId: ItemId, private readonly animId: AnimId,
    private after: Animation["constraintKeys"], readonly kind = "timeline.constraintKeys",
  ) {
    this.touches = { symbols: [symbolId], timeline: true, stage: true };
  }

  private write(p: Project, keys: Animation["constraintKeys"]): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (keys && Object.keys(keys).length) anim.constraintKeys = keys; else delete anim.constraintKeys;
    invalidateBounds([this.symbolId]);
  }

  apply(p: Project): void {
    if (!this.captured) {
      this.before = animOf(symbolOf(p, this.symbolId), this.animId)?.constraintKeys;
      this.captured = true;
    }
    this.write(p, this.after);
  }

  revert(p: Project): void { this.write(p, this.before); }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetConstraintKeys) || next.kind !== this.kind || this.kind === "timeline.constraintKeys") return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId) return false;
    this.after = next.after;
    return true;
  }
}
