import type { PackedPage, PackedRegion } from "@/core/atlas/packed";

/**
 * Packed pages as a Spine (libgdx) `.atlas` text file, in the field names
 * spine-core's `TextureAtlas` reads:
 *
 *   <page image file>
 *   size:W,H
 *   filter:Linear,Linear
 *   <region name>
 *   bounds:x,y,w,h                    the TRIMMED pixels, top-left origin
 *   offsets:left,bottom,origW,origH   only when trimmed
 *
 * `offsets` y counts from the BOTTOM of the original image
 * (`RegionAttachment.computeUVs`: localY = −height/2 + offsetY·scale, y up),
 * where the packer records the trim from the top. Texture scale needs no
 * field: the attachment keeps the full-size `width`/`height` and the runtime
 * scales the region's smaller pixels up to it.
 */
export function atlasText(pages: readonly PackedPage[]): string {
  const out: string[] = [];
  for (const page of pages) {
    if (out.length) out.push("");
    out.push(page.imagePath);
    out.push(`size:${page.width},${page.height}`);
    out.push("filter:Linear,Linear");
    for (const r of page.regions) out.push(...regionLines(r));
  }
  return out.join("\n") + "\n";
}

/** Whether a region name survives the line-based format: no line breaks, and
 *  no surrounding spaces (the reader trims page lines, not region names). */
export function isAtlasName(name: string): boolean {
  return name !== "" && name === name.trim() && !/[\r\n]/.test(name);
}

function regionLines(r: PackedRegion): string[] {
  // The packer never rotates (MaxRectsPacker's allowRotation is off and no
  // setting turns it on); which way a rotated region turns is not settled
  // here, so refuse rather than guess.
  if (r.rotated) throw new Error(`Atlas region "${r.name}" is rotated, which the Spine atlas writer does not support.`);
  if (!isAtlasName(r.name)) {
    throw new Error(`Atlas region name ${JSON.stringify(r.name)} cannot be written: the atlas is line based.`);
  }
  const lines = [r.name, `bounds:${r.x},${r.y},${r.width},${r.height}`];
  const trimmed = r.width !== r.originalWidth || r.height !== r.originalHeight
    || r.offsetX !== 0 || r.offsetY !== 0;
  if (trimmed) {
    const bottom = r.originalHeight - r.offsetY - r.height;
    lines.push(`offsets:${r.offsetX},${bottom},${r.originalWidth},${r.originalHeight}`);
  }
  return lines;
}
