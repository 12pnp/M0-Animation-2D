import type { ColorTransform } from "@/core/doc/types";

/**
 * The editor's colour and Spine's two-colour tint (ARCHITECTURE ▸ Colour,
 * alpha and blend mode). The editor keeps multipliers 0–100 and offsets 0–255;
 * Spine keeps a light and a dark colour, 0..1. Light is multiplier plus
 * offset, dark is the offset: the stage's `clamp(c·M + O)` and Spine's
 * `(1 − c)·dark + c·light` agree for every texel while light stays in range.
 */

/** Light r, g, b, a then dark r, g, b, unclamped. */
export type LightDark = [number, number, number, number, number, number, number];

export function lightDarkOf(c: ColorTransform): LightDark {
  return [
    c.rM / 100 + c.rO / 255, c.gM / 100 + c.gO / 255, c.bM / 100 + c.bO / 255, c.aM / 100,
    c.rO / 255, c.gO / 255, c.bO / 255,
  ];
}

/** Light and dark back as the editor's colour: multipliers light − dark, offsets dark. */
export function colorOfLightDark(r: number, g: number, b: number, a: number, dr: number, dg: number, db: number): ColorTransform {
  return { rM: (r - dr) * 100, gM: (g - dg) * 100, bM: (b - db) * 100, aM: a * 100, rO: dr * 255, gO: dg * 255, bO: db * 255, aO: 0 };
}
