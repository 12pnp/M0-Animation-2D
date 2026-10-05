import type { Node } from "@/core/doc/types";
import type { BoneBurstRaw } from "./types";

export const obj = (v: unknown): v is BoneBurstRaw => !!v && typeof v === "object" && !Array.isArray(v);
export const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
export const str = (v: unknown): v is string => typeof v === "string";
export function displayNames(node: Node): string[] {
  const out: string[] = [];
  if (node.attachment || node.key) out.push(node.attachment?.name ?? node.key!);
  for (const d of node.extraDisplays ?? []) out.push(d.attachment?.name ?? d.key ?? "");
  return out;
}
export function pick(o: BoneBurstRaw, keep: (k: string) => boolean): BoneBurstRaw | null {
  const out: BoneBurstRaw = {};
  for (const [k, v] of Object.entries(o)) if (keep(k)) out[k] = v;
  return Object.keys(out).length ? out : null;
}
