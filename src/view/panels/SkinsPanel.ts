import { clear, cls, h, on } from "@/view/widgets/dom";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import { SetStageSkins } from "@/core/history/commands";
import { skinsOf, stageSkinOf, toggledSkins } from "@/core/spine/spinePose";

/**
 * Skins: an opened rig's skins, to choose what the stage and the Preview
 * show — the default only, the editor's automatic pick, or any set of skins
 * combined, as a game combines them. The stage bar's skin picker does the
 * same, and both follow the Store.
 */
export class SkinsPanel implements Panel {
  readonly id = "skins";
  readonly title = "Skins";
  readonly icon = "skin" as const;
  readonly el: HTMLElement;

  private skinList: HTMLElement;

  constructor(private readonly store: Store) {
    this.skinList = h("div", { class: "skins-list" });
    this.el = h("div", { class: "anims" }, this.skinList);
    store.subscribe((t) => {
      if (t === "doc" || t === "ui" || t === "stage") this.render();
    });
    this.render();
  }

  private render(): void {
    clear(this.skinList);
    const sym = this.store.currentSymbol;
    const named = sym.spine ? skinsOf(sym).filter((n) => n !== "default") : [];
    if (named.length === 0) {
      this.skinList.appendChild(h("div", { class: "hint" },
        "This rig has no skins. They come with a rig opened from Spine (File ▸ Open Spine)."));
      return;
    }
    const shown = stageSkinOf(sym);
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
      const box = h("input", { type: "checkbox", class: "switch" }) as HTMLInputElement;
      box.checked = shown.includes(name);
      on(box, "change", () => set(toggledSkins(named, stageSkinOf(this.store.currentSymbol), name)));
      this.skinList.appendChild(h("label", { class: `switch-label skins-row${group ? " nested" : ""}` },
        box, slash < 0 ? name : name.slice(slash + 1)));
    }
  }
}
