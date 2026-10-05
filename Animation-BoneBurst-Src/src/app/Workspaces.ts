import type { Shell } from "./Shell";
import {
  type NamedWorkspace, type Workspace, findWorkspace, parseSlots, parseWorkspaces, putSlot,
  putWorkspace, removeWorkspace, slotWorkspace,
} from "@/view/widgets/workspaces";

const LIST_KEY = "animo.workspaces";
/** The workspace last saved or loaded, ticked in the menu. Dragging a panel
 *  afterwards does not untick it, as in Animate: it is still the one a save
 *  would replace by default. */
const CURRENT_KEY = "animo.workspace";
/** The right rail's quick layout buttons, and the one last applied or saved. */
const SLOTS_KEY = "animo.workspaceSlots";
const SLOT_KEY = "animo.workspaceSlot";

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
  /** Called when the lit quick slot changes. */
  onSlotChange?: () => void;

  constructor(private readonly shell: Shell) {}

  list(): NamedWorkspace[] { return parseWorkspaces(read(LIST_KEY)); }

  has(name: string): boolean { return !!findWorkspace(this.list(), name); }

  get current(): string | null {
    const name = read(CURRENT_KEY);
    return name && findWorkspace(this.list(), name)?.name || null;
  }

  clearCurrent(): void { write(CURRENT_KEY, null); }

  /** A layout applied by other means than a quick slot: none is lit. */
  appliedOther(): void {
    this.clearCurrent();
    this.setActiveSlot(null);
  }

  save(name: string): void {
    write(LIST_KEY, JSON.stringify(putWorkspace(this.list(), name, this.shell.workspace())));
    write(CURRENT_KEY, name.trim());
    this.setActiveSlot(null);
  }

  load(name: string): boolean {
    const e = findWorkspace(this.list(), name);
    if (!e) return false;
    this.shell.applyWorkspace(e.workspace);
    write(CURRENT_KEY, e.name);
    this.setActiveSlot(null);
    return true;
  }

  slots(): Array<Workspace | null> { return parseSlots(read(SLOTS_KEY)); }

  /** The quick slot last applied or saved, lit on the rail; null after any other layout is applied. */
  get activeSlot(): number | null {
    const i = Number(read(SLOT_KEY));
    return read(SLOT_KEY) !== null && Number.isInteger(i) ? i : null;
  }

  setActiveSlot(i: number | null): void {
    write(SLOT_KEY, i === null ? null : String(i));
    this.onSlotChange?.();
  }

  loadSlot(i: number): void {
    this.shell.applyWorkspace(slotWorkspace(this.slots(), i));
    write(CURRENT_KEY, null);
    this.setActiveSlot(i);
  }

  saveSlot(i: number): void {
    write(SLOTS_KEY, JSON.stringify(putSlot(this.slots(), i, this.shell.workspace())));
    this.setActiveSlot(i);
  }

  /** Back to the slot's built-in preset. The layout on screen stays. */
  resetSlot(i: number): void {
    write(SLOTS_KEY, JSON.stringify(putSlot(this.slots(), i, null)));
  }

  remove(name: string): void {
    const cur = this.current;
    write(LIST_KEY, JSON.stringify(removeWorkspace(this.list(), name)));
    if (cur && cur.toLowerCase() === name.trim().toLowerCase()) this.clearCurrent();
  }
}
