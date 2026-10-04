import { describe, it, expect } from "vitest";
import {
  UI_FONT_FAMILIES, UI_FONT_SIZES, UI_FONT_SCALES, cleanFontName, fontStack, setUiFontFamily, uiFont, uiFontStack, uiPx,
} from "@/core/prefs/fonts";
import { DEFAULT_PREFS, mergePrefs } from "@/core/prefs/prefs";

/** The bases the app actually uses: the CSS size tokens, the row heights and
 *  the canvas labels. */
const BASES = [7, 8, 9, 10, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 24, 26];

describe("the UI text scale", () => {
  it("leaves every measure untouched at the default", () => {
    expect(DEFAULT_PREFS.interface.fontSize).toBe("small");
    expect(UI_FONT_SCALES.small).toBe(1);
    for (const base of BASES) expect(uiPx(base, "small")).toBe(base);
  });

  it("grows step by step and never goes illegible", () => {
    for (const base of BASES) {
      const [tiny, small, medium, large] = UI_FONT_SIZES.map((s) => uiPx(base, s));
      expect(tiny!).toBeLessThanOrEqual(small!);
      expect(small!).toBeLessThanOrEqual(medium!);
      expect(medium!).toBeLessThanOrEqual(large!);
      expect(tiny!).toBeGreaterThanOrEqual(6);
    }
    expect(uiPx(7, "tiny")).toBe(6);
  });

  it("builds a canvas font string, with and without a weight", () => {
    expect(uiFont(9, "small")).toMatch(/^9px /);
    expect(uiFont(10, "large", 600)).toMatch(/^600 13px /);
  });
});

describe("Interface ▸ Text ▸ Font", () => {
  it("defaults to the bundled JetBrains Mono", () => {
    expect(DEFAULT_PREFS.interface.fontFamily).toBe("jetbrains");
    expect(fontStack("jetbrains")).toMatch(/^'JetBrains Mono Variable'/);
  });

  it("every choice is a stack that ends in a generic family", () => {
    for (const f of UI_FONT_FAMILIES) expect(f.stack).toMatch(/(sans-serif|monospace)$/);
  });

  it("the canvases draw with the chosen family", () => {
    setUiFontFamily("inter");
    expect(uiFont(9, "small")).toBe(`9px ${fontStack("inter")}`);
    expect(uiFontStack()).toBe(fontStack("inter"));
    setUiFontFamily("jetbrains");
    expect(uiFont(9, "small")).toBe(`9px ${fontStack("jetbrains")}`);
  });

  it("Custom puts the typed font first, cleaned so it cannot break the CSS", () => {
    expect(fontStack("custom", "Avenir Next")).toBe(`'Avenir Next', ${fontStack("system")}`);
    expect(fontStack("custom", "Evil'; } body { x")).toMatch(/^'Evil body x', /);
    expect(cleanFontName("  Noto  Sans  Thai ")).toBe("Noto Sans Thai");
    // Nothing typed yet: the system font.
    expect(fontStack("custom", "  ")).toBe(fontStack("system"));
  });

  it("a stored family is kept, an unknown one falls back to the default", () => {
    expect(mergePrefs({ interface: { fontFamily: "inter" } }).interface.fontFamily).toBe("inter");
    // Choices that were dropped, or never existed.
    expect(mergePrefs({ interface: { fontFamily: "classic" } }).interface.fontFamily).toBe("jetbrains");
    expect(mergePrefs({ interface: { fontFamily: "Comic Sans" } }).interface.fontFamily).toBe("jetbrains");
  });
});
