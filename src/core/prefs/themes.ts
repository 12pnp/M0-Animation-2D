/**
 * The named interface themes.
 *
 * A theme owns the NEUTRAL chrome and nothing else: surfaces, lines, the
 * button and scrollbar greys, and the text colours on them. Accents, the
 * playhead, the pasteboard and everything the stage draws are preferences
 * (`core/prefs/prefs.ts`), so picking a theme never clobbers a colour the user
 * tuned by hand. The stylesheets read these as CSS custom properties written
 * on the root element by `view/prefs/theme.ts`; the literals in `theme.css`
 * are the DEFAULT theme's values, so the first paint is right before that
 * runs.
 *
 * Pure and DOM-free like the rest of `core/prefs`, so `tests/themes.test.ts`
 * can hold the table to its invariants: every theme defines exactly
 * `THEME_TOKENS`, every value is a canonical colour, and the text stays
 * readable (WCAG ≥ 4.5 for `--fg` and `--fg-strong` on the panel surface —
 * the "vivid font colour" half of the design is a contrast floor, not a
 * hope).
 */

export interface Theme {
  id: string;
  label: string;
  /** CSS custom property → value. Exactly `THEME_TOKENS`, no more. */
  tokens: Readonly<Record<string, string>>;
}

/** The chrome tokens a theme defines. `--bg-stage` is not among them: it is
 *  the `stage.pasteboard` preference. */
export const THEME_TOKENS = [
  "--bg-app", "--bg-menubar", "--bg-rail", "--bg-panel", "--bg-panel-alt",
  "--bg-header", "--bg-field", "--bg-sunken", "--bg-pop",
  "--btn-top", "--btn-bottom", "--scrollbar",
  "--line", "--line-soft", "--line-grid",
  "--fg", "--fg-strong", "--fg-dim", "--fg-disabled",
] as const;

export const THEMES: readonly Theme[] = [
  {
    // The default: a basic-grey-to-dark-grey ramp — window chrome darkest at
    // #1f1f1f, headers up at #3b3b3b — with near-white text on it. The
    // vividness is contrast, not saturation; the teal accent sits on top.
    id: "graphite",
    label: "Graphite",
    tokens: {
      "--bg-app": "#1f1f1f",
      "--bg-menubar": "#262626",
      "--bg-rail": "#2b2b2b",
      "--bg-panel": "#2e2e2e",
      "--bg-panel-alt": "#343434",
      "--bg-header": "#3b3b3b",
      "--bg-field": "#232323",
      "--bg-sunken": "#212121",
      "--bg-pop": "#404040",
      "--btn-top": "#4f4f4f",
      "--btn-bottom": "#424242",
      "--scrollbar": "#4f4f4f",
      "--line": "#171717",
      "--line-soft": "#414141",
      "--line-grid": "#2d2d2d",
      "--fg": "#e3e3e3",
      "--fg-strong": "#ffffff",
      "--fg-dim": "#a6a6a6",
      "--fg-disabled": "#6e6e6e",
    },
  },
  {
    // Animate's palette, as the app shipped before themes existed — kept
    // verbatim (the new tokens map onto the greys that used to be hardcoded
    // in the rules that used them) so it is a choice, not a loss.
    id: "classic",
    label: "Classic (Animate)",
    tokens: {
      "--bg-app": "#2b2b2b",
      "--bg-menubar": "#333333",
      "--bg-rail": "#383838",
      "--bg-panel": "#3c3c3c",
      "--bg-panel-alt": "#414141",
      "--bg-header": "#464646",
      "--bg-field": "#2e2e2e",
      "--bg-sunken": "#333333",
      "--bg-pop": "#4a4a4a",
      "--btn-top": "#5a5a5a",
      "--btn-bottom": "#4c4c4c",
      "--scrollbar": "#5c5c5c",
      "--line": "#2a2a2a",
      "--line-soft": "#4e4e4e",
      "--line-grid": "#383838",
      "--fg": "#cfcfcf",
      "--fg-strong": "#f0f0f0",
      "--fg-dim": "#8f8f8f",
      "--fg-disabled": "#6a6a6a",
    },
  },
  {
    // The same ramp leaned cool: every grey carries a little blue, the text a
    // little of it back. Proof that a theme is a row in this table, not a
    // stylesheet.
    id: "slate",
    label: "Slate",
    tokens: {
      "--bg-app": "#191c21",
      "--bg-menubar": "#1f232a",
      "--bg-rail": "#242932",
      "--bg-panel": "#272c35",
      "--bg-panel-alt": "#2d333e",
      "--bg-header": "#343b47",
      "--bg-field": "#1f232a",
      "--bg-sunken": "#20242b",
      "--bg-pop": "#39404c",
      "--btn-top": "#49515f",
      "--btn-bottom": "#3d4450",
      "--scrollbar": "#49515f",
      "--line": "#14171c",
      "--line-soft": "#3e4552",
      "--line-grid": "#2a2f38",
      "--fg": "#dfe5ee",
      "--fg-strong": "#f4f7fb",
      "--fg-dim": "#98a2b1",
      "--fg-disabled": "#626c7a",
    },
  },
];

export const DEFAULT_THEME_ID: string = THEMES[0]!.id;

export const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

/** The theme by id — the first (default) one for anything unknown, the same
 *  fallback `PREF_ENUMS` gives a bad `fontSize`. */
export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}
