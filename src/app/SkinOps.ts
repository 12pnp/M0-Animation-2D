import type { Store } from "./Store";
import type { CnId, IkId, ItemId, NodeId, TcId } from "@/core/doc/ids";
import {
  skinDisplayFor, skinNameProblem, uniqueSkinName, withNewSkin, withoutSkin, withRenamedSkin, withSkinDisplay,
  withSkinMembers, type SkinState,
} from "@/core/doc/skins";
import { SetSkinOnly, SetSkins } from "@/core/history/skinCommands";
import { confirmDialog, promptText } from "@/view/widgets/dialogs";

/**
 * Skin edits (ARCHITECTURE ▸ Skins), each one undo step: the plans in
 * `core/doc/skins.ts` applied as `SetSkins`. A plan's refusal comes back as
 * the message.
 */

export function applySkins(store: Store, label: string, plan: SkinState | string): string | null {
  if (typeof plan === "string") return plan;
  store.apply(new SetSkins(label, store.currentSymbolId, plan));
  store.emit("stage");
  return null;
}

/** Asks for a name; the new skin is shown alone. */
export async function doNewSkin(store: Store): Promise<void> {
  const symbolId = store.currentSymbolId;
  const name = await promptText({
    title: "New Skin", label: "Name", value: uniqueSkinName(store.currentSymbol), ok: "Make Skin",
    validate: (text) => skinNameProblem(store.currentSymbol, text),
  });
  // Re-check after the await: the document can change under a dialog.
  if (!name || store.currentSymbolId !== symbolId) return;
  applySkins(store, "New Skin", withNewSkin(store.currentSymbol, name));
}

export async function doRenameSkin(store: Store, from: string): Promise<void> {
  const symbolId = store.currentSymbolId;
  const name = await promptText({
    title: "Rename Skin", label: "Name", value: from, ok: "Rename",
    validate: (text) => skinNameProblem(store.currentSymbol, text, from),
  });
  if (!name || name === from || store.currentSymbolId !== symbolId) return;
  applySkins(store, "Rename Skin", withRenamedSkin(store.currentSymbol, from, name));
}

export async function doDeleteSkin(store: Store, name: string): Promise<void> {
  const symbolId = store.currentSymbolId;
  const ok = await confirmDialog({
    title: "Delete Skin",
    message: `Delete the skin “${name}”? Its images go back to the default ones and its bones and constraints to every skin. You can undo it.`,
    ok: "Delete", danger: true,
  });
  if (!ok || store.currentSymbolId !== symbolId) return;
  applySkins(store, "Delete Skin", withoutSkin(store.currentSymbol, name));
}

/** Skin `skin` showing image `itemId` at the node's display `index`; null:
 *  its own display again. */
export function doSetSkinImage(store: Store, skin: string, nodeId: NodeId, index: number, itemId: ItemId | null, label = "Skin Image"): string | null {
  const sym = store.currentSymbol;
  const node = sym.nodes[nodeId];
  if (!node) return "That layer is gone.";
  const ref = itemId ? skinDisplayFor(store.project, node, index, itemId) : null;
  if (itemId && !ref) return "A skin shows an image from the library.";
  return applySkins(store, label, withSkinDisplay(sym, skin, nodeId, index, ref));
}

/** The node's display `index` left to skins (Spine's skin placeholder), or
 *  given back to the default skin. */
export function doSetSkinOnly(store: Store, nodeId: NodeId, index: number, on: boolean): void {
  store.apply(new SetSkinOnly(on ? "Only in Skins" : "In the Default Skin", store.currentSymbolId, nodeId, index, on));
  store.emit("stage");
}

export function doSetSkinMembers(
  store: Store, skin: string, members: { bones?: NodeId[]; ik?: IkId[]; transforms?: TcId[]; constraints?: CnId[] }, on: boolean, label = on ? "Add to Skin" : "Take Out of Skin",
): string | null {
  return applySkins(store, label, withSkinMembers(store.currentSymbol, skin, members, on));
}
