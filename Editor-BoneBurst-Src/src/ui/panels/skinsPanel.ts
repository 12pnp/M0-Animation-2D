import { addSkin, deleteSkin, duplicateSkin, renameSkin } from "@/edit/skins";
import type { Session } from "../session";
import { ListPanel, type ListRow } from "./listPanel";
import { unique } from "./outline";

/**
 * The Skins panel: a window of its own for the skins. The default skin and each skin by name, the
 * one shown on the stage marked; a click shows it and selects it for Properties.
 */
export class SkinsPanel extends ListPanel {
  constructor(session: Session) {
    super(session, "Skins", "Open a skeleton to see its skins.", {
      add: () => this.add(),
      duplicate: (n) => this.duplicate(n),
      rename: (n) => this.rename(n),
      remove: (n) => this.remove(n),
    }, "bb.skins.nest");
    this.update();
  }

  protected rows(): ListRow[] | null {
    const doc = this.session.doc;
    if (!doc) return null;
    const shown = this.session.skin ?? "default";
    const row = (name: string, note: string, editable: boolean): ListRow => ({ label: name, note, current: shown === name, editable, choose: () => this.show(name) });
    return [row("default", "", false), ...(doc.skins ?? []).filter((k) => k.name !== "default").map((k) => row(k.name, k.bones?.length ? `${k.bones.length} bones` : "", true))];
  }

  private names(): string[] { return (this.session.doc?.skins ?? []).map((k) => k.name); }

  private show(name: string): void {
    this.session.skin = name === "default" ? null : name;
    this.session.select({ kind: "skin", name });
  }

  private add(): void {
    const name = prompt("Name of the new skin:", unique("skin", this.names()))?.trim();
    if (name && this.apply(`Add skin ${name}`, addSkin(name))) this.show(name);
  }

  private duplicate(from: string): void {
    const name = prompt(`Name of the copy of "${from}":`, unique(`${from} copy`, this.names()))?.trim();
    if (name && this.apply(`Duplicate skin ${from} as ${name}`, duplicateSkin(from, name))) this.show(name);
  }

  private rename(from: string): void {
    const name = prompt(`Rename "${from}" to:`, from)?.trim();
    if (!name || name === from) return;
    if (this.apply(`Rename skin ${from} to ${name}`, renameSkin(from, name))) this.show(name);
  }

  private remove(name: string): void {
    if (!confirm(`Delete the skin "${name}"? Undo brings it back.`)) return;
    if (this.apply(`Delete skin ${name}`, deleteSkin(name))) {
      this.session.skin = null;
      this.session.select(null);
    }
  }
}
