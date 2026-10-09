import { EditRefused, type Edit } from "@/edit/history";
import type { Skeleton } from "@/model/skeleton";
import { iconButton, type IconName } from "../icons";
import type { Session } from "../session";
import { empty, heading } from "./outline";

/** One row of a list panel. */
export interface ListRow {
  readonly label: string;
  readonly note?: string;
  readonly current: boolean;
  /** The row can be renamed, duplicated and deleted (not the default skin, not the setup pose). */
  readonly editable: boolean;
  choose(): void;
}

export interface ListActions {
  add(): void;
  duplicate(name: string): void;
  rename(name: string): void;
  remove(name: string): void;
}

/**
 * The shared body of the Skins and Animations panels (a dedicated window each): a heading, New,
 * and a list whose rows choose what is shown; an editable row shows Duplicate, Rename and Delete
 * as icons while hovered or focused (ROW-ACTIONS-PLAN). A subclass says what the rows are and what
 * the actions do.
 */
export abstract class ListPanel {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  private readonly list = document.createElement("ul");
  private readonly body = document.createElement("div");
  /** The rows as last drawn, as text (null: not drawn yet), so a change tick that changed nothing redraws nothing. */
  private shown: string | null = null;
  /** The rows last drawn, kept so toggling Nest or a folder redraws without asking the subclass. */
  private drawn: ListRow[] | null = null;
  private nest: boolean;
  private readonly folded = new Set<string>();

  /** `nestKey`: when set, a "/" in a row's label makes folders, and the Nest toggle (kept under that key) turns that off. */
  protected constructor(protected readonly session: Session, title: string, private readonly none: string, private readonly actions: ListActions, nestKey?: string) {
    this.nest = nestKey ? readNest(nestKey) : false;
    this.element = document.createElement("div");
    this.element.className = "panel outline list-panel";
    this.list.className = "history-list";
    const bar = document.createElement("div");
    bar.className = "list-bar";
    const make = (text: string, hint: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.title = hint;
      b.addEventListener("click", run);
      bar.append(b);
      return b;
    };
    make("New…", `Add ${title === "Skins" ? "a skin" : "an animation"}`, () => this.actions.add());
    if (nestKey) {
      const label = document.createElement("label");
      label.title = 'Group rows into folders by the "/" in their names';
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this.nest;
      box.addEventListener("change", () => {
        this.nest = box.checked;
        try { localStorage.setItem(nestKey, this.nest ? "1" : "0"); } catch { /* storage blocked: kept for this session only */ }
        this.draw();
      });
      label.append(box, " Nest by /");
      bar.append(label);
    }
    this.body.append(this.list);
    this.element.append(heading(title), bar, this.body);
    session.onChange(() => this.update());
  }

  /** The rows now: empty when nothing is open. */
  protected abstract rows(): ListRow[] | null;

  protected update(): void {
    const rows = this.rows();
    const key = rows ? rows.map((r) => `${r.label}|${r.note ?? ""}|${r.current}|${r.editable}`).join("\n") : "";
    if (key === this.shown) return;
    this.shown = key;
    if (!rows) { this.body.replaceChildren(empty(this.none)); return; }
    this.drawn = rows;
    this.draw();
  }

  private draw(): void {
    const rows = this.drawn;
    if (!rows) return;
    const item = (r: ListRow, text: string, depth: number): HTMLLIElement => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "history-step";
      b.style.paddingLeft = `${12 + depth * 14}px`;
      b.textContent = r.note ? `${text}  ·  ${r.note}` : text;
      b.title = r.label;
      if (r.current) b.setAttribute("aria-current", "step");
      b.addEventListener("click", () => r.choose());
      li.append(b);
      if (r.editable) li.append(rowActions(r.label, this.actions));
      return li;
    };
    const items: HTMLLIElement[] = [];
    if (!this.nest) {
      for (const r of rows) items.push(item(r, r.label, 0));
    } else {
      // A folder shows once, where its first row sits; its rows follow, hidden while it is folded.
      const seen = new Set<string>();
      for (const r of rows) {
        const parts = r.label.split("/");
        let hidden = false;
        for (let d = 0; d < parts.length - 1; d++) {
          const path = parts.slice(0, d + 1).join("/");
          if (!seen.has(path)) {
            seen.add(path);
            if (!hidden) items.push(this.folder(path, parts[d] ?? path, d));
          }
          if (this.folded.has(path)) hidden = true;
        }
        if (!hidden) items.push(item(r, parts[parts.length - 1] ?? r.label, parts.length - 1));
      }
    }
    this.list.replaceChildren(...items);
    this.body.replaceChildren(this.list);
  }

  private folder(path: string, name: string, depth: number): HTMLLIElement {
    const li = document.createElement("li");
    const b = document.createElement("button");
    const open = !this.folded.has(path);
    b.type = "button";
    b.className = "history-step folder";
    b.style.paddingLeft = `${12 + depth * 14}px`;
    b.textContent = `${open ? "▾" : "▸"} ${name}`;
    b.title = `${open ? "Fold" : "Unfold"} ${path}`;
    b.addEventListener("click", () => {
      if (open) this.folded.add(path); else this.folded.delete(path);
      this.draw();
    });
    li.append(b);
    return li;
  }

  /** Run an edit as one undo step; false (and said) when the edit refuses. */
  protected apply(label: string, edit: Edit<Skeleton>): boolean {
    const h = this.session.history;
    if (!h) return false;
    try {
      const changed = h.apply(label, edit);
      this.session.changed();
      return changed;
    } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      this.onStatus(err.message);
      return false;
    }
  }
}

/**
 * Duplicate, Rename and Delete for one row, as icons, whether or not it is the chosen one: the
 * Skins and Animations panels' rows and the Rig panel's skin rows (ROW-ACTIONS-PLAN).
 */
export function rowActions(name: string, actions: Pick<ListActions, "duplicate" | "rename" | "remove">): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "row-actions";
  const act = (icon: IconName, hint: string, run: (n: string) => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.title = hint;
    b.addEventListener("click", (e) => { e.stopPropagation(); run(name); });
    span.append(iconButton(b, icon, false));
  };
  act("duplicate", `Duplicate ${name}…`, (n) => actions.duplicate(n));
  act("rename", `Rename ${name}…`, (n) => actions.rename(n));
  act("delete", `Delete ${name} (Undo brings it back)`, (n) => actions.remove(n));
  return span;
}

function readNest(key: string): boolean {
  try { return localStorage.getItem(key) !== "0"; } catch { return true; }
}
