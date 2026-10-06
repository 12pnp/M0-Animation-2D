import { type Atlas, atlasField, atlasInts, regionBounds, regionDegrees } from "@/model/atlas";

/**
 * The atlas as the engine needs it: each region's packed rectangle, its trim
 * and its page's size, in numbers. Built from the model's atlas (`io/atlas`
 * reads the text once; Format-Json-Atlas.md §15), so there is one reader.
 */

export interface ImagePage {
  name: string;
  width: number;
  height: number;
  /** Colours stored premultiplied by alpha. */
  pma: boolean;
}

export interface ImageRegion {
  name: string;
  page: ImagePage;
  /** The packed pixels' top-left on the page. */
  x: number;
  y: number;
  /** The trimmed pixels' size, upright (before any packing turn). */
  width: number;
  height: number;
  /** Where the trimmed pixels sit in the original image: x from the left,
   *  y from the BOTTOM. */
  offsetX: number;
  offsetY: number;
  originalWidth: number;
  originalHeight: number;
  /** How far the packer turned the region, in degrees (0, or 90 for `rotate:true`). */
  degrees: number;
  /** A sequence frame's number; 0 when the region has none. */
  index: number;
}

export interface AtlasImages {
  pages: ImagePage[];
  regions: ImageRegion[];
}

export const NO_IMAGES: AtlasImages = { pages: [], regions: [] };

/** Both the current keys (`bounds`, `offsets`) and the older ones (`xy`, `size`, `orig`, `offset`). */
export function atlasImages(atlas: Atlas): AtlasImages {
  const pages: ImagePage[] = [], regions: ImageRegion[] = [];
  for (const p of atlas.pages) {
    const size = atlasInts(p, "size");
    const page: ImagePage = { name: p.name, width: size?.[0] ?? 0, height: size?.[1] ?? 0, pma: atlasField(p, "pma")?.[0] === "true" };
    pages.push(page);
    for (const r of p.regions) {
      const b = regionBounds(r) ?? { x: 0, y: 0, w: 0, h: 0 };
      const offsets = atlasInts(r, "offsets");
      const offset = atlasInts(r, "offset"), orig = atlasInts(r, "orig");
      const region: ImageRegion = {
        name: r.name, page, x: b.x, y: b.y, width: b.w, height: b.h,
        offsetX: offsets?.[0] ?? offset?.[0] ?? 0, offsetY: offsets?.[1] ?? offset?.[1] ?? 0,
        originalWidth: offsets?.[2] ?? orig?.[0] ?? 0, originalHeight: offsets?.[3] ?? orig?.[1] ?? 0,
        degrees: regionDegrees(r), index: atlasInts(r, "index")?.[0] ?? 0,
      };
      if (!region.originalWidth && !region.originalHeight) {
        region.originalWidth = region.width;
        region.originalHeight = region.height;
      }
      regions.push(region);
    }
  }
  return { pages, regions };
}

/**
 * A region's alpha at its original size, rows top first (the trimmed pixels put back where they
 * were), from its page's pixels (RGBA); null for a region the packer turned.
 */
export function regionAlpha(r: ImageRegion, page: { width: number; height: number; pixels: ArrayLike<number> }): { width: number; height: number; alpha: Uint8Array } | null {
  if (r.degrees !== 0) return null;
  const W = r.originalWidth, H = r.originalHeight, alpha = new Uint8Array(W * H);
  const top = H - r.offsetY - r.height;
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const px = r.x + x, py = r.y + y, ox = r.offsetX + x, oy = top + y;
    if (px >= page.width || py >= page.height || ox < 0 || oy < 0 || ox >= W || oy >= H) continue;
    alpha[oy * W + ox] = page.pixels[(py * page.width + px) * 4 + 3]!;
  }
  return { width: W, height: H, alpha };
}
