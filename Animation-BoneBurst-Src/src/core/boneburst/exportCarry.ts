import type { SymbolItem, Node } from "@/core/doc/types";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { type CarriedRef, constraintRefs, skinRefs, animationRefs } from "./carry";
import { excludedNodes } from "./exportStructure";
import { ROOT_BONE } from "./exportTypes";
import type { BoneBurstSkeletonFile, BoneBurstAnimation } from "./types";

/**
 * Every name the carried JSON of an opened file relies on must still be in
 * the skeleton: a renamed or deleted bone, slot, constraint or skin would
 * otherwise make the runtime throw, or quietly skip it. An error each, so
 * the export refuses.
 */
export function checkCarried(file: BoneBurstSkeletonFile, sym: SymbolItem, diags: ExportDiagnostic[]): void {
  const have: Record<CarriedRef["kind"], Set<string>> = {
    bone: new Set(file.bones.map((b) => b.name)),
    slot: new Set((file.slots ?? []).map((sl) => sl.name)),
    constraint: new Set((file.constraints ?? []).map((c) => c.name)),
    skin: new Set((file.skins ?? []).map((sk) => sk.name)),
    attachment: new Set(),
    event: new Set(Object.keys(file.events ?? {})),
  };
  const refs: CarriedRef[] = [];
  for (const c of sym.spine?.constraints ?? []) refs.push(...constraintRefs(c));
  for (const skin of sym.spine?.skins ?? []) refs.push(...skinRefs(skin));
  for (const anim of sym.animations) if (anim.spine) refs.push(...animationRefs(anim.spine, anim.name));
  const reported = new Set<string>();
  for (const r of refs) {
    if (have[r.kind].has(r.name)) continue;
    const message = `${r.where} needs the ${r.kind} "${r.name}", which the skeleton no longer has; rename it back or remove what needs it.`;
    if (!reported.has(message)) diags.push({ severity: "error", message });
    reported.add(message);
  }
}
/** The symbol's own root bone: the one top-level bone of an opened Spine
 *  file, or a top-level bone called "root". */
export function rootBoneOf(sym: SymbolItem): Node | undefined {
  const skipped = excludedNodes(sym);
  const tops = Object.values(sym.nodes).filter((n) => n.kind === "bone" && !n.parentId && !skipped.has(n.id));
  if (sym.spine && tops.length === 1) return tops[0];
  return tops.find((n) => n.name === ROOT_BONE);
}
/** `generated` with `carried`'s timelines, a carried attachment's timelines
 *  kept where the document has none (the stage rig's `setupOnly` animation). */
export function mergeAttachmentTimelines(generated: BoneBurstAnimation, carried: Record<string, unknown>): BoneBurstAnimation {
  const out = { ...carried, ...generated } as Record<string, unknown>;
  const fromFile = carried.attachments as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (generated.attachments && fromFile) {
    const into = structuredClone(generated.attachments) as Record<string, Record<string, Record<string, unknown>>>;
    for (const [skin, slots] of Object.entries(fromFile)) {
      for (const [slot, atts] of Object.entries(slots)) {
        const target = ((into[skin] ??= {})[slot] ??= {});
        for (const [att, timelines] of Object.entries(atts)) if (!target[att]) target[att] = timelines;
      }
    }
    out.attachments = into;
  }
  return out as BoneBurstAnimation;
}
