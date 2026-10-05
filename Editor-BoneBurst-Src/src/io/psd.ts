import { getLayerImageData, initializeCanvas, type Layer, readPsd } from "ag-psd";
import type { Issue } from "@/model/issue";

/**
 * A Photoshop file's layers as plain data (E4-PLAN step 7, owner decision D7: read by `ag-psd`):
 * each visible layer with pixels, trimmed to its non-transparent pixels, bottom layer first, with
 * the opacity and visibility of the groups it is in applied. The structure is read first and
 * checked against `PSD_LIMITS`; layer pixels are decoded one layer at a time.
 */

// Layer pixels as plain arrays, never through a canvas: the same in the browser and under Node.
initializeCanvas(() => { throw new Error("the PSD reader draws nothing"); }, (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData);

export const PSD_LIMITS = { side: 16384, layers: 2000, pixels: 256e6 } as const;

export interface PsdLayer {
  /** The layer's name, as Photoshop shows it. */
  readonly name: string;
  /** Its group names, outermost first. */
  readonly groups: readonly string[];
  /** The trimmed image's top-left on the canvas, in pixels (y down). */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bits, straight alpha, width × height. */
  readonly pixels: Uint8ClampedArray;
  /** The layer's opacity times its groups', 0..1. */
  readonly opacity: number;
  /** Photoshop's blend mode name. */
  readonly blend: string;
}

export interface PsdLayers {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly PsdLayer[];
  readonly issues: readonly Issue[];
}

/** Refused: what is wrong with the file as a whole. */
export class PsdRefused extends Error {}

const MODES: Record<number, string> = { 0: "Bitmap", 1: "Grayscale", 2: "Indexed", 3: "RGB", 4: "CMYK", 7: "Multichannel", 8: "Duotone", 9: "Lab" };

/** The layers of the Photoshop file in `buffer` (named `file` in what it reports). */
export function readPsdLayers(buffer: ArrayBuffer | Uint8Array, file: string): PsdLayers {
  let psd;
  try {
    psd = readPsd(buffer, { useRawData: true, useRawThumbnail: true, skipCompositeImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  } catch (err) {
    throw new PsdRefused(`${file} is not a Photoshop file this editor can read (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (psd.colorMode !== undefined && psd.colorMode !== 3) throw new PsdRefused(`${file} is in ${MODES[psd.colorMode] ?? `colour mode ${psd.colorMode}`}; save it as RGB.`);
  if ((psd.bitsPerChannel ?? 8) !== 8) throw new PsdRefused(`${file} has ${psd.bitsPerChannel} bits per channel; save it at 8 bits.`);
  if (psd.width > PSD_LIMITS.side || psd.height > PSD_LIMITS.side) throw new PsdRefused(`${file} is ${psd.width} × ${psd.height}; the largest side read is ${PSD_LIMITS.side}.`);

  const issues: Issue[] = [], layers: PsdLayer[] = [];
  let count = 0, pixels = 0;
  const walk = (list: readonly Layer[], groups: readonly string[], opacity: number, hidden: boolean) => {
    for (const l of list) {
      const name = l.name ?? "layer";
      const where = `${file}: ${[...groups, name].join(" / ")}`;
      if (++count > PSD_LIMITS.layers) throw new PsdRefused(`${file} has more than ${PSD_LIMITS.layers} layers.`);
      const off = hidden || l.hidden === true;
      if (l.children) {
        walk(l.children, [...groups, name], opacity * (l.opacity ?? 1), off);
        continue;
      }
      if (off) { issues.push({ where, message: "hidden: left out" }); continue; }
      const w = (l.right ?? 0) - (l.left ?? 0), h = (l.bottom ?? 0) - (l.top ?? 0);
      if (w <= 0 || h <= 0) { issues.push({ where, message: "no pixels: left out" }); continue; }
      pixels += w * h;
      if (pixels > PSD_LIMITS.pixels) throw new PsdRefused(`${file}'s layers hold more than ${PSD_LIMITS.pixels / 1e6} million pixels.`);
      const data = getLayerImageData(l);
      // The raw channels are not needed once decoded.
      delete l.rawData;
      if (!data) { issues.push({ where, message: "no pixels: left out" }); continue; }
      const trimmed = trim(eightBit(data.data), data.width, data.height);
      if (!trimmed) { issues.push({ where, message: "fully transparent: left out" }); continue; }
      layers.push({
        name, groups, left: (l.left ?? 0) + trimmed.x, top: (l.top ?? 0) + trimmed.y, width: trimmed.width, height: trimmed.height,
        pixels: trimmed.pixels, opacity: opacity * (l.opacity ?? 1), blend: l.blendMode ?? "normal",
      });
    }
  };
  walk(psd.children ?? [], [], 1, false);
  return { width: psd.width, height: psd.height, layers, issues };
}

/** Pixels as 8-bit RGBA. */
function eightBit(data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  if (data instanceof Uint8Array) return new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  if (data instanceof Uint16Array) return Uint8ClampedArray.from(data, (v) => v >> 8);
  return Uint8ClampedArray.from(data, (v) => Math.round(v * 255));
}

/** The smallest rectangle holding every pixel with alpha, and its pixels; null when there is none. */
export function trim(px: Uint8ClampedArray, width: number, height: number): { x: number; y: number; width: number; height: number; pixels: Uint8ClampedArray } | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3]! === 0) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(px.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  return { x: x0, y: y0, width: w, height: h, pixels: out };
}
