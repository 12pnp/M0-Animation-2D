import { strToU8 } from "fflate";
import { zipFiles } from "@/io/zip";
import type { Project } from "@/core/doc/types";
import { type ImageItem, isImage } from "@/core/doc/types";
import type { ItemId } from "@/core/doc/ids";
import type { AssetStore } from "@/app/AssetStore";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { type AtlasOptions, atlasOptionsFor, type AtlasPage, buildAtlas } from "@/io/atlas/AtlasBuilder";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "@/core/export/settings";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { atlasText } from "@/core/spine/atlas";
import type { SpineSkeletonFile } from "@/core/spine/types";

export interface ExportResult {
  fileBase: string;
  skeleton: SpineSkeletonFile;
  /** The `.atlas` text for `pages`. */
  atlas: string;
  pages: AtlasPage[];
  diagnostics: ExportDiagnostic[];
  /** Write the JSON without indentation. */
  minifyJson?: boolean;
}

/**
 * Everything a Spine runtime needs: `<name>.json`, `<name>.atlas` and its
 * page images. `symbolId` picks the symbol to export (the scene when
 * absent); the preview asks for the one being edited.
 */
export async function buildExport(
  project: Project,
  assets: AssetStore,
  opts: AtlasOptions = atlasOptionsFor(exportSettingsOf(project)),
  onProgress?: (fraction: number) => void,
  symbolId?: ItemId,
): Promise<ExportResult> {
  const exported = exportSpine(project, symbolId);
  const { skeleton, diagnostics, usedImages } = exported;
  const items = usedImages
    .map((id) => project.items[id])
    .filter((i): i is ImageItem => isImage(i));

  const fileBase = safeFileName(project.name);
  // An atlas region name the file cannot hold is already an error; packing
  // would only throw on it.
  const refused = diagnostics.some((d) => d.severity === "error");
  const pages = refused ? [] : await buildAtlas(items, assets, fileBase, fileBase, opts, onProgress);
  if (items.length === 0) {
    diagnostics.push({ severity: "warning", message: "No images are used on the stage, so the atlas is empty." });
  }

  return {
    fileBase,
    skeleton,
    atlas: atlasText(pages.map((p) => p.info)),
    pages,
    diagnostics,
    minifyJson: exportSettingsOf(project).minifyJson,
  };
}

/** The document's export settings, the defaults when it has none. */
export function exportSettingsOf(project: Project): ExportSettings {
  return project.exportSettings ?? { ...DEFAULT_EXPORT_SETTINGS };
}

/** Every exported file by name, shared by the zip and the folder export. */
export async function exportFiles(result: ExportResult): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  files[`${result.fileBase}.json`] = strToU8(spineJson(result.skeleton, result.minifyJson === true));
  files[`${result.fileBase}.atlas`] = strToU8(result.atlas);
  for (const page of result.pages) {
    files[`${page.fileStem}.${page.ext}`] = new Uint8Array(await page.blob.arrayBuffer());
  }
  return files;
}

export async function bundleZip(result: ExportResult): Promise<Blob> {
  const zipped = await zipFiles(await exportFiles(result));
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The stem every exported file shares: the project name, made file-safe. */
export function safeFileName(name: string): string {
  // Leading dots go too: ".." is a legal-looking stem that the File System
  // Access API refuses outright, and a dotfile is not what anyone meant.
  const cleaned = name.trim().replace(/[^\w.-]+/g, "_").replace(/^[_.]+|[_.]+$/g, "");
  return cleaned || "project";
}
