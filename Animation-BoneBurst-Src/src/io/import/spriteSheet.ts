import type { Rect } from "@/core/math/geom";

/**
 * Reference art's pixels: a sprite sheet cut into its cells, or a run of
 * separate images brought to one size. The grid is `core/doc/reference.ts`'s
 * `sheetCells`; this only reads and writes images. DOM canvases, and every
 * cell encoded at once: one `toBlob` at a time costs about a second each in
 * some browsers.
 */

/** Cells past this size are scaled down: a reference is looked at, not
 *  exported, and every cell is saved in the project file. */
export const REFERENCE_MAX_SIDE = 1024;

export interface ReferenceImages { blobs: Blob[]; width: number; height: number }

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The image could not be encoded."))), "image/png"));
}

function outSize(w: number, h: number): { width: number; height: number } {
  const s = Math.min(1, REFERENCE_MAX_SIDE / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** The cells of a sheet, each its own PNG. */
export async function cutSheet(sheet: Blob, cells: Rect[]): Promise<ReferenceImages> {
  if (cells.length === 0) throw new Error("The grid gives no cells: check the columns, rows and frame count.");
  const bitmap = await decodeImage(sheet);
  try {
    const { width, height } = outSize(cells[0]!.w, cells[0]!.h);
    const blobs = await Promise.all(cells.map((c) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(bitmap, c.x, c.y, c.w, c.h, 0, 0, width, height);
      return encode(canvas);
    }));
    return { blobs, width, height };
  } finally {
    bitmap.close();
  }
}

/** Separate images, in the order given, each fitted into the first one's
 *  size (centred, aspect kept) so the run plays as one strip. */
export async function sequenceImages(files: Blob[]): Promise<ReferenceImages> {
  if (files.length === 0) throw new Error("No images.");
  const bitmaps = await Promise.all(files.map(decodeImage));
  try {
    const { width, height } = outSize(bitmaps[0]!.width, bitmaps[0]!.height);
    const blobs = await Promise.all(bitmaps.map((b) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const s = Math.min(width / b.width, height / b.height);
      const w = b.width * s, h = b.height * s;
      canvas.getContext("2d")!.drawImage(b, (width - w) / 2, (height - h) / 2, w, h);
      return encode(canvas);
    }));
    return { blobs, width, height };
  } finally {
    for (const b of bitmaps) b.close();
  }
}

/** Numbered files in number order: walk_2 before walk_10. */
export function naturalOrder<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
