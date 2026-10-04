/**
 * The UI text scale — Photoshop's four steps, under Interface ▸ Text.
 *
 * This sizes TEXT, not the whole interface: the measures that grow are the
 * font sizes and the heights of the rows built to hold them. Icons, the tool
 * rail and hairlines keep their pixel sizes, because scaling those means
 * redrawing every SVG. Unlike Photoshop the change is immediate — every
 * consumer already listens to `prefs`.
 *
 * Pure and DOM-free: `view/prefs/theme.ts` turns these numbers into CSS
 * tokens and the canvases build their `ctx.font` from them.
 */

export type UiFontSize = "tiny" | "small" | "medium" | "large";

export const UI_FONT_SIZES: readonly UiFontSize[] = ["tiny", "small", "medium", "large"];

/** `small` is exactly 1, so the default moves nothing by a single pixel. */
export const UI_FONT_SCALES: Record<UiFontSize, number> = {
  tiny: 0.85,
  small: 1,
  medium: 1.15,
  large: 1.3,
};

/** Rounded to the pixel — at 11px a fraction is visible — and never illegible. */
export function uiPx(base: number, size: UiFontSize): number {
  return Math.max(6, Math.round(base * UI_FONT_SCALES[size]));
}

/**
 * The typeface of the whole UI, Interface ▸ Text ▸ Font. Only JetBrains Mono
 * is bundled (`@fontsource-variable/jetbrains-mono`, loaded by main.ts); the
 * others are what every system already has, so none needs the network.
 */
export type UiFontFamily = "jetbrains" | "system" | "classic" | "systemMono";

export const UI_FONT_FAMILIES: ReadonlyArray<{ id: UiFontFamily; label: string; stack: string }> = [
  { id: "jetbrains", label: "JetBrains Mono", stack: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace" },
  { id: "system", label: "System", stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  // What the interface used before JetBrains Mono.
  { id: "classic", label: "Classic (Helvetica)", stack: "'Helvetica Neue', -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { id: "systemMono", label: "System monospace", stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
];

export const UI_FONT_FAMILY_IDS: readonly UiFontFamily[] = UI_FONT_FAMILIES.map((f) => f.id);

export function fontStack(id: UiFontFamily): string {
  return (UI_FONT_FAMILIES.find((f) => f.id === id) ?? UI_FONT_FAMILIES[0]!).stack;
}

/**
 * The family the canvases draw with. A canvas inherits nothing from CSS, so
 * `applyTheme` sets this beside `--font-family`; every canvas repaints on a
 * preferences change and picks it up.
 */
let currentStack = fontStack("jetbrains");
export function setUiFontFamily(id: UiFontFamily): void { currentStack = fontStack(id); }
export function uiFontStack(): string { return currentStack; }

/** The `ctx.font` string for a canvas that cannot inherit anything. */
export function uiFont(base: number, size: UiFontSize, weight?: number): string {
  const px = `${uiPx(base, size)}px ${currentStack}`;
  return weight ? `${weight} ${px}` : px;
}
