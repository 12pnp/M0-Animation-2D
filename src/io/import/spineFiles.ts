import { TextureAtlas } from "@esotericsoftware/spine-core";
import { unzipFiles } from "@/io/zip";

/**
 * The files of a Spine export, found among what the user picked: the
 * skeleton `.json`, the `.atlas` (or Unity's `.atlas.txt`) and the page
 * images the atlas names. A `.zip` holding them (what File ▸ Export writes)
 * is opened too. Binary `.skel` files are refused with a way forward.
 */
export interface SpineFiles {
  /** The skeleton's name: the JSON file's, without extension. */
  name: string;
  json: unknown;
  atlas: string;
  /** Page images by the file name the atlas uses. */
  pages: Map<string, Blob>;
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path;

export async function readSpineFiles(picked: File[]): Promise<SpineFiles> {
  const files = new Map<string, Blob>();
  for (const f of picked) {
    if (/\.zip$/i.test(f.name)) {
      const unzipped = await unzipFiles(new Uint8Array(await f.arrayBuffer()));
      for (const [path, bytes] of Object.entries(unzipped)) {
        if (!path.endsWith("/")) files.set(base(path), new Blob([bytes as unknown as BlobPart]));
      }
    } else {
      files.set(base(f.name), f);
    }
  }
  const names = [...files.keys()];
  if (names.some((n) => /\.skel(\.bytes)?$/i.test(n)) && !names.some((n) => /\.json$/i.test(n))) {
    throw new Error("Binary skeletons (.skel) cannot be opened. In Spine, export the skeleton as JSON instead.");
  }
  const jsonName = names.find((n) => /\.json$/i.test(n));
  if (!jsonName) throw new Error("No skeleton .json among the files. Pick the .json, the .atlas and the page images together.");
  const atlasName = names.find((n) => /\.atlas(\.txt)?$/i.test(n));
  if (!atlasName) throw new Error("No .atlas among the files. Pick it with the .json and the page images.");

  let json: unknown;
  try {
    json = JSON.parse(await files.get(jsonName)!.text());
  } catch (err) {
    throw new Error(`${jsonName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const atlas = await files.get(atlasName)!.text();
  const pages = new Map<string, Blob>();
  for (const page of new TextureAtlas(atlas).pages) {
    const blob = files.get(base(page.name));
    if (!blob) throw new Error(`The atlas needs the page image "${page.name}", which was not picked.`);
    pages.set(page.name, blob);
  }
  return { name: jsonName.replace(/\.json$/i, ""), json, atlas, pages };
}

/** One region, cut out upright and untrimmed. */
export interface CutRegion { name: string; width: number; height: number; png: Blob }

/**
 * Every region of the atlas as its own image: turned upright when the
 * packer rotated it, placed back into its untrimmed size (transparent where
 * whitespace was stripped), and un-premultiplied when the page is stored
 * premultiplied. The library works in whole, straight-alpha images; the
 * export trims and packs them again.
 */
export async function cutRegions(files: SpineFiles, warn: (message: string) => void): Promise<CutRegion[]> {
  const atlas = new TextureAtlas(files.atlas);
  const bitmaps = new Map<string, ImageBitmap>();
  for (const page of atlas.pages) bitmaps.set(page.name, await createImageBitmap(files.pages.get(page.name)!));
  const drawn: Array<{ name: string; width: number; height: number; canvas: HTMLCanvasElement }> = [];
  const seen = new Set<string>();
  try {
    for (const r of atlas.regions) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      if (r.degrees !== 0 && r.degrees !== 90 && r.degrees !== 180 && r.degrees !== 270) {
        warn(`Region "${r.name}" is rotated ${r.degrees}°, which cannot be read; it was left out.`);
        continue;
      }
      const w = r.originalWidth, h = r.originalHeight;
      // A page canvas, not an OffscreenCanvas: `convertToBlob` can take a
      // second per call in some browsers, and an atlas has hundreds.
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, w);
      canvas.height = Math.max(1, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: r.page.pma })!;
      // The trimmed pixels' box in the whole image; `offsetY` counts from
      // the bottom.
      const left = r.offsetX, top = h - r.offsetY - r.height;
      ctx.beginPath();
      ctx.rect(left, top, r.width, r.height);
      ctx.clip();
      // Page to image, from how the runtime reads a turned region
      // (`MeshAttachment.computeUVs`), for image (x, y) in the trimmed box:
      //   90   page (region.x + y, region.y + width − x)
      //   180  page (region.x + width − x, region.y + height − y)
      //   270  page (region.x + height − y, region.y + x)
      if (r.degrees === 90) ctx.setTransform(0, 1, -1, 0, left + r.y + r.width, top - r.x);
      else if (r.degrees === 180) ctx.setTransform(-1, 0, 0, -1, left + r.x + r.width, top + r.y + r.height);
      else if (r.degrees === 270) ctx.setTransform(0, -1, 1, 0, left - r.y, top + r.x + r.height);
      else ctx.setTransform(1, 0, 0, 1, left - r.x, top - r.y);
      ctx.drawImage(bitmaps.get(r.page.name)!, 0, 0);
      if (r.page.pma) unpremultiply(ctx, w, h);
      drawn.push({ name: r.name, width: w, height: h, canvas });
    }
  } finally {
    for (const b of bitmaps.values()) b.close();
  }
  // Encoded all at once: a browser may hold each `toBlob` back to a timer
  // tick (a second, in some embedded views), and one at a time that is a
  // second per region.
  return Promise.all(drawn.map(async ({ name, width, height, canvas }) => {
    const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!png) throw new Error(`Region "${name}" could not be encoded.`);
    return { name, width, height, png };
  }));
}

function unpremultiply(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 0 || a === 255) continue;
    d[i] = Math.min(255, Math.round((d[i]! * 255) / a));
    d[i + 1] = Math.min(255, Math.round((d[i + 1]! * 255) / a));
    d[i + 2] = Math.min(255, Math.round((d[i + 2]! * 255) / a));
  }
  ctx.putImageData(img, 0, 0);
}
