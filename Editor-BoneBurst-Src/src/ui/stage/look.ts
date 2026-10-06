import type { PreferenceValues } from "../preferences";

/** A colour as 0..1 channels. */
export type Rgb = readonly [number, number, number];

/**
 * What the stage draws behind the skeleton, as the renderer takes it: the checkerboard (square size
 * in units, null when off, its colour or null for the one that shows on the background), the centre
 * axes (colours, thickness in screen pixels), and the grid lines' colour (null: automatic) and
 * thickness. The grid's own spacing and on/off stay with the grid argument.
 */
export interface StageLook {
  readonly checker: number | null;
  readonly checkerColour: Rgb | null;
  readonly axes: boolean;
  readonly axisX: Rgb;
  readonly axisY: Rgb;
  readonly axisPx: number;
  readonly gridColour: Rgb | null;
  readonly gridPx: number;
}

export const NO_LOOK: StageLook = { checker: null, checkerColour: null, axes: false, axisX: [0.9, 0.3, 0.3], axisY: [0.3, 0.8, 0.4], axisPx: 1, gridColour: null, gridPx: 1 };

/** `#rrggbb` as channels; null for "auto" or anything that is not a colour. */
export function rgbOf(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The look the preferences ask for. */
export function lookOf(p: PreferenceValues): StageLook {
  return {
    checker: p.checker ? p.gridSize : null,
    checkerColour: rgbOf(p.checkerColour),
    axes: p.axes,
    axisX: rgbOf(p.axisXColour) ?? NO_LOOK.axisX,
    axisY: rgbOf(p.axisYColour) ?? NO_LOOK.axisY,
    axisPx: p.axisThickness,
    gridColour: rgbOf(p.gridColour),
    gridPx: p.gridThickness,
  };
}
