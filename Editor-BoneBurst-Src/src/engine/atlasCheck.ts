import type { Issue } from "@/model/issue";
import { attachmentType, type Skeleton } from "@/model/skeleton";
import type { AtlasImages } from "./regions";
import type { Json } from "./rigJson";
import { framePaths, readSequence } from "./rigAttachments";

/**
 * The attachments whose regions the atlas lacks (E7-PLAN step 5): a region or mesh names a region
 * by its path (or name, or key), one per frame of a sequence. The editor draws them as nothing;
 * BoneBurst's bake refuses the file ("Region not found in atlas"), so opening it says so.
 */
export function missingRegions(s: Skeleton, images: AtlasImages): Issue[] {
  const have = new Set(images.regions.map((r) => r.name)), out: Issue[] = [];
  for (const sk of s.skins ?? []) for (const slot of sk.attachments ?? []) for (const { key, attachment: a } of slot.entries) {
    const type = attachmentType(a);
    if (type !== "region" && type !== "mesh" && type !== "linkedmesh") continue;
    const path = a.path ?? a.name ?? key;
    const sequence = readSequence({ sequence: a.sequence ? { ...a.sequence } : undefined } as Json);
    // A sequence of a million frames names a million regions: the first one missing is enough.
    const missing = framePaths(path, sequence && { ...sequence, count: Math.min(sequence.count, 10000) }).find((p) => !have.has(p));
    if (missing !== undefined) out.push({ where: `skins/${sk.name}/${slot.slot}/${key}`, message: `region "${missing}" is not in the atlas: drawn as nothing here, and Unity's bake refuses it` });
  }
  return out;
}
