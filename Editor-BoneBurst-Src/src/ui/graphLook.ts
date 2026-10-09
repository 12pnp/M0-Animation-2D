/**
 * The colours a graph canvas is painted in (docs/HYBRID-THEME-PLAN.md): the Timeline's curve graph and Motion Path's speed graph.
 * The theme's own, unless the theme gives graphs a background of their own (`--graph-bg`, Preferences ▸ Graph background colour);
 * then the lines, muted text and text are ones that read on that background, light or dark, whatever the rest of the editor is.
 */

/** Lines and text for a light graph background, and for a dark one: the built-in themes' own, the lines a step stronger. */
const ON_LIGHT: Readonly<Record<string, string>> = { "--line": "#a3a39e", "--muted": "#55554f", "--text": "#1d1d1b", "--bg": "#bdbdb8", "--hover": "#c6c6c2" };
const ON_DARK: Readonly<Record<string, string>> = { "--line": "#4a4a4a", "--muted": "#9a9a95", "--text": "#e6e6e3", "--bg": "#1e1e1e", "--hover": "#3a3a3a" };

/** Whether a #rrggbb colour is light (its luma over half). */
export function isLight(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return false;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((h) => parseInt(h, 16));
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 127.5;
}

/** A reader of CSS colours for a graph: `--panel` is the graph's background, and with a background of its own the lines and text read on it. */
export function graphColours(css: CSSStyleDeclaration): (name: string) => string {
  const theme = (n: string): string => css.getPropertyValue(n).trim();
  const bg = theme("--graph-bg");
  if (!bg) return theme;
  const ink = isLight(bg) ? ON_LIGHT : ON_DARK;
  return (n) => (n === "--panel" ? bg : ink[n] ?? theme(n));
}

/** The slowest speed a key has (keySpeed.ts's SPEED_MIN): where the curve is fully red. */
const SLOWEST = -0.99;

/** The speed curve's colours away from the even pace (CURVES-PANEL-PLAN step 7): faster, a bright green; slower, red. */
const FAST_GREEN = "#3dff7a", SLOW_RED = "#ff3b30";
/** How far toward green a speed goes: all the way at 2 (three times the even pace). */
const FULL_FAST = 2;

/** The speed curve's colour at speed `v`: `base` at 0, toward bright green above (full at FULL_FAST), toward red below (full at SLOWEST). */
export function speedColour(base: string, v: number): string {
  const to = v >= 0 ? FAST_GREEN : SLOW_RED, t = v >= 0 ? Math.min(1, v / FULL_FAST) : Math.min(1, v / SLOWEST);
  const rgb = (hex: string): number[] => { const m = /^#([0-9a-f]{6})$/i.exec(hex.trim()); const n = m ? parseInt(m[1]!, 16) : 0xff9f1c; return [n >> 16, (n >> 8) & 255, n & 255]; };
  const a = rgb(base), b = rgb(to);
  return `#${a.map((c, k) => Math.round(c + (b[k]! - c) * t).toString(16).padStart(2, "0")).join("")}`;
}
