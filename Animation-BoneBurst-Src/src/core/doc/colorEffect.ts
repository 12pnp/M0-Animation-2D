import { type ColorTransform, isDefaultColor } from "./types";

/** The views the Properties panel's Colour Effect offers onto a colour. */
export type ColorMode = "none" | "alpha" | "brightness" | "tint" | "advanced";

/** Which view of a ColorTransform best explains the value already stored. */
export function deriveColorMode(c: ColorTransform, isInstance: boolean): ColorMode {
  if (isDefaultColor(c)) return "none";
  const grey = c.rM === c.gM && c.gM === c.bM;
  if (c.rM === 100 && grey) return "alpha";
  if (isInstance) return "alpha";
  if (c.aM === 100 && grey) return "brightness";
  return "advanced";
}
export function colorToHex(c: ColorTransform): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round((v / 100) * 255))).toString(16).padStart(2, "0");
  return `#${ch(c.rM)}${ch(c.gM)}${ch(c.bM)}`;
}
export function hexToPct(hex: string): { r: number; g: number; b: number; } {
  const n = parseInt(hex.slice(1), 16);
  const pc = (v: number) => Math.round((v / 255) * 100);
  return { r: pc((n >> 16) & 255), g: pc((n >> 8) & 255), b: pc(n & 255) };
}
