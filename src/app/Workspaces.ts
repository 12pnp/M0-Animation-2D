import type { Shell } from "./Shell";
import {
  type NamedWorkspace, findWorkspace, parseWorkspaces, putWorkspace, removeWorkspace,
} from "@/view/widgets/workspaces";

const LIST_KEY = "animo.workspaces";
/** The workspace last saved or loaded, ticked in the menu. Dragging a panel
 *  afterwards does not untick it, as in Animate: it is still the one a save
 *  would replace by default. */
const CURRENT_KEY = "animo.workspace";

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode */ }
};

/** Named workspaces, stored per browser like the dock layouts themselves. */
export class Workspaces {
  constructor(private readonly shell: Shell) {}

  list(): NamedWorkspace[] { return parseWorkspaces(read(LIST_KEY)); }

  has(name: string): boolean { return !!findWorkspace(this.list(), name); }

  get current(): string | null {
    const name = read(CURRENT_KEY);
    return name && findWorkspace(this.list(), name)?.name || null;
  }

  clearCurrent(): void { write(CURRENT_KEY, null); }

  save(name: string): void {
    write(LIST_KEY, JSON.stringify(putWorkspace(this.list(), name, this.shell.workspace())));
    write(CURRENT_KEY, name.trim());
  }

  load(name: string): boolean {
    const e = findWorkspace(this.list(), name);
    if (!e) return false;
    this.shell.applyWorkspace(e.workspace);
    write(CURRENT_KEY, e.name);
    return true;
  }

  remove(name: string): void {
    const cur = this.current;
    write(LIST_KEY, JSON.stringify(removeWorkspace(this.list(), name)));
    if (cur && cur.toLowerCase() === name.trim().toLowerCase()) this.clearCurrent();
  }
}
