import type { Rgb, StageLook } from "./look";

/** The step of a checkerboard or grid at a zoom: grown by fives until a cell is at least `minPx` pixels (as the Stage's renderer does). */
export function cellStep(cell: number, pxPerUnit: number, minPx: number): number {
  // No scale to grow by (a panel with no room, or a cell that is not a size): the cell as it is, rather than a loop that never ends.
  if (!(pxPerUnit > 0) || !Number.isFinite(pxPerUnit) || !(cell > 0)) return cell;
  let step = cell;
  while (step * pxPerUnit < minPx) step *= 5;
  return step;
}

/** What a canvas backdrop is drawn from: the world's view of the canvas, and the Stage's settings. */
export interface Backdrop {
  /** The canvas's size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** World x and y at the canvas's left/top and right/bottom (y up, so `top` is the larger). */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  /** Pixels per world unit. */
  readonly scale: number;
  readonly look: StageLook;
  /** The grid's spacing in units, or null when it is off. */
  readonly grid: number | null;
  /** The Stage's background colour (CSS), and whether it is light (so lines and squares go dark). */
  readonly background: string;
  readonly light: boolean;
}

const css = (c: Rgb, a: number) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;

/**
 * The Stage's own background on a 2D canvas, so a panel that shows the rig reads like the Stage: the
 * background colour, the checkerboard (squares of the grid's size; faint, in the colour that shows),
 * the grid lines (every fifth stronger), and the centre axes (the x axis red-ish, the y axis, as set).
 * The same look settings drive both.
 */
export function drawBackdrop(g: CanvasRenderingContext2D, b: Backdrop): void {
  g.save();
  g.fillStyle = b.background;
  g.fillRect(0, 0, b.width, b.height);
  if (!(b.scale > 0) || !Number.isFinite(b.scale) || ![b.left, b.right, b.top, b.bottom].every(Number.isFinite)) { g.restore(); return; }
  const px = (x: number) => (x - b.left) * b.scale, py = (y: number) => (b.top - y) * b.scale;
  const auto: Rgb = b.light ? [0, 0, 0] : [1, 1, 1];
  if (b.look.checker) {
    const cell = cellStep(b.look.checker, b.scale, 8), c0 = Math.floor(b.left / cell), c1 = Math.ceil(b.right / cell), r0 = Math.floor(b.bottom / cell), r1 = Math.ceil(b.top / cell);
    g.fillStyle = css(b.look.checkerColour ?? auto, 18 / 255);
    // Squares of alternate parity, as the renderer's repeating 2x2 pattern puts them.
    if ((c1 - c0) * (r1 - r0) < 40000) {
      for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) if (((c + r) & 1) === 1) g.fillRect(px(c * cell), py((r + 1) * cell), cell * b.scale, cell * b.scale);
    }
  }
  if (b.grid) {
    const step = cellStep(b.grid, b.scale, 6), colour = b.look.gridColour ?? auto, lw = Math.max(0.5, b.look.gridPx);
    const strength = (v: number) => (Math.abs(v) < step / 2 ? 0 : Math.round(v / step) % 5 === 0 ? 0.18 : 0.08);
    g.lineWidth = lw;
    for (let x = Math.ceil(b.left / step) * step; x <= b.right; x += step) {
      const a = strength(x);
      if (a) { g.strokeStyle = css(colour, a); g.beginPath(); g.moveTo(Math.round(px(x)) + 0.5, 0); g.lineTo(Math.round(px(x)) + 0.5, b.height); g.stroke(); }
    }
    for (let y = Math.ceil(b.bottom / step) * step; y <= b.top; y += step) {
      const a = strength(y);
      if (a) { g.strokeStyle = css(colour, a); g.beginPath(); g.moveTo(0, Math.round(py(y)) + 0.5); g.lineTo(b.width, Math.round(py(y)) + 0.5); g.stroke(); }
    }
  }
  if (b.look.axes) {
    g.lineWidth = Math.max(0.5, b.look.axisPx);
    const ox = px(0), oy = py(0);
    if (oy >= 0 && oy <= b.height) { g.strokeStyle = css(b.look.axisX, 0.7); g.beginPath(); g.moveTo(0, oy); g.lineTo(b.width, oy); g.stroke(); }
    if (ox >= 0 && ox <= b.width) { g.strokeStyle = css(b.look.axisY, 0.7); g.beginPath(); g.moveTo(ox, 0); g.lineTo(ox, b.height); g.stroke(); }
  }
  g.restore();
}
