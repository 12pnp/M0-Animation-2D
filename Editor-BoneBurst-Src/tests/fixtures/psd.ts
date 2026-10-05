import { join } from "node:path";
import { type Layer, writePsdUint8Array } from "ag-psd";

/**
 * `psd/figure.psd`: a small character in layers, written by ag-psd from this code (the on-screen
 * check of E4 step 7 drops it on the editor; `tests/psd.test.ts` holds the file to this code).
 */
export const FIGURE_PSD = join(__dirname, "psd", "figure.psd");

/** An ellipse (or a box) of one colour, its edge anti-aliased. */
function blob(w: number, h: number, rgb: readonly number[], round = true) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x + 0.5 - w / 2) / (w / 2), dy = (y + 0.5 - h / 2) / (h / 2);
    const d = round ? Math.hypot(dx, dy) : Math.max(Math.abs(dx), Math.abs(dy));
    const a = Math.max(0, Math.min(1, ((1 - d) * Math.min(w, h)) / 3));
    if (a > 0) data.set([rgb[0]!, rgb[1]!, rgb[2]!, Math.round(a * 255)], (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

const part = (name: string, left: number, top: number, w: number, h: number, rgb: readonly number[], more: Partial<Layer> = {}, round = true): Layer =>
  ({ name, left, top, right: left + w, bottom: top + h, imageData: blob(w, h, rgb, round), ...more });

export function figurePsd(): Uint8Array {
  const W = 300, H = 400;
  return writePsdUint8Array({ width: W, height: H, imageData: { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }, children: [
    part("shadow", 90, 370, 120, 24, [0, 0, 0], { opacity: 0.4, blendMode: "multiply" }),
    { name: "legs", children: [part("leg L", 115, 250, 30, 130, [60, 70, 140]), part("leg R", 155, 250, 30, 130, [60, 70, 140])] },
    part("body", 100, 120, 100, 150, [200, 80, 70], {}, false),
    { name: "arms", children: [part("arm L", 60, 130, 40, 120, [230, 190, 160]), part("arm R", 200, 130, 40, 120, [230, 190, 160])] },
    part("head", 105, 20, 90, 100, [240, 200, 170]),
    part("sketch", 0, 0, 50, 50, [255, 0, 255], { hidden: true }),
  ] }, { generateThumbnail: false });
}
