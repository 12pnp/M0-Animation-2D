/** One entry of a menu: a command, a checkable choice, or (with no `run`) a divider. */
export interface MenuItem {
  readonly label?: string;
  /** The shortcut shown at the right; the shortcut itself is handled elsewhere. */
  readonly keys?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly run?: () => void;
}

export interface Menu {
  readonly label: string;
  /** The entries, asked for each time the menu opens, so checks and disabled states are current. */
  items(): readonly MenuItem[];
}

export const DIVIDER: MenuItem = {};

/**
 * The menu bar across the top of the window: File, Edit, View, Window, Help. Click a title to open
 * its menu; with one open, moving over another title switches to it; Escape or a click elsewhere
 * closes it. It holds no commands of its own: the app hands it menus.
 */
export class MenuBar {
  readonly element: HTMLElement;
  private open: { title: HTMLButtonElement; list: HTMLElement } | null = null;

  constructor(menus: readonly Menu[]) {
    this.element = document.createElement("nav");
    this.element.className = "menubar";
    this.element.setAttribute("aria-label", "Menu");
    for (const m of menus) {
      const title = document.createElement("button");
      title.className = "menu-title";
      title.textContent = m.label;
      title.addEventListener("click", () => (this.open?.title === title ? this.close() : this.show(m, title)));
      title.addEventListener("pointerenter", () => { if (this.open && this.open.title !== title) this.show(m, title); });
      this.element.append(title);
    }
    document.addEventListener("pointerdown", (e) => { if (this.open && !this.element.contains(e.target as Node)) this.close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this.open) { e.stopPropagation(); this.close(); } }, true);
    window.addEventListener("blur", () => this.close());
  }

  close(): void {
    this.open?.list.remove();
    this.open?.title.setAttribute("aria-expanded", "false");
    this.open = null;
  }

  private show(menu: Menu, title: HTMLButtonElement): void {
    this.close();
    const list = document.createElement("div");
    list.className = "menu-list";
    list.setAttribute("role", "menu");
    for (const item of menu.items()) {
      if (!item.run) {
        const hr = document.createElement("hr");
        list.append(hr);
        continue;
      }
      const row = document.createElement("button");
      row.className = "menu-item";
      row.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
      if (item.checked !== undefined) row.setAttribute("aria-checked", String(item.checked));
      row.disabled = !!item.disabled;
      const check = Object.assign(document.createElement("span"), { className: "menu-check", textContent: item.checked ? "✓" : "" });
      const label = Object.assign(document.createElement("span"), { className: "menu-label", textContent: item.label ?? "" });
      const keys = Object.assign(document.createElement("span"), { className: "menu-keys", textContent: item.keys ?? "" });
      row.append(check, label, keys);
      const run = item.run;
      row.addEventListener("click", () => { this.close(); run(); });
      list.append(row);
    }
    list.style.left = `${title.offsetLeft}px`;
    title.setAttribute("aria-expanded", "true");
    this.element.append(list);
    this.open = { title, list };
  }
}
