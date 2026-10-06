import type { Session } from "../session";
import { empty, heading } from "./outline";

/**
 * The History panel (E7-PLAN step 1): the undo steps by label, oldest first, under the document
 * as it was opened. The current step is marked; the steps a redo would bring back follow it,
 * greyed. A click goes to that step, through every step between (the session's `goToStep`).
 */
export class HistoryPanel {
  readonly element: HTMLDivElement;
  private shown = "";

  constructor(private readonly session: Session) {
    this.element = document.createElement("div");
    this.element.className = "panel outline history";
    session.onChange(() => this.update());
    this.update();
  }

  private update(): void {
    const h = this.session.history;
    const entries = h?.entries;
    // Rebuilt only when the steps or the position changed, not on every playback tick.
    const key = h && entries ? `${this.session.name}|${entries.dropped}|${entries.done}|${entries.labels.join("\u0000")}` : "";
    if (key === this.shown) return;
    this.shown = key;
    if (!h || !entries) {
      this.element.replaceChildren(heading("History"), empty("Open a skeleton: each change shows here, and a click goes back to it."));
      return;
    }
    const list = document.createElement("ol");
    list.className = "history-list";
    const row = (label: string, done: number, cls: string) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = `history-step ${cls}`;
      b.textContent = label;
      b.title = done === entries.done ? "The document as it is now" : `Go to this step (${done < entries.done ? "undo" : "redo"} ${Math.abs(done - entries.done)})`;
      if (done === entries.done) b.setAttribute("aria-current", "step");
      b.addEventListener("click", () => this.session.goToStep(done));
      li.append(b);
      list.append(li);
    };
    row(entries.dropped ? `${entries.dropped} older step${entries.dropped === 1 ? "" : "s"} let go (the undo limit)` : `Opened ${this.session.name}.json`, 0, "start");
    entries.labels.forEach((label, i) => row(label, i + 1, i < entries.done ? "done" : "undone"));
    this.element.replaceChildren(heading("History"), list);
    list.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  }
}
