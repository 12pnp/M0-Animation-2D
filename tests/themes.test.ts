import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contrastRatio, formatColor, parseColor } from "@/core/prefs/color";
import {
  DEFAULT_THEME_ID, THEMES, THEME_IDS, THEME_TOKENS, themeById,
} from "@/core/prefs/themes";

/**
 * The themes are a table, so the table's invariants can be tested the way
 * `mergePrefs`'s are. These are the guards that keep a FOURTH theme honest:
 * one that forgets a token half-reverts to the stylesheet's default mid-grey,
 * and one whose text drops under the contrast floor quietly undoes the
 * "vivid text on grey chrome" the default exists for.
 */

const root = (t: (typeof THEMES)[number]) => t.tokens;

describe("the theme table", () => {
  it("has unique ids, and the default is the first one", () => {
    expect(new Set(THEME_IDS).size).toBe(THEMES.length);
    expect(DEFAULT_THEME_ID).toBe(THEMES[0]!.id);
    expect(THEME_IDS).toContain(DEFAULT_THEME_ID);
  });

  it("defines exactly the chrome tokens — no more, no less", () => {
    const canon = [...THEME_TOKENS].sort();
    for (const t of THEMES) {
      expect(Object.keys(t.tokens).sort(), t.id).toEqual(canon);
    }
  });

  it("writes every value in canonical #rrggbb, parseable by the one parser", () => {
    for (const t of THEMES) {
      for (const [token, value] of Object.entries(root(t))) {
        expect(formatColor(parseColor(value)), `${t.id} ${token}`).toBe(value);
      }
    }
  });

  it("keeps the text vivid on the panel surface: fg and fg-strong at WCAG ≥ 4.5, fg-dim ≥ 3", () => {
    for (const t of THEMES) {
      const panel = root(t)["--bg-panel"]!;
      expect(contrastRatio(root(t)["--fg"]!, panel), `${t.id} --fg`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(root(t)["--fg-strong"]!, panel), `${t.id} --fg-strong`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(root(t)["--fg-dim"]!, panel), `${t.id} --fg-dim`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps inputs and wells sunk below the panel, headers above it", () => {
    for (const t of THEMES) {
      // Distance from white, not a channel: Slate's greys carry blue, so no
      // single channel ranks them.
      const dark = (tok: string) => contrastRatio("#ffffff", root(t)[tok]!);
      expect(dark("--bg-field"), `${t.id} field`).toBeGreaterThan(dark("--bg-panel"));
      expect(dark("--bg-header"), `${t.id} header`).toBeLessThan(dark("--bg-panel"));
    }
  });

  it("falls back to the default theme for an unknown id", () => {
    expect(themeById("classic").id).toBe("classic");
    expect(themeById("neon").id).toBe(DEFAULT_THEME_ID);
    expect(themeById("").id).toBe(DEFAULT_THEME_ID);
  });
});

describe("the theme.css first paint", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../src/styles/theme.css", import.meta.url)), "utf8");

  /** The `:root` block only — the pre-script defaults, not later rules. */
  const block = css.slice(0, css.indexOf("color-scheme"));

  it("declares every chrome token at the DEFAULT theme's value", () => {
    // theme.css's own comment promises this: the literals are what the first
    // frame is painted with, before applyTheme runs. A literal left at an old
    // palette is a flash of the wrong theme on every launch.
    for (const [token, value] of Object.entries(root(THEMES[0]!))) {
      const re = new RegExp(`${token.replace(/-/g, "\\-")}:\\s*(#[0-9a-f]{6});`);
      expect(block.match(re)?.[1], token).toBe(value);
    }
  });
});
