import { strToU8 } from "fflate";
import { zipFiles } from "@/io/zip";
import type { Project } from "@/core/doc/types";
import type { AssetStore } from "@/app/AssetStore";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { type AtlasOptions, atlasOptionsFor, type AtlasPage } from "@/io/atlas/AtlasBuilder";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "@/core/export/settings";

export interface ExportResult {
  fileBase: string;
  /** The Spine skeleton JSON; null until the Spine exporter exists (phase 2). */
  skeleton: null;
  pages: AtlasPage[];
  diagnostics: ExportDiagnostic[];
  /** Write the JSON files without indentation. */
  minifyJson?: boolean;
}

export const EXPORT_NOT_BUILT = "Spine export is not built yet.";

/**
 * False until the Spine exporter lands. The export commands check it before
 * asking where to save: they have to ask before building (the save picker
 * needs the click's user activation), and choosing a file only to be told
 * nothing can be written is worse than being told at once.
 */
export const EXPORT_READY = false;

/**
 * Produces everything a Spine runtime needs. Until the Spine exporter lands
 * this refuses with one error, before any atlas work, so neither an export
 * nor the preview does work it then throws away.
 */
export async function buildExport(
  project: Project,
  _assets: AssetStore,
  _opts: AtlasOptions = atlasOptionsFor(exportSettingsOf(project)),
  _onProgress?: (fraction: number) => void,
): Promise<ExportResult> {
  return {
    fileBase: safeFileName(project.name),
    skeleton: null,
    pages: [],
    diagnostics: [{ severity: "error", message: EXPORT_NOT_BUILT }],
    minifyJson: exportSettingsOf(project).minifyJson,
  };
}

/** The document's export settings, the defaults when it has none. */
export function exportSettingsOf(project: Project): ExportSettings {
  return project.exportSettings ?? { ...DEFAULT_EXPORT_SETTINGS };
}

/** Canonical JSON: stable key order and fixed rounding, so exports diff cleanly. */
export function canonicalJson(value: unknown, minify = false): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "number") {
      const r = Math.round(v * 10000) / 10000;
      return Object.is(r, -0) ? 0 : r;
    }
    return v;
  }, minify ? undefined : 2);
}

/** Every exported file by name, shared by the zip and the folder export. */
export async function exportFiles(result: ExportResult): Promise<Record<string, Uint8Array>> {
  if (result.skeleton === null) throw new Error(EXPORT_NOT_BUILT);
  const files: Record<string, Uint8Array> = {};
  files[`${result.fileBase}.json`] = strToU8(canonicalJson(result.skeleton, result.minifyJson === true));
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
