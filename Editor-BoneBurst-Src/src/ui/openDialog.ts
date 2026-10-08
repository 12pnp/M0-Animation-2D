import { type Recent, folders, type FolderHandle, type ProjectFolder, projectsIn, readRecent, recent, type RecentHandle } from "./recent";
import type { ProjectFile } from "./session";
import { toStyle } from "./pageScale";

/**
 * The Open dialog: a helper before the browser's own file picker. Files lists the recent projects,
 * or the projects of the folder picked on the right; Folders keeps the folders the person added
 * (starred ones first); Browse goes on to the browser's picker. Chrome and Edge only keep handles,
 * so elsewhere Recent is empty, a folder added with + is held until the page closes, and Browse is the way in.
 */

export interface OpenHost {
  /** The browser's own picker (or the file input). */
  browse(): void;
  /** Samples listed first, whatever the browser kept. */
  readonly samples?: readonly { name: string; open(): Promise<void> }[];
  /** Open a project file, remembering its handle when it has one. */
  openFile(file: File, handle: ProjectFile | null): Promise<void>;
}

type Row = { name: string; open(): Promise<void> };

/** A folder picked where the browser cannot keep one: its files, until the page closes. */
interface LooseFolder { readonly name: string; readonly files: readonly File[] }

export class OpenDialog {
  private readonly dialog = document.createElement("dialog");
  private readonly files = document.createElement("div");
  private readonly folderList = document.createElement("div");
  private readonly filter = document.createElement("input");
  private readonly note = document.createElement("p");
  private shown: ProjectFolder | LooseFolder | null = null;
  private readonly loose: LooseFolder[] = [];
  private rows: Row[] = [];

  constructor(private readonly host: OpenHost) {
    const d = this.dialog;
    d.className = "open-project";
    d.setAttribute("aria-label", "Open Project");
    const title = document.createElement("div");
    title.className = "op-title";
    title.append(Object.assign(document.createElement("span"), { textContent: "Open Project" }));

    const filesCol = this.column("Files:");
    this.files.className = "op-list";
    filesCol.append(this.files);

    const foldersCol = this.column("Folders:");
    const add = document.createElement("button");
    add.className = "op-add";
    add.textContent = "+";
    add.title = "Add a folder to look for projects in";
    add.addEventListener("click", () => void this.addFolder());
    foldersCol.firstElementChild!.append(add);
    this.folderList.className = "op-list";
    foldersCol.append(this.folderList);

    const columns = document.createElement("div");
    columns.className = "op-columns";
    columns.append(filesCol, foldersCol);

    this.note.className = "op-note";
    const label = document.createElement("label");
    label.className = "op-filter";
    this.filter.type = "text";
    this.filter.setAttribute("aria-label", "Filter");
    this.filter.addEventListener("input", () => this.drawFiles());
    this.filter.addEventListener("keydown", (e) => { if (e.key === "Enter" && this.visible().length === 1) void this.pick(this.visible()[0]!); });
    label.append("Filter:", this.filter);

    const buttons = document.createElement("div");
    buttons.className = "op-buttons";
    const browse = document.createElement("button");
    browse.textContent = "Browse";
    browse.addEventListener("click", () => { d.close(); this.host.browse(); });
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => d.close());
    buttons.append(browse, cancel);

    this.dragBy(title);
    d.append(title, columns, this.note, label, buttons);
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    document.body.append(d);
  }

  /** Show the dialog on the recent projects. */
  open(): void {
    this.shown = null;
    this.filter.value = "";
    this.drawFolders();
    this.showRecent();
    if (!this.dialog.open) this.dialog.showModal();
    this.filter.focus();
  }

  /** Drag the dialog by `handle`: it leaves the centre on the first move and stays where it was put. */
  private dragBy(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const box = this.dialog.getBoundingClientRect();
      const dx = e.clientX - box.left, dy = e.clientY - box.top;
      handle.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        this.dialog.style.margin = "0";
        this.dialog.style.left = `${toStyle(Math.min(Math.max(0, m.clientX - dx), window.innerWidth - 80))}px`;
        this.dialog.style.top = `${toStyle(Math.min(Math.max(0, m.clientY - dy), window.innerHeight - 40))}px`;
      };
      const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  private column(heading: string): HTMLElement {
    const col = document.createElement("div");
    col.className = "op-col";
    const head = document.createElement("h3");
    head.textContent = heading;
    col.append(head);
    return col;
  }

  private showRecent(): void {
    this.shown = null;
    this.rows = [...(this.host.samples ?? []), ...recent.list.map((r: Recent) => ({ name: r.name.replace(/\.bbdata$/i, ""), open: () => this.openRecent(r) }))];
    this.note.textContent = recent.list.length ? "" : "No recent projects yet. Projects you open or save in Chrome or Edge appear here; Browse finds one anywhere.";
    this.drawFiles();
    this.drawFolders();
  }

  private async showFolder(f: ProjectFolder): Promise<void> {
    this.shown = f;
    this.drawFolders();
    try {
      const found = await projectsIn(f.handle);
      // The folder may have been changed while it was read.
      if (this.shown !== f) return;
      this.rows = found.map((e) => ({ name: e.name.replace(/\.bbdata$/i, ""), open: async () => { await this.host.openFile(await e.getFile(), null); } }));
      this.note.textContent = found.length ? "" : `No .bbdata projects in ${f.name}.`;
    } catch (err) {
      this.rows = [];
      this.note.textContent = err instanceof Error ? err.message : String(err);
    }
    this.drawFiles();
  }

  private showLoose(f: LooseFolder): void {
    this.shown = f;
    const found = f.files.filter((x) => /\.bbdata$/i.test(x.name)).sort((a, b) => a.name.localeCompare(b.name));
    this.rows = found.map((file) => ({ name: file.name.replace(/\.bbdata$/i, ""), open: async () => { await this.host.openFile(file, null); } }));
    this.note.textContent = found.length ? "This browser cannot keep folders: this one stays until the page closes, and Save asks where to put the file." : `No .bbdata projects in ${f.name}.`;
    this.drawFiles();
    this.drawFolders();
  }

  private async openRecent(r: Recent): Promise<void> {
    await this.host.openFile(await readRecent(r), r.handle);
  }

  private visible(): Row[] {
    const q = this.filter.value.trim().toLowerCase();
    return q ? this.rows.filter((r) => r.name.toLowerCase().includes(q)) : this.rows;
  }

  private async pick(row: Row): Promise<void> {
    try {
      await row.open();
      this.dialog.close();
    } catch (err) {
      this.note.textContent = err instanceof DOMException && err.name === "NotFoundError" ? `${row.name} is no longer where it was.` : err instanceof Error ? err.message : String(err);
    }
  }

  private drawFiles(): void {
    this.files.replaceChildren(...this.visible().map((r) => {
      const b = document.createElement("button");
      b.className = "op-row";
      b.textContent = r.name;
      b.addEventListener("click", () => void this.pick(r));
      return b;
    }));
  }

  private drawFolders(): void {
    const rows: HTMLElement[] = [];
    const row = (label: string, selected: boolean, onClick: () => void): HTMLElement => {
      const line = document.createElement("div");
      line.className = "op-row";
      if (selected) line.setAttribute("aria-current", "true");
      const name = document.createElement("button");
      name.textContent = label;
      name.addEventListener("click", onClick);
      line.append(name);
      return line;
    };
    rows.push(row("Recent", this.shown === null, () => this.showRecent()));
    for (const f of folders.list) {
      const line = row(f.name, this.shown === f, () => void this.showFolder(f));
      const star = document.createElement("button");
      star.className = "op-star";
      star.textContent = f.star ? "★" : "☆";
      star.title = f.star ? "Unstar" : "Star: keep at the top";
      star.setAttribute("aria-pressed", String(f.star));
      star.addEventListener("click", () => void folders.toggleStar(f).then(() => { this.shown = null; this.showRecent(); }));
      const del = document.createElement("button");
      del.className = "op-star";
      del.textContent = "×";
      del.title = "Remove from the list";
      del.addEventListener("click", () => void folders.remove(f).then(() => { this.shown = null; this.showRecent(); }));
      line.append(star, del);
      rows.push(line);
    }
    for (const f of this.loose) rows.push(row(f.name, this.shown === f, () => this.showLoose(f)));
    this.folderList.replaceChildren(...rows);
  }

  private async addFolder(): Promise<void> {
    const pick = (window as unknown as { showDirectoryPicker?: (o: { id: string }) => Promise<FolderHandle> }).showDirectoryPicker;
    if (pick) {
      try {
        await folders.add(await pick.call(window, { id: "boneburst-projects" }));
        this.shown = null;
        this.showRecent();
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Refused or unsupported here: the plain folder input below.
      }
    }
    this.chooseLoose();
  }

  /** Where the browser has no folder picker that keeps access: a folder input, its files held for this page. */
  private chooseLoose(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      const name = files[0]!.webkitRelativePath.split("/")[0] || "Folder";
      const folder: LooseFolder = { name, files };
      const at = this.loose.findIndex((f) => f.name === name);
      if (at >= 0) this.loose[at] = folder; else this.loose.push(folder);
      this.showLoose(folder);
    });
    input.click();
  }
}

export type { RecentHandle };
