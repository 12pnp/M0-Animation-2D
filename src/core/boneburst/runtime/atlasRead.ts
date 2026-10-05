/**
 * The libgdx `.atlas` text (what Spine's packer and `atlas.ts` write, and
 * Unity's `.atlas.txt`), read into pages and regions. Our own reader: the
 * preview and File ▸ Open Spine use it instead of spine-core's
 * `TextureAtlas` (docs/PREVIEW-RUNTIME-PLAN.md, P0). `tests/atlasRead.test.ts`
 * holds it to spine-core's reading of the same text.
 *
 * The format is line based. A page starts after a blank line (or at the top)
 * with its image file name, then `key:value` lines; every other line without
 * a colon names a region, followed by its own `key:value` lines. Values are
 * comma separated. Both the current keys (`bounds`, `offsets`) and the older
 * ones (`xy`, `size`, `orig`, `offset`) are read.
 */

export interface AtlasPage {
  name: string;
  width: number;
  height: number;
  /** Colours stored premultiplied by alpha. */
  pma: boolean;
}

export interface AtlasRegion {
  name: string;
  page: AtlasPage;
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

export interface Atlas {
  pages: AtlasPage[];
  regions: AtlasRegion[];
}

const ints = (value: string): number[] => value.split(",").map((v) => parseInt(v.trim(), 10));

export function readAtlas(text: string): Atlas {
  const pages: AtlasPage[] = [];
  const regions: AtlasRegion[] = [];
  let page: AtlasPage | null = null;
  let region: AtlasRegion | null = null;
  // An old-format `size` on a region gives the packed footprint only once
  // `rotate` is known, so a region is finished when the next entry starts.
  let rawSize: number[] | null = null;
  const finish = () => {
    if (region && rawSize) {
      region.width = rawSize[0]!;
      region.height = rawSize[1]!;
    }
    if (region) {
      if (!region.originalWidth && !region.originalHeight) {
        region.originalWidth = region.width;
        region.originalHeight = region.height;
      }
      regions.push(region);
    }
    region = null;
    rawSize = null;
  };

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) {
      finish();
      page = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      finish();
      if (!page) {
        page = { name: line, width: 0, height: 0, pma: false };
        pages.push(page);
      } else {
        region = {
          name: line, page, x: 0, y: 0, width: 0, height: 0,
          offsetX: 0, offsetY: 0, originalWidth: 0, originalHeight: 0, degrees: 0, index: 0,
        };
      }
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (region) {
      const v = ints(value);
      switch (key) {
        case "bounds": [region.x, region.y, region.width, region.height] = v as [number, number, number, number]; break;
        case "xy": [region.x, region.y] = v as [number, number]; break;
        case "size": rawSize = v; break;
        case "offsets": [region.offsetX, region.offsetY, region.originalWidth, region.originalHeight] = v as [number, number, number, number]; break;
        case "offset": [region.offsetX, region.offsetY] = v as [number, number]; break;
        case "orig": [region.originalWidth, region.originalHeight] = v as [number, number]; break;
        case "rotate":
          region.degrees = value === "true" ? 90 : value === "false" ? 0 : parseInt(value, 10) || 0;
          break;
        case "index": region.index = parseInt(value, 10); break;
      }
    } else if (page) {
      switch (key) {
        case "size": [page.width, page.height] = ints(value) as [number, number]; break;
        case "pma": page.pma = value === "true"; break;
      }
    }
  }
  finish();
  return { pages, regions };
}
