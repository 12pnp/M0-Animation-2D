import type { Session } from "../session";
import { ListPanel, type ListRow } from "./listPanel";
import { skinActions, type SkinActions } from "./skinActions";

/**
 * The Skins panel: a window of its own for the skins. The default skin and each skin by name, the
 * one shown on the stage marked; a click shows it and selects it for Properties.
 */
export class SkinsPanel extends ListPanel {
  private readonly skins: SkinActions;

  constructor(session: Session) {
    super(session, "Skins", "Open a skeleton to see its skins.", {
      add: () => this.skins.add(),
      duplicate: (n) => this.skins.duplicate(n),
      rename: (n) => this.skins.rename(n),
      remove: (n) => this.skins.remove(n),
    }, "bb.skins.nest");
    this.skins = skinActions(session, (label, edit) => this.apply(label, edit));
    this.update();
  }

  protected rows(): ListRow[] | null {
    const doc = this.session.doc;
    if (!doc) return null;
    const shown = this.session.skin ?? "default";
    const row = (name: string, note: string, editable: boolean): ListRow => ({ label: name, note, current: shown === name, editable, choose: () => this.skins.show(name) });
    return [row("default", "", false), ...(doc.skins ?? []).filter((k) => k.name !== "default").map((k) => row(k.name, k.bones?.length ? `${k.bones.length} bones` : "", true))];
  }
}
