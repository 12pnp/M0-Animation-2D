import type { Edit } from "@/edit/history";
import { addSkin, deleteSkin, duplicateSkin, renameSkin } from "@/edit/skins";
import type { Skeleton } from "@/model/skeleton";
import { uniqueName } from "../names";
import type { Session } from "../session";
import type { ListActions } from "./listPanel";

/** What a skin list does: the Skins panel's and the Rig panel's Skins view's, one copy (ROW-ACTIONS-PLAN step 7). */
export interface SkinActions extends ListActions {
  /** Show a skin on the stage and select it for Properties (the default skin: no other skin shown). */
  show(name: string): void;
}

/** `apply` runs an edit as one undo step and says whether it changed the document. */
export function skinActions(session: Session, apply: (label: string, edit: Edit<Skeleton>) => boolean): SkinActions {
  const names = () => (session.doc?.skins ?? []).map((k) => k.name);
  const show = (name: string) => {
    session.skin = name === "default" ? null : name;
    session.select({ kind: "skin", name });
  };
  return {
    show,
    add() {
      if (!session.doc) return;
      const name = prompt("Name of the new skin:", uniqueName("skin", names()))?.trim();
      if (name && apply(`Add skin ${name}`, addSkin(name))) show(name);
    },
    duplicate(from) {
      const name = prompt(`Name of the copy of "${from}":`, uniqueName(`${from} copy`, names()))?.trim();
      if (name && apply(`Duplicate skin ${from} as ${name}`, duplicateSkin(from, name))) show(name);
    },
    rename(from) {
      const name = prompt(`Rename "${from}" to:`, from)?.trim();
      if (!name || name === from) return;
      if (apply(`Rename skin ${from} to ${name}`, renameSkin(from, name))) show(name);
    },
    remove(name) {
      if (!confirm(`Delete the skin "${name}"? Undo brings it back.`)) return;
      if (apply(`Delete skin ${name}`, deleteSkin(name))) {
        session.skin = null;
        session.select(null);
      }
    },
  };
}
