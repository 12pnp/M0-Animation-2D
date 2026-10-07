import { type Shortcut, type ShortcutGroup, SHORTCUTS } from "./shortcuts";

const GROUPS: readonly ShortcutGroup[] = ["File", "Edit", "View", "Tools", "Stage", "Timeline", "Playback", "Motion Path", "Help"];

/**
 * Help ▸ Keyboard Shortcuts (E7-PLAN step 2): the shortcuts table, by group, in a native
 * `<dialog>`. The field filters by keys or by what they do; Escape or Close shuts it.
 */
export class ShortcutsSheet {
  readonly element: HTMLDialogElement;
  private readonly filter: HTMLInputElement;
  private readonly list: HTMLDivElement;

  constructor() {
    this.element = document.createElement("dialog");
    this.element.className = "shortcuts";
    this.element.setAttribute("aria-label", "Keyboard Shortcuts");
    const title = document.createElement("h2");
    title.textContent = "Keyboard Shortcuts";
    this.filter = document.createElement("input");
    this.filter.type = "search";
    this.filter.placeholder = "Filter";
    this.filter.setAttribute("aria-label", "Filter shortcuts");
    this.filter.addEventListener("input", () => this.draw());
    this.list = document.createElement("div");
    this.list.className = "shortcut-list";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.element.close());
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(close);
    this.element.append(title, this.filter, this.list, actions);
    // A click on the backdrop closes it.
    this.element.addEventListener("click", (e) => { if (e.target === this.element) this.element.close(); });
  }

  open(): void {
    this.filter.value = "";
    this.draw();
    if (!this.element.open) this.element.showModal();
    this.filter.focus();
  }

  private draw(): void {
    const q = this.filter.value.trim().toLowerCase();
    const shown = (s: Shortcut) => !q || s.what.toLowerCase().includes(q) || s.keys.toLowerCase().includes(q) || s.group.toLowerCase().includes(q);
    const sections = GROUPS.flatMap((g) => {
      const rows = (SHORTCUTS as readonly Shortcut[]).filter((s) => s.group === g && shown(s));
      if (!rows.length) return [];
      const section = document.createElement("section");
      const h = document.createElement("h3");
      h.textContent = g;
      const dl = document.createElement("dl");
      for (const s of rows) {
        const dt = document.createElement("dt");
        const kbd = document.createElement("kbd");
        kbd.textContent = s.keys;
        dt.append(kbd);
        const dd = document.createElement("dd");
        dd.textContent = s.what;
        dl.append(dt, dd);
      }
      section.append(h, dl);
      return [section];
    });
    if (!sections.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No shortcut matches.";
      sections.push(p);
    }
    this.list.replaceChildren(...sections);
  }
}
