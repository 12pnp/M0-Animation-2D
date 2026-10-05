import type { Rgba } from "./rigTypes";

export type Json = Record<string, unknown>;
export const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
export const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
export const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
/** "rrggbbaa" or "rrggbb" as 0..1 channels; alpha 1 when absent. */

export function parseColor(hex: unknown, fallback: Rgba = [1, 1, 1, 1]): Rgba {
  if (typeof hex !== "string" || hex.length < 6) return [...fallback] as Rgba;
  const c = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [c(0), c(2), c(4), hex.length >= 8 ? c(6) : 1];
}
