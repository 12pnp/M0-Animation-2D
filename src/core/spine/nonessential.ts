import type { SpineSkeletonFile } from "./types";

/**
 * A skeleton without Spine's nonessential data (ARCHITECTURE ▸ Export
 * settings): what spine-core reads only for the editor, each field with a
 * default it falls back to, so the file plays the same. Spine's own export
 * writes these only when asked.
 *
 *   skeleton   fps, images, audio
 *   bones      color, icon, visible
 *   slots      visible
 *   meshes     width, height, edges
 *   boxes, paths, points, clips   color
 *   skins      color
 *
 * A region's or mesh's colour is a tint, not nonessential, and stays.
 */
export function withoutNonessential(file: SpineSkeletonFile): SpineSkeletonFile {
  const out = structuredClone(file) as SpineSkeletonFile & Record<string, unknown>;
  const header = out.skeleton as unknown as Record<string, unknown>;
  for (const k of ["fps", "images", "audio"]) delete header[k];
  for (const b of out.bones as unknown as Array<Record<string, unknown>>) for (const k of ["color", "icon", "visible"]) delete b[k];
  for (const s of (out.slots ?? []) as unknown as Array<Record<string, unknown>>) delete s.visible;
  for (const skin of out.skins ?? []) {
    delete (skin as unknown as Record<string, unknown>).color;
    for (const byKey of Object.values(skin.attachments ?? {})) {
      for (const att of Object.values(byKey) as Array<Record<string, unknown>>) {
        const type = att.type ?? "region";
        if (type === "mesh" || type === "linkedmesh") { delete att.width; delete att.height; delete att.edges; }
        if (type === "boundingbox" || type === "path" || type === "point" || type === "clipping") delete att.color;
      }
    }
  }
  return out;
}
