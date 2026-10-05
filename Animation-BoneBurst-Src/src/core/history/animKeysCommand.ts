import type { Command, TouchSet } from "./Command";
import type { Animation, Project } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { animOf, symbolOf } from "./lookup";

/**
 * One key list of an animation replaced: IK, transform, draw order, deform,
 * sequence and inherit keys. A subclass says where its list lives (`read`,
 * `write`) and when two commands name the same list (`sameList`). Steps of one
 * drag share a `kind` and merge into one undo step; `discreteKind`, when set,
 * is the kind that never merges.
 */
export abstract class SetAnimKeys<V> implements Command {
  readonly touches: TouchSet;
  private before: V | undefined;
  private captured = false;
  protected readonly discreteKind: string | undefined = undefined;

  constructor(
    readonly label: string,
    protected readonly symbolId: ItemId,
    protected readonly animId: AnimId,
    private after: V,
    readonly kind: string,
    nodes?: readonly NodeId[],
  ) {
    this.touches = nodes
      ? { symbols: [symbolId], nodes: [...nodes], timeline: true, stage: true }
      : { symbols: [symbolId], timeline: true, stage: true };
  }

  protected abstract read(anim: Animation): V | undefined;
  protected abstract write(anim: Animation, value: V | undefined): void;
  protected abstract sameList(next: this): boolean;

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (!this.captured) { this.before = this.read(anim); this.captured = true; }
    this.write(anim, this.after);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.write(anim, this.before);
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetAnimKeys) || next.constructor !== this.constructor) return false;
    if (next.kind !== this.kind || this.kind === this.discreteKind) return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId || !this.sameList(next as this)) return false;
    this.after = (next as this).after;
    return true;
  }
}

/** `record` with `id`'s list replaced; an empty list drops the entry, and an
 *  empty record is undefined. */
export function withListAt<K extends string, L extends readonly unknown[]>(
  record: Readonly<Record<K, L>> | undefined, id: K, list: L | undefined,
): Record<K, L> | undefined {
  const out = { ...record } as Record<K, L>;
  if (list?.length) out[id] = list; else delete out[id];
  return Object.keys(out).length ? out : undefined;
}
