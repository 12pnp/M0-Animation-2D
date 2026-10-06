import type { Reference } from "@/model/sidecar";

/**
 * Where a reference image draws (E4-PLAN step 9): its centre at (x, y) in skeleton units, its
 * size its pixels times its scale, y up. No DOM: tested in vitest.
 */

/** The four corners (x, y; top-left, top-right, bottom-right, bottom-left) and their UVs (v down). */
export function referenceQuad(r: Reference, width: number, height: number): { xy: number[]; uv: number[] } {
  const hw = (width * r.scale) / 2, hh = (height * r.scale) / 2;
  return {
    xy: [r.x - hw, r.y + hh, r.x + hw, r.y + hh, r.x + hw, r.y - hh, r.x - hw, r.y - hh],
    uv: [0, 0, 1, 0, 1, 1, 0, 1],
  };
}

/** The file name a reference's path names (the part after the last slash). */
export const referenceFile = (path: string) => path.replace(/^.*[\\/]/, "");

/**
 * Which opened images are which references' pictures: by file name, any case, leaving out the
 * atlas's pages. Returns reference path → image name, and the paths with no image.
 */
export function matchReferences(paths: readonly string[], images: readonly string[], pages: readonly string[]): { found: Map<string, string>; missing: string[] } {
  const used = new Set(pages.map((p) => p.toLowerCase()));
  const spare = new Map(images.filter((n) => !used.has(n.toLowerCase())).map((n) => [n.toLowerCase(), n]));
  const found = new Map<string, string>(), missing: string[] = [];
  for (const path of paths) {
    const n = spare.get(referenceFile(path).toLowerCase());
    if (n) found.set(path, n); else missing.push(path);
  }
  return { found, missing };
}

/** A reference with its picture's size in pixels (a reference whose picture is missing has none). */
export interface Placed { readonly r: Reference; readonly width: number; readonly height: number }

type ToScreen = (x: number, y: number) => [number, number];

/** The topmost reference whose picture holds world (`wx`, `wy`): its index in `placed`, or -1. Later ones draw on top. */
export function hitReference(placed: readonly (Placed | null)[], wx: number, wy: number): number {
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    if (!p) continue;
    if (Math.abs(wx - p.r.x) <= (p.width * p.r.scale) / 2 && Math.abs(wy - p.r.y) <= (p.height * p.r.scale) / 2) return i;
  }
  return -1;
}

/** The corner (0–3, as `referenceQuad` lists them) within `radius` screen pixels of (`sx`, `sy`), or -1. */
export function referenceCorner(p: Placed, screen: ToScreen, sx: number, sy: number, radius = 6): number {
  const { xy } = referenceQuad(p.r, p.width, p.height);
  let best = -1, bestD = radius;
  for (let k = 0; k < 4; k++) {
    const [x, y] = screen(xy[k * 2]!, xy[k * 2 + 1]!), d = Math.hypot(sx - x, sy - y);
    if (d <= bestD) { best = k; bestD = d; }
  }
  return best;
}

/** Where `from` goes when dragged from world `start` to `now`. */
export function movedReference(from: Reference, start: readonly [number, number], now: readonly [number, number]): { x: number; y: number } {
  return { x: from.x + now[0] - start[0], y: from.y + now[1] - start[1] };
}

/**
 * `from`'s scale when a corner is dragged from world `start` to `now`: scaled about its centre by
 * how much farther from the centre the pointer is. Never below a hundredth of the start's scale.
 */
export function scaledReference(from: Reference, start: readonly [number, number], now: readonly [number, number]): number {
  const d0 = Math.hypot(start[0] - from.x, start[1] - from.y), d1 = Math.hypot(now[0] - from.x, now[1] - from.y);
  if (!(d0 > 0)) return from.scale;
  return Math.round(Math.max(from.scale / 100, (from.scale * d1) / d0) * 1e4) / 1e4;
}
