import type { Command, TouchSet } from "./Command";
import type { Node, Project, SymbolItem } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { skinStateOf, type SkinState } from "@/core/doc/skins";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

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
 *  default skin. */
export class SetSkinOnly implements Command {
  readonly kind = "node.skinOnly";
  readonly touches: TouchSet;
  private before: Node | null = null;

  constructor(
    readonly label: string, private readonly symbolId: ItemId, private readonly nodeId: NodeId,
    private readonly index: number, private readonly on: boolean,
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const node = sym.nodes[this.nodeId];
    if (!node) return;
    this.before ??= node;
    sym.nodes[this.nodeId] = withSkinOnly(node, this.index, this.on);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!this.before || !sym.nodes[this.nodeId]) return;
    sym.nodes[this.nodeId] = this.before;
    invalidateBounds([this.symbolId]);
  }
}
