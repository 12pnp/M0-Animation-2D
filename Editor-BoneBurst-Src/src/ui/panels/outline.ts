import type { Session } from "../session";

/**
 * The skeleton's bones as a tree (each under its parent, in file order). A click selects; the
 * selection is the stage's too.
 */
export class Outline {
  readonly element: HTMLDivElement;
  private rendered: unknown = null;
  private readonly rows = new Map<string, HTMLButtonElement>();

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel outline";
    session.onChange(() => this.update());
    this.update();
  }

  private update(): void {
    const bones = this.session.doc?.bones ?? null;
    if (bones !== this.rendered) {
      this.rendered = bones;
      this.rows.clear();
      this.element.replaceChildren(heading("Bones"));
      const depth = new Map<string, number>();
      const list = document.createElement("div");
      list.className = "rows";
      list.setAttribute("role", "tree");
      for (const b of bones ?? []) {
        const level = b.parent !== undefined ? (depth.get(b.parent) ?? -1) + 1 : 0;
        depth.set(b.name, level);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "row";
        row.setAttribute("role", "treeitem");
        row.style.paddingLeft = `${8 + level * 12}px`;
        row.textContent = b.name;
        row.addEventListener("click", () => { this.session.selection = b.name; this.session.changed(); });
        this.rows.set(b.name, row);
        list.append(row);
      }
      if (!bones) list.append(empty("Open a skeleton to see its bones."));
      this.element.append(list);
    }
    for (const [name, row] of this.rows) {
      const on = name === this.session.selection;
      if (row.classList.contains("selected") !== on) {
        row.classList.toggle("selected", on);
        row.setAttribute("aria-selected", String(on));
        if (on) row.scrollIntoView({ block: "nearest" });
      }
    }
  }
}

export function heading(text: string): HTMLHeadingElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

export function empty(text: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = text;
  return p;
}
