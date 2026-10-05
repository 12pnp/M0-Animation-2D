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
