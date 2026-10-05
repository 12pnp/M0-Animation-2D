import type { NodeId } from "@/core/doc/ids";
import type { ColorTransform, Node } from "@/core/doc/types";
import type { ExportDiagnostic } from "@/core/export/diagnostics";
import { lightDarkOf } from "./color";
import type { BoneBurstBlendMode } from "./types";

/* ── colour and blend ────────────────────────────────────────────────────── */
export const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
const hex2 = (v: number) => byte(v).toString(16).padStart(2, "0");
/**
 * The multipliers as "rrggbbaa", or undefined when neutral. The runtime's
 * slot colour multiplies the texture exactly as the stage's multipliers do,
 * quantised to 8 bits per channel by the format.
 */

export function colorHex(c: ColorTransform | undefined): string | undefined {
  if (!c) return undefined;
  const hex = hex2(c.rM / 100) + hex2(c.gM / 100) + hex2(c.bM / 100) + hex2(c.aM / 100);
  return hex === "ffffffff" ? undefined : hex;
}
/**
 * Colour offsets as Spine's two-colour tint. The stage draws
 * `clamp(c·M + O)` per channel; spine-pixi's dark-tint shader draws
 * `(1 − c)·dark + c·light` (straight colour; the batcher scales dark by the
 * slot's alpha and gives it alpha 1). They are equal for every texel c when
 * `dark = O` and `light = M + O`, as long as O is not negative and M + O
 * does not pass full (`tintExact`). The alpha offset is not drawn by the
 * stage either.
 */

export function lightHex(c: ColorTransform): string {
  return lightDarkOf(c).slice(0, 4).map(hex2).join("");
}

export function darkHex(c: ColorTransform): string {
  return lightDarkOf(c).slice(4).map(hex2).join("");
}
/** The seven values an rgba2 curve carries, light rgba then dark rgb. */
export function tintChannels(c: ColorTransform): number[] {
  const h = lightHex(c) + darkHex(c);
  return Array.from({ length: 7 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16) / 255);
}
export function tintExact(c: ColorTransform): boolean {
  return ([["rM", "rO"], ["gM", "gO"], ["bM", "bO"]] as const).every(([m, o]) => c[o] >= 0 && c[m] / 100 + c[o] / 255 <= 1 + 1e-9);
}
export function hasOffsets(c: ColorTransform | undefined): boolean {
  return !!c && (c.rO !== 0 || c.gO !== 0 || c.bO !== 0);
}
export function warnOffsets(node: Node, warned: Set<NodeId>, diags: ExportDiagnostic[]): void {
  if (warned.has(node.id)) return;
  warned.add(node.id);
  diags.push({
    severity: "warning",
    message: `"${node.name}" uses colour offsets Spine's two-colour tint cannot draw exactly (a negative offset, ` +
      "or multiplier plus offset past full): the export clamps them.",
  });
}
const BLEND: Record<NonNullable<Node["blendMode"]>, BoneBurstBlendMode | undefined> = {
  normal: undefined, add: "additive", multiply: "multiply", screen: "screen",
};
export function blendOf(node: Node): BoneBurstBlendMode | undefined {
  return node.blendMode ? BLEND[node.blendMode] : undefined;
}
