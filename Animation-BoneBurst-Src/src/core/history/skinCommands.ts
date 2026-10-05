import type { Command, TouchSet } from "./Command";
import type { Node, Project, SkinOutline, SymbolItem } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { skinStateOf, type SkinState } from "@/core/doc/skins";
import { symbolOf } from "./lookup";
import { EditNode } from "./attachmentCommands";

function write(sym: SymbolItem, state: SkinState): void {
  if (state.skins?.length) sym.skins = state.skins; else delete sym.skins;
  if (state.stageSkins) sym.stageSkins = state.stageSkins; else delete sym.stageSkins;
  if (sym.spine && state.carried) sym.spine = { ...sym.spine, skins: state.carried };
}

/**
 * A symbol's skins replaced (ARCHITECTURE ▸ Skins), with the stage's choice
 * and the file's carried skins they rename or drop: one value, from the
 * plans in `core/doc/skins.ts`.
 */
export class SetSkins implements Command {
  readonly kind = "symbol.skinDefs";
  readonly touches: TouchSet;
  private before: SkinState | null = null;

  constructor(readonly label: string, private readonly symbolId: ItemId, private readonly after: SkinState) {
    this.touches = { symbols: [symbolId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before ??= skinStateOf(sym);
    write(sym, this.after);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    if (!this.before) return;
    write(symbolOf(p, this.symbolId), this.before);
    invalidateBounds([this.symbolId]);
  }
}

function withSkinOnly(node: Node, index: number, on: boolean): Node {
  if (index === 0) {
    const out: Node = { ...node };
    if (on) out.skinOnly = true; else delete out.skinOnly;
    return out;
  }
  const extras = (node.extraDisplays ?? []).map((d, i) => {
    if (i !== index - 1) return d;
    const out = { ...d };
    if (on) out.skinOnly = true; else delete out.skinOnly;
    return out;
  });
  return { ...node, extraDisplays: extras };
}

/** A display left to skins (Spine's skin placeholder), or given back to the
 *  default skin. Each toggle is its own undo step. */
export class SetSkinOnly extends EditNode {
  constructor(label: string, symbolId: ItemId, nodeId: NodeId, index: number, on: boolean) {
    super(label, symbolId, nodeId, (node) => withSkinOnly(node, index, on), "node.skinOnly");
  }

  override mergeWith(): boolean { return false; }
}

/**
 * One skin's own box, point or path for a node replaced (`SkinDef.outlines`);
 * undefined removes it, the node's own showing again. Steps of one drag share
 * a `kind` and merge.
 */
export class SetSkinOutline implements Command {
  readonly touches: TouchSet;
  private before: SkinOutline | undefined;
  private captured = false;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly skin: string,
    private readonly nodeId: NodeId,
    private after: SkinOutline | undefined,
    readonly kind = "skin.outline",
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], stage: true };
  }

  private write(sym: SymbolItem, outline: SkinOutline | undefined): void {
    sym.skins = sym.skins?.map((def) => {
      if (def.name !== this.skin) return def;
      const outlines = { ...def.outlines };
      if (outline) outlines[this.nodeId] = outline; else delete outlines[this.nodeId];
      const out = { ...def };
      if (Object.keys(outlines).length) out.outlines = outlines; else delete out.outlines;
      return out;
    });
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!this.captured) {
      this.before = sym.skins?.find((d) => d.name === this.skin)?.outlines?.[this.nodeId];
      this.captured = true;
    }
    this.write(sym, this.after);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    this.write(symbolOf(p, this.symbolId), this.before);
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetSkinOutline) || next.kind !== this.kind) return false;
    if (next.symbolId !== this.symbolId || next.skin !== this.skin || next.nodeId !== this.nodeId) return false;
    this.after = next.after;
    return true;
  }
}
