import type { AssetId, FolderId, ItemId } from "@/core/doc/ids";
import { isImage, type LibraryFolder, type LibraryItem, type Project } from "@/core/doc/types";
import type { Command, TouchSet } from "./Command";
import { invalidateBounds } from "@/core/doc/pose";

/** Library folders. Organisation only: nothing here reaches the stage or the export. */

const TOUCHES: TouchSet = { library: true };

export class AddFolder implements Command {
  readonly kind = "library.folder.add";
  readonly touches = TOUCHES;
  readonly label = "New Folder";
  constructor(readonly folder: LibraryFolder) {}
  apply(p: Project): void { p.folders[this.folder.id] = { ...this.folder }; }
  revert(p: Project): void { delete p.folders[this.folder.id]; }
}

export class RenameFolder implements Command {
  readonly kind = "library.folder.rename";
  readonly touches = TOUCHES;
  readonly label = "Rename Folder";
  private before = "";
  constructor(private readonly id: FolderId, private readonly name: string) {}
  apply(p: Project): void {
    const f = p.folders[this.id];
    if (!f) return;
    this.before = f.name;
    f.name = this.name;
  }
  revert(p: Project): void {
    const f = p.folders[this.id];
    if (f) f.name = this.before;
  }
}

/** Items and folders into `into` (null: the top level). The caller checks
 *  `canMoveFolder`; a folder that would land inside itself is skipped here too. */
export class MoveToFolder implements Command {
  readonly kind = "library.move";
  readonly touches = TOUCHES;
  readonly label = "Move to Folder";
  private beforeItems = new Map<ItemId, FolderId | undefined>();
  private beforeFolders = new Map<FolderId, FolderId | null>();

  constructor(
    private readonly items: readonly ItemId[],
    private readonly folders: readonly FolderId[],
    private readonly into: FolderId | null,
  ) {}

  apply(p: Project): void {
    this.beforeItems.clear();
    this.beforeFolders.clear();
    for (const id of this.items) {
      const item = p.items[id];
      if (!item) continue;
      this.beforeItems.set(id, item.folderId);
      if (this.into) item.folderId = this.into; else delete item.folderId;
    }
    for (const id of this.folders) {
      const f = p.folders[id];
      if (!f || this.inside(p, this.into, id)) continue;
      this.beforeFolders.set(id, f.parentId);
      f.parentId = this.into;
    }
  }

  revert(p: Project): void {
    for (const [id, folderId] of this.beforeItems) {
      const item = p.items[id];
      if (!item) continue;
      if (folderId) item.folderId = folderId; else delete item.folderId;
    }
    for (const [id, parentId] of this.beforeFolders) {
      const f = p.folders[id];
      if (f) f.parentId = parentId;
    }
  }

  /** Whether `at` is `folder` or lies inside it. */
  private inside(p: Project, at: FolderId | null, folder: FolderId): boolean {
    for (let f = at, n = 0; f && n < 1000; f = p.folders[f]?.parentId ?? null, n++) {
      if (f === folder) return true;
    }
    return false;
  }
}

/** One folder, which must be empty by then: `deletePlan` removes the items and
 *  deeper folders first, in the same transaction. */
export class RemoveFolder implements Command {
  readonly kind = "library.folder.remove";
  readonly touches = TOUCHES;
  readonly label = "Delete Folder";
  private folder: LibraryFolder | null = null;
  constructor(private readonly id: FolderId) {}
  apply(p: Project): void {
    this.folder = p.folders[this.id] ?? null;
    delete p.folders[this.id];
  }
  revert(p: Project): void {
    if (this.folder) p.folders[this.id] = this.folder;
  }
}

/* ── Library ─────────────────────────────────────────────────────────────*/

export class AddLibraryItem implements Command {
  readonly kind = "library.add";
  readonly touches: TouchSet = { library: true };
  constructor(readonly label: string, private readonly item: LibraryItem) { }

  apply(p: Project): void {
    p.items[this.item.id] = this.item;
    if (!p.itemOrder.includes(this.item.id)) p.itemOrder.push(this.item.id);
  }
  revert(p: Project): void {
    delete p.items[this.item.id];
    p.itemOrder = p.itemOrder.filter((i) => i !== this.item.id);
    invalidateBounds([this.item.id]);
  }
}

export class RenameLibraryItem implements Command {
  readonly kind = "library.rename";
  readonly touches: TouchSet;
  private before = "";
  constructor(private readonly id: ItemId, private readonly name: string) {
    this.touches = { library: true, symbols: [id] };
  }
  get label(): string { return "Rename"; }

  /**
   * Whether another library item already has `name`. The exporter refuses
   * such a clash — the runtime finds armatures and textures by name — so the
   * rename is the place to stop it being made.
   */
  static clashes(p: Project, id: ItemId, name: string): boolean {
    return Object.values(p.items).some((i) => i.id !== id && i.name === name);
  }

  apply(p: Project): void {
    const item = p.items[this.id];
    if (!item) return;
    this.before = item.name;
    item.name = this.name;
  }
  revert(p: Project): void {
    const item = p.items[this.id];
    if (item) item.name = this.before;
  }
}
/**
 * Swap the pixels behind an ImageItem, keeping its `ItemId`, so every instance
 * — with its pose, its keyframes and its IK — keeps working.
 *
 * The new asset is registered BEFORE this command is applied (the same rule
 * PSD import follows), which is what lets `apply` stay a pure swap of three
 * fields and `revert` a pure swap back. Transform points are left alone even
 * when the size changes; the caller says so, because the exporter normalises
 * pivots against the untrimmed size and the anchor visibly moves.
 */

export class ReplaceImageAsset implements Command {
  readonly kind = "library.replace";
  readonly touches: TouchSet;
  readonly label = "Replace Image";
  private before: { assetId: AssetId; width: number; height: number; } | null = null;

  constructor(
    private readonly id: ItemId,
    private readonly next: { assetId: AssetId; width: number; height: number; },
    /** Symbols holding an instance, so their cached bounds are refreshed. */
    hosts: ItemId[]
  ) {
    this.touches = { library: true, symbols: hosts, stage: true };
  }

  apply(p: Project): void {
    const item = p.items[this.id];
    if (!isImage(item)) return;
    this.before = { assetId: item.assetId, width: item.width, height: item.height };
    Object.assign(item, this.next);
    // Reaches every symbol measured through this image.
    invalidateBounds([this.id]);
  }

  revert(p: Project): void {
    const item = p.items[this.id];
    if (!isImage(item) || !this.before) return;
    Object.assign(item, this.before);
    invalidateBounds([this.id]);
  }
}
/**
 * Deleting a library item is refused while instances exist, so this command
 * never has to repair dangling references.
 */

export class RemoveLibraryItem implements Command {
  readonly kind = "library.remove";
  readonly touches: TouchSet = { library: true };
  readonly label = "Delete Library Item";
  private item: LibraryItem | null = null;
  private orderIndex = -1;
  constructor(private readonly id: ItemId) { }

  apply(p: Project): void {
    this.item = p.items[this.id] ?? null;
    this.orderIndex = p.itemOrder.indexOf(this.id);
    delete p.items[this.id];
    p.itemOrder = p.itemOrder.filter((i) => i !== this.id);
    invalidateBounds([this.id]);
  }
  revert(p: Project): void {
    if (!this.item) return;
    p.items[this.id] = this.item;
    const order = [...p.itemOrder];
    order.splice(this.orderIndex < 0 ? order.length : this.orderIndex, 0, this.id);
    p.itemOrder = order;
  }
}
