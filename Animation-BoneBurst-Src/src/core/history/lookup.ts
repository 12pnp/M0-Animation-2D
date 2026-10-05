import type { AnimId, ItemId } from "@/core/doc/ids";
import { type Animation, isSymbol, type Project, type SymbolItem } from "@/core/doc/types";

/** The symbol a command names; a command never names anything else. */
export function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

export function animOf(sym: SymbolItem, id: AnimId): Animation | undefined {
  return sym.animations.find((a) => a.id === id);
}
