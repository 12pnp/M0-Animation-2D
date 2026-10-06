import { EditRefused, type Edit } from "@/edit/history";
import type { Skeleton } from "@/model/skeleton";
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
 * The shared body of the Skins and Animations panels (a dedicated window each): a heading, the
 * buttons New, Duplicate, Rename and Delete, and a list whose rows choose what is shown. A
 * subclass says what the rows are and what the buttons do.
 */
export abstract class ListPanel {
  readonly element: HTMLDivElement;
  onStatus: (message: string) => void = () => {};
  private readonly list = document.createElement("ul");
  private readonly body = document.createElement("div");
  private readonly buttons: { dup: HTMLButtonElement; rename: HTMLButtonElement; del: HTMLButtonElement };
  /** The rows as last drawn, as text (null: not drawn yet), so a change tick that changed nothing redraws nothing. */
  private shown: string | null = null;
  private chosen: string | null = null;

  protected constructor(protected readonly session: Session, title: string, private readonly none: string, private readonly actions: ListActions) {
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
    this.buttons = {
      dup: make("Duplicate…", "Add a copy of the chosen row", () => { if (this.chosen !== null) this.actions.duplicate(this.chosen); }),
      rename: make("Rename…", "Rename the chosen row", () => { if (this.chosen !== null) this.actions.rename(this.chosen); }),
      del: make("Delete", "Delete the chosen row; undo brings it back", () => { if (this.chosen !== null) this.actions.remove(this.chosen); }),
    };
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
    const cur = rows?.find((r) => r.current && r.editable);
    this.chosen = cur?.label ?? null;
    for (const b of Object.values(this.buttons)) b.disabled = !cur;
    if (!rows) { this.body.replaceChildren(empty(this.none)); return; }
    this.list.replaceChildren(...rows.map((r) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "history-step";
      b.textContent = r.note ? `${r.label}  ·  ${r.note}` : r.label;
      if (r.current) b.setAttribute("aria-current", "step");
      b.addEventListener("click", () => r.choose());
      li.append(b);
      return li;
    }));
    this.body.replaceChildren(this.list);
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
