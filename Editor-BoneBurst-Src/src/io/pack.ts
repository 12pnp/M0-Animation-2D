import type { Atlas, AtlasField, AtlasPage } from "@/model/atlas";

/**
 * Images packed into atlas pages (E4-PLAN step 7): tallest first, left to right on shelves, a new
 * shelf when a row is full, a new page when a page is; `PAD` pixels between images and from the
 * edges. Deterministic. Pages are as small as their contents (rounded up to 4 pixels).
 */

export const PAGE_MAX = 2048;
export const PAD = 2;

export interface PackImage {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
  /** Atlas fields the region keeps after its bounds (a re-import's kept `offsets` and `index`). */
  readonly fields?: readonly AtlasField[];
}

export interface Placed { readonly name: string; readonly page: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface Page { readonly name: string; readonly width: number; readonly height: number; readonly pixels: Uint8ClampedArray }

/** Too large for a page: the image's name. */
export class PackRefused extends Error {}

/** Where each image goes (in the input's order), and each page's size. */
export function place(images: readonly { name: string; width: number; height: number }[], max = PAGE_MAX, pad = PAD): { placed: Placed[]; sizes: { width: number; height: number }[] } {
  for (const im of images) {
    if (im.width + pad * 2 > max || im.height + pad * 2 > max) throw new PackRefused(`"${im.name}" is ${im.width} × ${im.height}; an atlas page holds ${max - pad * 2} × ${max - pad * 2} at most.`);
  }
  const order = images.map((im, i) => ({ im, i })).sort((a, b) => b.im.height - a.im.height || b.im.width - a.im.width || a.i - b.i);
  const placed = new Array<Placed>(images.length), sizes: { width: number; height: number }[] = [];
  let page = -1, x = 0, y = 0, shelf = 0, used = { width: 0, height: 0 };
  const newPage = () => {
    if (page >= 0) sizes.push(used);
    page++; x = pad; y = pad; shelf = 0; used = { width: 0, height: 0 };
  };
  newPage();
  for (const { im, i } of order) {
    if (x + im.width + pad > max) { y += shelf + pad; x = pad; shelf = 0; }
    if (y + im.height + pad > max) newPage();
    placed[i] = { name: im.name, page, x, y, width: im.width, height: im.height };
    used = { width: Math.max(used.width, x + im.width + pad), height: Math.max(used.height, y + im.height + pad) };
    x += im.width + pad;
    shelf = Math.max(shelf, im.height);
  }
  sizes.push(used);
  return { placed, sizes: sizes.map((s) => ({ width: up4(s.width), height: up4(s.height) })) };
}

const up4 = (n: number) => Math.max(4, Math.ceil(n / 4) * 4);

/** Pages `<name>.png`, `<name>_2.png`, … with the images drawn in, and the atlas describing them. */
export function pack(images: readonly PackImage[], name: string, max = PAGE_MAX): { pages: Page[]; atlas: Atlas; placed: Placed[] } {
  const { placed, sizes } = place(images, max);
  const pages: Page[] = sizes.map((s, p) => ({ name: p ? `${name}_${p + 1}.png` : `${name}.png`, width: s.width, height: s.height, pixels: new Uint8ClampedArray(s.width * s.height * 4) }));
  images.forEach((im, i) => {
    const at = placed[i]!, pg = pages[at.page]!;
    for (let row = 0; row < im.height; row++) pg.pixels.set(im.pixels.subarray(row * im.width * 4, (row + 1) * im.width * 4), ((at.y + row) * pg.width + at.x) * 4);
  });
  const atlasPages: AtlasPage[] = pages.map((pg, p) => ({
    name: pg.name,
    fields: [{ key: "size", values: [String(pg.width), String(pg.height)] }, { key: "filter", values: ["Linear", "Linear"] }],
    regions: placed.flatMap((x, i) => (x.page === p ? [{ name: x.name, fields: [{ key: "bounds", values: [x.x, x.y, x.width, x.height].map(String) }, ...(images[i]!.fields ?? [])] }] : [])),
  }));
  return { pages, atlas: { header: [], pages: atlasPages }, placed };
}
