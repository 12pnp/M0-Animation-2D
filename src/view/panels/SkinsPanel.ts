import { clear, cls, h, on } from "@/view/widgets/dom";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import { icon, type IconName } from "@/view/icons";
import { SetStageSkins } from "@/core/history/commands";
import { DEFAULT_SKIN, editedSkin, skinsOf, stageSkinOf, toggledSkins } from "@/core/doc/skins";
import { doDeleteSkin, doNewSkin, doRenameSkin } from "@/app/SkinOps";

/**
 * Skins (ARCHITECTURE ▸ Skins): make, rename and delete them, and choose
 * what the stage and the Preview show — the default only, the editor's
 * automatic pick, or any set of skins combined, as a game combines them.
 * A row's switch shows it; a click picks the skin the Properties panel
 * edits. The stage bar's skin picker shows the same choice.
 */
export class SkinsPanel implements Panel {
  readonly id = "skins";
  readonly title = "Skins";
  readonly icon = "skin" as const;
  readonly el: HTMLElement;

  private skinList: HTMLElement;

  constructor(private readonly store: Store) {
    const tool = (name: IconName, title: string, run: () => void) => {
      const b = h("button", { class: "iconbtn", title });
      b.appendChild(icon(name, 13));
      on(b, "click", run);
      return b;
    };
    const edited = () => editedSkin(this.store.currentSymbol, this.store.ui.editSkin);
    this.skinList = h("div", { class: "skins-list" });
    this.el = h("div", { class: "anims" },
      h("div", { class: "anims-head" },
        h("span", { class: "anims-title" }, "Skins"),
        h("div", { class: "spacer" }),
        tool("newLayer", "New skin", () => void doNewSkin(this.store)),
        tool("tag", "Rename the skin being edited (or double-click it)", () => { const n = edited(); if (n) void doRenameSkin(this.store, n); }),
        tool("trash", "Delete the skin being edited", () => { const n = edited(); if (n) void doDeleteSkin(this.store, n); })),
      this.skinList);
    store.subscribe((t) => {
      if (t === "doc" || t === "ui" || t === "stage") this.render();
    });
    this.render();
  }

  private render(): void {
    clear(this.skinList);
    const sym = this.store.currentSymbol;
    const named = skinsOf(sym).filter((n) => n !== DEFAULT_SKIN);
    if (named.length === 0) {
      this.skinList.appendChild(h("div", { class: "hint" },
        "No skins yet. Press + to make one, then give its images in the Properties panel: a skin shows its own image in a layer's place."));
      return;
    }
    const shown = stageSkinOf(sym);
    const edited = editedSkin(sym, this.store.ui.editSkin);
    const set = (skins: string[] | null) => this.store.apply(new SetStageSkins(sym.id, skins));

    const choice = (label: string, on_: boolean, title: string, run: () => void) => {
      const b = h("button", { class: "skins-choice", title }, label);
      cls(b, "on", on_);
      on(b, "click", run);
      return b;
    };
    this.skinList.appendChild(h("div", { class: "skins-choices" },
      // Lit only when chosen: Automatic can also land on no skin, and the
      // two must not read as both picked.
      choice("Default only", !!sym.stageSkins && shown.length === 0, "Show only the attachments every skin shares", () => set([])),
      choice("Automatic", !sym.stageSkins, "Let the editor pick: the first skin when the default one draws nothing", () => set(null))));

    // Skins named "folder/name" are grouped under their folder.
    let folder: string | null = null;
    for (const name of named) {
      const slash = name.indexOf("/");
      const group = slash < 0 ? null : name.slice(0, slash);
      if (group !== folder) {
        folder = group;
        if (group) this.skinList.appendChild(h("div", { class: "skins-folder" }, group));
      }
      const box = h("input", { type: "checkbox", class: "switch", title: "Show it on the stage and in the Preview" }) as HTMLInputElement;
      box.checked = shown.includes(name);
      on(box, "change", () => set(toggledSkins(named, stageSkinOf(this.store.currentSymbol), name)));
      const label = h("span", { class: "skins-name" }, slash < 0 ? name : name.slice(slash + 1));
      const row = h("div", { class: `skins-row${group ? " nested" : ""}`, title: "Click to edit this skin in the Properties panel; double-click to rename it" }, box, label);
      cls(row, "on", name === edited);
      // pointerup on the row, not the switch: the row stays the same element
      // between the two clicks of a double-click (the DOM trap).
      on(row, "pointerup", (e) => {
        if (e.target === box || name === this.store.ui.editSkin) return;
        this.store.setUi({ editSkin: name }, "stage");
      });
      on(label, "dblclick", () => void doRenameSkin(this.store, name));
      this.skinList.appendChild(row);
    }
  }
}
