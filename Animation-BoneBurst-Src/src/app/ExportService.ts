import type { Store } from "./Store";
import { openExportSettings } from "@/view/export/ExportSettingsDialog";
import type { AssetStore } from "./AssetStore";
import type { SoundStore } from "./SoundStore";
import { buildExport, bundleZip, exportFiles, exportSettingsOf, safeFileName } from "@/io/export/ExportBundle";
import { mayWrite, rememberedUnityFolder, rememberUnityFolder, unityWriteOrder } from "@/io/export/UnityExport";
import {
  type FileRef,
  hasDirectoryPicker,
  hasNativeFiles,
  pickDirectory,
  pickSaveLocation,
  PNG_TYPE,
  writeFile,
  writeIntoDirectory,
  ZIP_TYPE,
} from "@/io/project/FileSystem";
import type { Toast } from "@/view/widgets/Toast";
import { isSymbol } from "@/core/doc/types";
import type { ItemId } from "@/core/doc/ids";
import { alertDialog, promptText } from "@/view/widgets/dialogs";
import { AtlasTooSmall, oversizeAdvice } from "@/core/atlas/oversize";
import { busy } from "@/view/widgets/Busy";
import { phase } from "./busy";

/**
 * File ▸ Export, Export to Folder, Export to Unity and a library item as PNG:
 * each asks where first (a save picker needs the click's user activation),
 * then builds through `buildExport`, refusing on any error diagnostic.
 */
export class ExportService {
  /** The problem the last explanation was about, so the preview, which
   *  rebuilds after every edit, explains each problem once. */
  private explainedAtlas: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly assets: AssetStore,
    private readonly sounds: SoundStore,
    private readonly toast: Toast,
    private readonly renderItemPng: (itemId: ItemId) => Promise<Blob | null>,
  ) {}

  /**
   * One library item as a PNG.
   *
   * The location is asked for BEFORE the raster, because `showSaveFilePicker`
   * needs transient user activation and an `await` in front of it throws that
   * away — the same rule the project export follows.
   */
  async exportItemPng(itemId: ItemId): Promise<void> {
    const item = this.store.project.items[itemId];
    if (!item) return;

    const suggested = `${safeFileName(item.name)}.png`;
    let target: FileRef | null;
    if (hasNativeFiles()) {
      target = await pickSaveLocation(suggested, PNG_TYPE, "animo-png");
    } else {
      const name = await promptText({ title: "Export PNG", label: "File name", value: suggested, ok: "Export" });
      target = name ? { name: name.endsWith(".png") ? name : `${name}.png` } : null;
    }
    if (!target) return;

    try {
      const blob = await busy(`Exporting ${target.name}`, () => this.renderItemPng(itemId));
      if (!blob) {
        this.toast.show(`"${item.name}" has nothing to draw`, true);
        return;
      }
      await writeFile(target, blob);
      this.toast.show(`Exported ${target.name}`);
    } catch (err) {
      this.toast.show(`Could not export the PNG: ${(err as Error).message}`, true);
    }
  }
  /**
   * Build the Spine export and write it where the user says.
   *
   * The location is asked for BEFORE the build, not after. `showSaveFilePicker`
   * needs transient user activation, and packing an atlas can easily outlive
   * the few seconds that lasts — ask late and the export dies on a gesture
   * error instead of saving. It also puts the question where the user expects
   * it, right after choosing the command.
   *
   * The name defaults to the project's, which is also what the skeleton and
   * the atlas pages are named after — one name for the whole export, so the
   * pieces stay recognisably a set.
   */
  async exportProject(): Promise<void> {
    const suggested = `${safeFileName(this.store.project.name)}_spine.zip`;
    let target: FileRef | null;
    if (hasNativeFiles()) {
      target = await pickSaveLocation(suggested, ZIP_TYPE, "animo-export");
    } else {
      const name = await promptText({ title: "Export Spine", label: "File name", value: suggested, ok: "Export" });
      target = name ? { name: name.endsWith(".zip") ? name : `${name}.zip` } : null;
    }
    if (!target) return;                        // cancelled
    const file = target;

    await busy(`Exporting ${file.name}`, async (report) => {
      const result = await this.buildForExport(phase(report, 0, 0.8));
      if (!result) return;
      try {
        await writeFile(file, await bundleZip(result));
        report(1);
        this.toast.show(
          `Exported ${file.name} (${result.pages.length} atlas page(s))`,
        );
      } catch (err) {
        this.reportExportFailure(err);
      }
    });
  }
  /**
   * Write the same files loose into a folder instead of zipped.
   *
   * A runtime wants `_ske.json` next to its atlas pages; when the target is
   * an assets folder in a game project, unzipping first is a step that exists
   * only because the exporter insisted on a zip.
   */
  async exportToFolder(): Promise<void> {
    if (!hasDirectoryPicker()) {
      this.toast.show("This browser cannot choose a folder. Use Export Spine to get a zip instead.", true);
      return;
    }
    const dir = await pickDirectory("animo-export");
    if (!dir) return;                           // cancelled

    await busy(`Exporting to ${dir.name}`, async (report) => {
      const result = await this.buildForExport(phase(report, 0, 0.8));
      if (!result) return;
      try {
        const files = await exportFiles(result);
        const names = Object.keys(files);
        for (const [n, name] of names.entries()) {
          await writeIntoDirectory(dir, name, new Blob([files[name] as unknown as BlobPart]));
          report(0.8 + 0.2 * (n + 1) / names.length);
        }
        this.toast.show(
          `Exported ${names.length} file(s) to ${dir.name}`,
        );
      } catch (err) {
        this.reportExportFailure(err);
      }
    });
  }
  /**
   * Export into the document's Unity folder (docs/BONEBURST-PIPELINE-PLAN.md R4):
   * the one remembered from last time, or one picked now. `ask` is a menu click,
   * which may ask the browser again for a remembered folder or pick one; the AI's
   * `export_to_unity` passes false and needs a folder granted already. The atlas
   * is `.atlas.txt` and the skeleton is written last (`unityWriteOrder`), so Unity's
   * rebake (the import package's BoneBurstRebakeOnChange) sees a whole export.
   */
  async exportToUnity(ask: boolean): Promise<{ folder: string; files: string[] } | null> {
    const name = this.store.project.name;
    let dir = await rememberedUnityFolder(name);
    if (dir && !(await mayWrite(dir, ask))) dir = null;
    if (!dir) {
      if (!ask) throw new Error("No Unity folder is set for this document: use File › Export to Unity… once (the browser asks for the folder), then this can export again.");
      if (!hasDirectoryPicker()) {
        this.toast.show("This browser cannot choose a folder. Use Export Spine to get a zip instead.", true);
        return null;
      }
      dir = await pickDirectory("boneburst-unity");
      if (!dir) return null;
      await rememberUnityFolder(name, dir);
    }
    const target = dir;
    let written: string[] | null = null;
    await busy(`Exporting to Unity: ${target.name}`, async (report) => {
      const result = await this.buildForExport(phase(report, 0, 0.8));
      if (!result) return;
      result.atlasTxt = true;
      const files = await exportFiles(result);
      const names = unityWriteOrder(Object.keys(files));
      for (const [n, file] of names.entries()) {
        await writeIntoDirectory(target, file, new Blob([files[file] as unknown as BlobPart]));
        report(0.8 + 0.2 * (n + 1) / names.length);
      }
      written = names;
    });
    if (!written) return null;
    this.toast.show(`Exported to Unity: ${target.name}. Unity rebakes it when it next refreshes; the first time, right-click the folder › BoneBurst › Bake Folder….`);
    return { folder: target.name, files: written };
  }

  /** Shared front half: build, report diagnostics, refuse on errors. */
  private async buildForExport(
    report: (fraction: number) => void,
  ): Promise<Awaited<ReturnType<typeof buildExport>> | null> {
    try {
      const result = await buildExport(this.store.project, this.assets, undefined, report);
      const root = this.store.project.items[this.store.project.rootSymbolId];
      result.sounds = (isSymbol(root) ? root.events ?? [] : [])
        .filter((d) => d.audio && this.sounds.has(d.audio))
        .map((d) => ({ path: d.audio!, blob: this.sounds.get(d.audio!)! }));
      for (const d of result.diagnostics) {
        (d.severity === "error" ? console.error : console.warn)(`[Export] ${d.message}`);
      }
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      if (errors.length) {
        this.toast.show(`Export aborted: ${errors[0]!.message}`, true);
        return null;
      }
      return result;
    } catch (err) {
      this.reportExportFailure(err);
      return null;
    }
  }
  reportExportFailure(err: unknown): void {
    if (err instanceof AtlasTooSmall) { void this.explainAtlasTooSmall(err); return; }
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Export] Failed:", err);
    this.toast.show(`Export failed: ${msg}`, true);
  }
  /** The preview built (null) or failed: an atlas too small is explained once per problem. */
  previewBuilt(err: unknown): void {
    if (!(err instanceof AtlasTooSmall)) {
      if (err === null) this.explainedAtlas = null;
      return;
    }
    const key = JSON.stringify([err.offenders, err.page]);
    if (key === this.explainedAtlas) return;
    this.explainedAtlas = key;
    void this.explainAtlasTooSmall(err);
  }
  private explainAtlasTooSmall(err: AtlasTooSmall): Promise<void> {
    const advice = oversizeAdvice(err.offenders, exportSettingsOf(this.store.project));
    return alertDialog({
      title: advice.title, message: advice.message, width: 460,
      extra: { label: "Export Settings…", run: () => openExportSettings(this.store) },
    });
  }
}
