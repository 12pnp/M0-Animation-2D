import type { Prefs } from "@/core/prefs/prefs";
import { inkOn, rgbTriplet } from "@/core/prefs/color";
import { fontStack, setUiFontFamily, UI_FONT_SCALES, uiPx } from "@/core/prefs/fonts";
import { themeById } from "@/core/prefs/themes";

/**
 * The handful of preferences that are CSS rather than canvas.
 *
 * `theme.css` declares every surface, size and measure as a token precisely so
 * the whole app can be re-skinned from one block; writing those tokens on the
 * root element is therefore the entire implementation — no stylesheet is
 * rebuilt and nothing reloads. The canvas palette is a separate concern, in
 * `overlayColors.ts`.
 *
 * The chosen theme's neutral chrome (`core/prefs/themes.ts`) goes on FIRST, so
 * the preference values written after it — which are the user's, not the
 * theme's — win wherever the two could ever overlap. The theme owns surfaces,
 * lines and text; accents, the playhead and the pasteboard are preferences, so
 * switching a theme leaves a hand-tuned palette alone.
 *
 * Four of the tokens are DERIVED and have no preference of their own: the two
 * `-rgb` triplets that `rgba(var(--accent-rgb), α)` needs, and the two inks,
 * which flip to white on a dark accent. They used to be literals in the
 * stylesheet, so changing the accent left the selected rows, the scrubbable
 * numbers and the splitter's hover behind at the previous palette.
 *
 * The text scale is one number, `--ui-scale`, and every size token in
 * `theme.css` is a `calc()` on it — so the default (`small`, scale 1) is
 * exactly the literal each one always was, and the stylesheet alone is right
 * before this ever runs. The named sizes are then re-published ROUNDED, because
 * the frame grid computes its row and ruler heights from the same scale in
 * `uiPx`, and a canvas drawing 29px against a DOM row of 28.6px is a
 * half-pixel seam down the middle of the timeline.
 */
export function applyTheme(prefs: Prefs): void {
  const root = document.documentElement.style;
  const { theme, accent, accentRow, accentHot, accentBlue, setup, warn, fontSize, fontFamily, fontCustom } = prefs.interface;

  for (const [token, value] of Object.entries(themeById(theme).tokens)) {
    root.setProperty(token, value);
  }

  root.setProperty("--accent", accent);
  root.setProperty("--accent-rgb", rgbTriplet(accent));
  root.setProperty("--accent-ink", inkOn(accent));
  root.setProperty("--accent-row", accentRow);
  root.setProperty("--accent-row-ink", inkOn(accentRow));
  root.setProperty("--accent-hot", accentHot);
  root.setProperty("--accent-hot-rgb", rgbTriplet(accentHot));
  root.setProperty("--accent-blue", accentBlue);
  root.setProperty("--setup", setup);
  root.setProperty("--warn", warn);

  root.setProperty("--playhead", prefs.timeline.playhead);
  // The stage's bone colours, for the Outline's icons and lines.
  root.setProperty("--bone", prefs.gizmos.bone);
  root.setProperty("--bone-ik", prefs.gizmos.boneIk);
  root.setProperty("--ik-target", prefs.gizmos.ikTarget);
  root.setProperty("--bg-stage", prefs.stage.pasteboard);

  root.setProperty("--font-family", fontStack(fontFamily, fontCustom));
  setUiFontFamily(fontFamily, fontCustom);
  root.setProperty("--ui-scale", String(UI_FONT_SCALES[fontSize]));
  for (const [token, base] of SIZE_TOKENS) {
    root.setProperty(token, `${uiPx(base, fontSize)}px`);
  }
}

/** Token and its unscaled value — the same pairs as the `calc()`s in
 *  `theme.css`, which stay there as the pre-script defaults. */
const SIZE_TOKENS: ReadonlyArray<readonly [string, number]> = [
  ["--h-menubar", 26], ["--h-tabstrip", 23], ["--h-section", 22],
  ["--h-row", 22], ["--h-field", 18],
  ["--fs-xxs", 7], ["--fs-xs", 9], ["--fs-sm", 10], ["--fs", 11],
  ["--fs-lg", 12], ["--fs-xl", 13], ["--fs-mono", 10],
];
