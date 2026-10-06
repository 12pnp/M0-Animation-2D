import type { Camera } from "./stage/camera";
import { type DocumentState, Session } from "./session";

/** One open file: its tab. While it is not the one shown, its document waits in `state`. */
interface Tab {
  state: DocumentState | null;
  camera: Camera | null;
  name: string;
  dirty: boolean;
  button: HTMLElement;
  label: HTMLElement;
}

/** What the tabs need of the app around them. */
export interface TabHost {
  /** The stage's camera now, and put one back (its panels follow the session by themselves). */
  camera(): Camera;
  showCamera(c: Camera): void;
  /** Save the shown document (Save, as in the File menu). */
  save(): Promise<void>;
}

/**
 * The open files as tabs (the menu bar's right): one `Session` shows one document at a time, so a
 * tab not shown has its document set aside (`Session.capture`) and a click swaps it back in. A tab
 * appears when the session gains a document and its name and unsaved dot follow the session.
 * Middle click or Shift+click closes, as on the panel tabs; the × shows on hover.
 */
export class DocumentTabs {
  readonly element: HTMLElement;
  private readonly tabs: Tab[] = [];
  private current: Tab | null = null;

  constructor(private readonly session: Session, private readonly host: TabHost) {
    this.element = document.createElement("div");
    this.element.className = "doc-tabs";
    this.element.setAttribute("role", "tablist");
    session.onChange(() => this.sync());
  }

  /** Any file with unsaved changes, the shown one included. */
  get anyDirty(): boolean {
    return this.session.dirty || this.tabs.some((t) => t !== this.current && t.dirty);
  }

  /** Set the shown document aside, for another to open in its place; `unpark` undoes it. */
  park(): Tab | null {
    const t = this.current;
    if (!t || !this.session.doc) return null;
    t.state = this.session.capture();
    t.camera = this.host.camera();
    this.session.resume(Session.blank());
    this.current = null;
    return t;
  }

  /** The open failed: the parked document comes back. */
  unpark(t: Tab | null): void {
    if (!t) return;
    // An open that failed half way may have left a tab of its own: drop it.
    const half = this.current;
    if (half) {
      Session.release(this.session.capture());
      half.button.remove();
      this.tabs.splice(this.tabs.indexOf(half), 1);
      this.current = null;
    }
    this.show(t);
  }

  private show(t: Tab): void {
    const state = t.state;
    if (!state) return;
    t.state = null;
    this.current = t;
    this.session.resume(state);
    if (t.camera) this.host.showCamera(t.camera);
    this.render();
  }

  private activate(t: Tab): void {
    if (t === this.current) return;
    const from = this.current;
    if (from && this.session.doc) {
      from.state = this.session.capture();
      from.camera = this.host.camera();
      from.dirty = Session.dirtyOf(from.state);
    }
    this.show(t);
  }

  /** Ask what to do with unsaved changes: a dialog with Save, Don't Save and Cancel. */
  private ask(name: string): Promise<"save" | "discard" | "cancel"> {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "confirm-dialog";
      const text = document.createElement("p");
      text.textContent = `Do you want to save the changes to ${name} before closing?`;
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "Your changes will be lost if you don't save them.";
      const row = document.createElement("div");
      row.className = "row";
      const choice = (label: string, value: "save" | "discard" | "cancel", primary = false) => {
        const b = document.createElement("button");
        b.textContent = label;
        if (primary) b.setAttribute("aria-pressed", "true");
        b.addEventListener("click", () => { dialog.close(value); });
        return b;
      };
      const save = choice("Save", "save", true);
      row.append(choice("Don't Save", "discard"), choice("Cancel", "cancel"), save);
      dialog.append(text, note, row);
      // Escape, or a click away, is Cancel.
      dialog.addEventListener("close", () => { dialog.remove(); resolve((dialog.returnValue || "cancel") as "save" | "discard" | "cancel"); });
      document.body.append(dialog);
      dialog.showModal();
      save.focus();
    });
  }

  /** Close a tab; false when the person kept it (unsaved changes, cancelled or not saved). */
  async close(t: Tab): Promise<boolean> {
    const dirty = t === this.current ? this.session.dirty : t.dirty;
    if (dirty) {
      const answer = await this.ask(t.name);
      if (answer === "cancel") return false;
      if (answer === "save") {
        this.activate(t);
        await this.host.save();
        if (this.session.dirty) return false;
      }
    }
    const i = this.tabs.indexOf(t);
    const next = this.tabs[i + 1] ?? this.tabs[i - 1] ?? null;
    if (t === this.current) {
      const state = this.session.capture();
      this.session.resume(Session.blank());
      Session.release(state);
      this.current = null;
    } else if (t.state) {
      Session.release(t.state);
    }
    t.button.remove();
    this.tabs.splice(i, 1);
    if (this.current === null && next) this.show(next);
    else this.render();
    return true;
  }

  closeCurrent(): void {
    if (this.current) void this.close(this.current);
  }

  /** The session gained or changed a document: make its tab, keep its name and dot current. */
  private sync(): void {
    if (this.session.doc && !this.current) {
      const t = this.makeTab();
      this.tabs.push(t);
      this.current = t;
      this.element.append(t.button);
    }
    const t = this.current;
    if (t && this.session.doc) {
      t.name = `${this.session.name}.json`;
      t.dirty = this.session.dirty;
    }
    this.render();
  }

  private makeTab(): Tab {
    const button = document.createElement("div");
    button.className = "doc-tab";
    button.setAttribute("role", "tab");
    button.tabIndex = 0;
    const label = document.createElement("span");
    label.className = "doc-name";
    const x = document.createElement("button");
    x.className = "doc-close";
    x.textContent = "×";
    x.title = "Close this file";
    x.setAttribute("aria-label", "Close this file");
    button.append(label, x);
    const t: Tab = { state: null, camera: null, name: "", dirty: false, button, label };
    button.addEventListener("click", (e) => {
      if (e.shiftKey || e.target === x) { e.preventDefault(); void this.close(t); } else this.activate(t);
    });
    button.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    button.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); void this.close(t); } });
    button.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.activate(t); } });
    return t;
  }

  private render(): void {
    for (const t of this.tabs) {
      const text = `${t.dirty ? "• " : ""}${t.name}`;
      if (t.label.textContent !== text) t.label.textContent = text;
      t.button.title = t.name;
      t.button.setAttribute("aria-selected", String(t === this.current));
    }
  }
}
