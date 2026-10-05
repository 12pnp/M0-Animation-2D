# Theme plan — grey chrome, vivid text, named themes

The editor's chrome moves from Animate's mid-grey (`#2b2b2b`–`#535353`) to a
**basic-grey-to-dark-grey ramp**, with **brighter, higher-contrast text** on it, and
what is today one hardcoded palette becomes **named themes the user can pick** in
Preferences ▸ Interface.

## Decisions

- **A theme owns the neutral chrome only.** Surfaces, lines, button/scrollbar
  greys and the four text colours are the theme. The accent colours, the
  playhead, the pasteboard, rulers and everything the stage draws stay
  **preferences** — switching a theme must not clobber colours the user tuned by
  hand, and half the stage palette is translucent by design (`rgba()`), which a
  theme picker is the wrong tool for.
- **Graphite is the new default**, and it is the grey-to-dark-grey ramp with
  vivid text the request asks for. **Classic** keeps today's palette verbatim
  (minus nothing) so nobody loses the look they had. **Slate** is a third, cool
  blue-grey one, to prove the table rather than the stylesheets is where a theme
  lives.
- **The theme table is pure and lives in `core/`**
  (`core/prefs/themes.ts`): DOM-free, so the merge, the fallback and the
  contrast floor are table-tested the way `mergePrefs` is. `applyTheme` writes
  its tokens on the root element first, then the preference-derived tokens, so
  a preference always wins where the two could ever overlap.
- **First paint stays stylesheet-only.** The `:root` literals in `theme.css`
  are Graphite's values — the same numbers as `THEMES[0]` — so the app is
  already correctly themed before `applyTheme` runs, exactly as the accent
  literals already mirror `DEFAULT_PREFS.interface`.
- **Hardcoded chrome greys in the other stylesheets become tokens** so a theme
  actually re-skins the whole app: popup menus, toasts and the color-picker
  swatches (`--bg-pop`), the `.btn` gradient (`--btn-top` / `--btn-bottom`),
  the scrollbar thumb (`--scrollbar`), every `#262626` input border
  (`--line`), the icon-button greys (`--fg`), the timeline zoom thumb, the
  active-tool chip. Hover/active states move to `filter: brightness()` so they
  follow whatever background the cascade picked. Semantic colours — error
  reds, the recovery bar, IK greens/blues, checkerboards, the AI status dots —
  are deliberately NOT themed.
- **A contrast floor is a test, not a hope.** Every theme must keep `--fg` and
  `--fg-strong` at WCAG ≥ 4.5 on `--bg-panel`, and `--fg-dim` ≥ 3: the "vivid
  font colour" half of the request can't silently regress when a fourth theme
  is added later.

## The token set

Nineteen tokens; a theme defines exactly these, no more, no less (also tested):

| Token | Graphite (default) | Classic | Slate |
|---|---|---|---|
| `--bg-app` | `#1f1f1f` | `#2b2b2b` | `#191c21` |
| `--bg-menubar` | `#262626` | `#333333` | `#1f232a` |
| `--bg-rail` | `#2b2b2b` | `#383838` | `#242932` |
| `--bg-panel` | `#2e2e2e` | `#3c3c3c` | `#272c35` |
| `--bg-panel-alt` | `#343434` | `#414141` | `#2d333e` |
| `--bg-header` | `#3b3b3b` | `#464646` | `#343b47` |
| `--bg-field` | `#232323` | `#2e2e2e` | `#1f232a` |
| `--bg-sunken` | `#212121` | `#333333` | `#20242b` |
| `--bg-pop` | `#404040` | `#4a4a4a` | `#39404c` |
| `--btn-top` | `#4f4f4f` | `#5a5a5a` | `#49515f` |
| `--btn-bottom` | `#424242` | `#4c4c4c` | `#3d4450` |
| `--scrollbar` | `#4f4f4f` | `#5c5c5c` | `#49515f` |
| `--line` | `#171717` | `#2a2a2a` | `#14171c` |
| `--line-soft` | `#414141` | `#4e4e4e` | `#3e4552` |
| `--line-grid` | `#2d2d2d` | `#383838` | `#2a2f38` |
| `--fg` | `#e3e3e3` | `#cfcfcf` | `#dfe5ee` |
| `--fg-strong` | `#ffffff` | `#f0f0f0` | `#f4f7fb` |
| `--fg-dim` | `#a6a6a6` | `#8f8f8f` | `#98a2b1` |
| `--fg-disabled` | `#6e6e6e` | `#6a6a6a` | `#626c7a` |

Graphite's ramp: window chrome darkest (`#1f1f1f`), panels `#2e2e2e`, headers
`#3b3b3b` — and the text on it near-white (`#e3e3e3` body, pure white for
titles and values), which is where the vividness comes from: contrast, not
saturation, with the existing vivid teal accent untouched on top.

`--bg-stage` (the pasteboard) stays out of the table: it is the
`stage.pasteboard` preference and keeps its `#535353` default across themes —
already a "basic grey", and the one surface users most often want under their
own control.

## Files

- **Add** `src/core/prefs/themes.ts` — `Theme`, `THEMES`, `THEME_TOKENS`,
  `themeById` (unknown id falls back to the default, like `PREF_ENUMS`).
- **Add** `tests/themes.test.ts` — token completeness, canonical notation,
  contrast floors, fallback, and that the `theme.css` `:root` literals equal
  the default theme's tokens (the first-paint invariant).
- **Change** `src/core/prefs/prefs.ts` — `interface.theme: string`, default
  `"graphite"`, in `PREF_ENUMS`.
- **Change** `src/core/prefs/color.ts` — export `contrastRatio` (the private
  WCAG arithmetic behind `inkOn`) so the test doesn't re-derive it.
- **Change** `src/view/prefs/theme.ts` — write the theme's tokens, then the
  preference tokens.
- **Change** `src/view/prefs/SettingsDialog.ts` — a Theme select at the top of
  Interface ▸ Appearance; the accent swatches below it unchanged.
- **Change** the four stylesheets — Graphite literals in `theme.css`, and the
  hardcoded chrome greys in `layout.css`, `panels.css`, `settings.css`,
  `timeline.css` become the tokens above.

## Migration

Nothing to migrate: `mergePrefs` overlays the stored blob on the defaults, a
blob written before this change has no `interface.theme`, and every existing
user wakes up on Graphite — which is the point of "full change". A stored
unknown theme id (a build from the future, a hand edit) falls back to Graphite
through `PREF_ENUMS`, the same way a bad `fontSize` does.

## Not in this change

Canvas colours (`overlayColors.ts`, the timeline frame grid's palette) follow
their own preferences, and a light theme would need `color-scheme` work plus a
second ink set — neither is required by the grey-to-dark-grey brief.
