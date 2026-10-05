import type { ItemId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import type { Project } from "@/core/doc/types";
import { type ExportSettings, isDefaultExport } from "@/core/export/settings";
import type { Command, TouchSet } from "./Command";
import { symbolOf } from "./lookup";

/**
 * Frame rate, stage size and background.
 *
 * Frame rate is the document's, not the animation's: DragonBones writes it
 * once at the root and every armature inherits it, so changing it here
 * retimes everything at once — which is what "the project runs at 30fps"
 * means.
 */

export interface DocumentSettingsPatch {
  name?: string;
  frameRate?: number;
  width?: number;
  height?: number;
  background?: string;
}

export class SetDocumentSettings implements Command {
  readonly kind = "doc.settings";
  readonly touches: TouchSet = { stage: true, timeline: true, library: true };
  readonly label = "Document Settings";
  private before: {
    name: string; frameRate: number; stage: Project["stage"];
  } | null = null;

  constructor(private patch: DocumentSettingsPatch) { }

  apply(p: Project): void {
    if (!this.before) {
      this.before = { name: p.name, frameRate: p.frameRate, stage: { ...p.stage } };
    }
    // The project name is also the export file name, so an empty one is
    // refused rather than propagated into the export.
    if (this.patch.name !== undefined && this.patch.name.trim()) p.name = this.patch.name.trim();
    if (this.patch.frameRate !== undefined) {
      p.frameRate = clampInt(this.patch.frameRate, 1, 120);
    }
    if (this.patch.width !== undefined) p.stage.width = clampInt(this.patch.width, 1, 16384);
    if (this.patch.height !== undefined) p.stage.height = clampInt(this.patch.height, 1, 16384);
    if (this.patch.background !== undefined) p.stage.background = this.patch.background;
  }

  revert(p: Project): void {
    if (!this.before) return;
    p.name = this.before.name;
    p.frameRate = this.before.frameRate;
    p.stage = { ...this.before.stage };
  }

  /** The follow-up's values become the ones redo applies; `before` keeps the
   *  state from the start of the scrub. */
  mergeWith(next: Command): boolean {
    if (!(next instanceof SetDocumentSettings)) return false;
    this.patch = { ...this.patch, ...next.patch };
    return true;
  }
}
function clampInt(v: number, lo: number, hi: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : lo;
  return Math.max(lo, Math.min(hi, n));
}
/**
 * The document's export settings, replaced whole. Settings equal to the
 * defaults are stored as absent, so a file nobody configured stays as it was.
 */

export class SetExportSettings implements Command {
  readonly kind = "doc.export";
  readonly touches: TouchSet = { library: false };
  readonly label = "Export Settings";
  private before: ExportSettings | undefined;
  private captured = false;

  constructor(private readonly next: ExportSettings) { }

  apply(p: Project): void {
    if (!this.captured) { this.before = p.exportSettings; this.captured = true; }
    if (isDefaultExport(this.next)) delete p.exportSettings;
    else p.exportSettings = { ...this.next };
  }

  revert(p: Project): void {
    if (this.before) p.exportSettings = this.before;
    else delete p.exportSettings;
  }
}
/** Which skins a rig shows on the stage and in the Preview
 *  (`SymbolItem.stageSkins`); null goes back to the automatic choice. */

export class SetStageSkins implements Command {
  readonly kind = "symbol.skins";
  readonly touches: TouchSet;
  private before: string[] | undefined;
  private captured = false;

  constructor(private readonly symbolId: ItemId, private readonly skins: string[] | null, readonly label = "Show Skins") {
    this.touches = { symbols: [symbolId], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!this.captured) { this.before = sym.stageSkins; this.captured = true; }
    if (this.skins) sym.stageSkins = [...this.skins];
    else delete sym.stageSkins;
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before) sym.stageSkins = this.before;
    else delete sym.stageSkins;
    invalidateBounds([this.symbolId]);
  }
}
