import { strToU8 } from "fflate";
import { zipFiles } from "@/io/zip";
import type { Project } from "@/core/doc/types";
import { type ImageItem, isImage, isSymbol } from "@/core/doc/types";
import { displaysOf } from "@/core/doc/displays";
import type { Contour } from "@/core/atlas/contour";
import { contourOffThread } from "@/io/workers/contour";
import type { ItemId } from "@/core/doc/ids";
import type { AssetStore } from "@/app/AssetStore";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { type AtlasOptions, atlasOptionsFor, type AtlasPage, buildAtlas } from "@/io/atlas/AtlasBuilder";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "@/core/export/settings";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { atlasText, isAtlasName } from "@/core/boneburst/atlas";
import type { BoneBurstSkeletonFile } from "@/core/boneburst/types";

export interface ExportResult {
  fileBase: string;
  skeleton: BoneBurstSkeletonFile;
  /** The `.atlas` text for `pages`. */
  atlas: string;
  pages: AtlasPage[];
  diagnostics: ExportDiagnostic[];
  /** Write the JSON without indentation. */
  minifyJson?: boolean;
  /** Name the atlas `.atlas.txt`, for Unity. */
  atlasTxt?: boolean;
  /** The exported events' sound files, written under `audio/` at the path
   *  each event names (`EventDef.audio`). */
  sounds?: Array<{ path: string; blob: Blob }>;
}

/**
 * Everything a Spine runtime needs: `<name>.json`, `<name>.atlas` and its
 * page images, for the scene.
 */
export async function buildExport(
  project: Project,
  assets: AssetStore,
  opts: AtlasOptions = atlasOptionsFor(exportSettingsOf(project)),
  onProgress?: (fraction: number) => void,
): Promise<ExportResult> {
  const built = await buildExports(project, assets, [project.rootSymbolId], opts, onProgress);
  return built.get(project.rootSymbolId)!;
}

/**
 * Several symbols at once, as the preview wants them (the edited symbol for
 * the panel, or the scene for a scene-scoped view). Each gets its own skeleton; they share
 * ONE atlas holding every image any of them draws, so two views cost one pack
 * per edit rather than two thrashing the atlas cache. A region nobody uses is
 * harmless to the runtime.
 */
export async function buildExports(
  project: Project,
  assets: AssetStore,
  symbolIds: readonly ItemId[],
  opts: AtlasOptions = atlasOptionsFor(exportSettingsOf(project)),
  onProgress?: (fraction: number) => void,
): Promise<Map<ItemId, ExportResult>> {
  const maskShape = await maskShapes(project, assets);
  const exported = [...new Set(symbolIds)].map((id) => [id, exportBoneBurst(project, id, { maskShape })] as const);
  const used = new Set<ItemId>();
  for (const [, e] of exported) for (const id of e.usedImages) used.add(id);
  const items = [...used]
    .map((id) => project.items[id])
    .filter((i): i is ImageItem => isImage(i));

  const fileBase = safeFileName(project.name);
  // A region name the file cannot hold is already an error in each export
  // that draws it; packing would only throw on it.
  const pages = items.every((i) => isAtlasName(i.name))
    ? await buildAtlas(items, assets, fileBase, fileBase, opts, onProgress)
    : [];
  const atlas = atlasText(pages.map((p) => p.info));
  const { minifyJson, atlasTxt } = exportSettingsOf(project);

  const out = new Map<ItemId, ExportResult>();
  for (const [id, e] of exported) {
    const diagnostics = [...e.diagnostics];
    if (e.usedImages.length === 0) {
      diagnostics.push({ severity: "warning", message: "No images are used on the stage, so the atlas is empty." });
    }
    out.set(id, { fileBase, skeleton: e.skeleton, atlas, pages, diagnostics, minifyJson, atlasTxt });
  }
  return out;
}

/**
 * The outline each mask image clips with, traced from its pixels (on a
 * worker), for `exportBoneBurst`: every image a mask layer shows anywhere in the
 * document. An image whose pixels are not decoded yet, or which has been
 * replaced by one of another size, is scaled to the item or, failing that,
 * clips with its rectangle.
 */
async function maskShapes(project: Project, assets: AssetStore): Promise<(item: ImageItem) => Contour> {
  const items = new Set<ImageItem>();
  for (const sym of Object.values(project.items)) {
    if (!isSymbol(sym)) continue;
    for (const layer of sym.layers) {
      if (!layer.isMask) continue;
      const node = sym.nodes[layer.nodeId];
      if (!node) continue;
      for (const ref of displaysOf(node)) {
        const item = project.items[ref.itemId];
        if (isImage(item)) items.add(item);
      }
    }
  }
  const shapes = new Map<ImageItem, Contour>();
  await Promise.all([...items].map(async (item) => {
    const pixels = assets.pixels(item.assetId);
    if (!pixels) return;
    const c = await contourOffThread(pixels);
    const sx = item.width / pixels.width, sy = item.height / pixels.height;
    shapes.set(item, sx === 1 && sy === 1 ? c : { ...c, points: c.points.map((v, i) => v * (i % 2 ? sy : sx)) });
  }));
  return (item) => shapes.get(item) ?? {
    points: [0, 0, item.width, 0, item.width, item.height, 0, item.height], islands: 0, holes: 0, soft: false,
  };
}

/** The document's export settings, the defaults when it has none. */
export function exportSettingsOf(project: Project): ExportSettings {
  return project.exportSettings ?? { ...DEFAULT_EXPORT_SETTINGS };
}

/** Every exported file by name, shared by the zip and the folder export. */
export async function exportFiles(result: ExportResult): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  files[`${result.fileBase}.json`] = strToU8(boneburstJson(result.skeleton, result.minifyJson === true));
  files[`${result.fileBase}.${result.atlasTxt ? "atlas.txt" : "atlas"}`] = strToU8(result.atlas);
  for (const page of result.pages) {
    files[`${page.fileStem}.${page.ext}`] = new Uint8Array(await page.blob.arrayBuffer());
  }
  for (const s of result.sounds ?? []) {
    files[`audio/${s.path}`] = new Uint8Array(await s.blob.arrayBuffer());
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
