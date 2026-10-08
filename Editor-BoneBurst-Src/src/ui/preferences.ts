/**
 * The editor's preferences (E4-PLAN step 10): how it looks and behaves for this person, never what
 * a document means. Kept in the browser's storage, versioned; what does not read is the default.
 * No DOM here: the storage is passed in, so vitest drives it.
 */

/** The theme in use: "system" (the built-in Light or Dark, by the operating system) or the id of a theme profile. */
export type Theme = string;
/** The page's colour scheme a theme profile starts from. */
export type ThemeBase = "light" | "dark";

export interface PreferenceValues {
  readonly theme: Theme;
  readonly rulers: boolean;
  /** The interface's size, in percent of the browser's own (UI_SCALE_RANGE): 95 draws everything a twentieth smaller. */
  readonly uiScale: number;
  /** The interface's text size (the page's base font: 12, 13 or 14 px). */
  readonly fontSize: FontSize;
  /** The stage's tool panels' text labels: always, never, or hidden when the stage is narrow. */
  readonly toolbarLabels: ToolbarLabels;
  /** Where the stage's tool panels sit along the stage's foot. */
  readonly toolbarPosition: ToolbarPosition;
  /** What ⌘S (Save) writes: a copy kept in this browser (restored from the bar when the editor opens), or the project's file. Save Project As… always writes a file. */
  readonly saveTo: SaveTo;
  /** The height of a row in the timeline and graph, in pixels. */
  /** Timeline ticks and labels in a 1-2-5 series (1, 2, 5, 10, 20, 50), instead of the frame-rate divisors (10, 15, 30, 60). */
  readonly fewerTicks: boolean;
  /** The frame rate a new project starts with. */
  readonly defaultFps: number;
  /** The rig tree's names and icons in each bone's colour. */
  readonly treeColours: boolean;
  /** The rig tree's indent for each level, in pixels. */
  readonly treeIndent: number;
  /** The indent guide lines in the rig tree: a colour, or "auto" for the theme's line colour. */
  readonly treeGuideColour: string;
  /** The transform, space and show panels over the stage's foot. */
  readonly stagePanels: boolean;
  /** The editor goes full screen (the browser hides its address and tab bars) on the first click or key in the page; View ▸ Full Screen toggles it any time. */
  readonly fullScreenOnStart: boolean;
  /** The colour bones are drawn in on the stage ("#rrggbb", or "auto" for the theme's); a bone with a colour of its own keeps it. */
  readonly boneColour: string;
  /** How big bones are drawn, a multiple of the default (BONE_SIZE_RANGE). */
  readonly boneSize: number;
  /** The highlight of the selected bone and its gizmo ("#rrggbb", or "auto" for the theme's accent). */
  readonly selectedBoneColour: string;
  readonly bones: boolean;
  /** The Stage's Select / Names columns (the Select · Visible · Names matrix): what a press picks, and whether bones show their names. Visible is `bones` and `constraints`. */
  readonly boneSelect: boolean;
  readonly imageSelect: boolean;
  readonly otherSelect: boolean;
  readonly boneNames: boolean;
  /** A bone or image picked on the stage glows for 0.4 s. */
  readonly pickGlow: boolean;
  /** Bone options ▸ Compensate: a moved bone's children keep their place (Pose mode). */
  readonly compensate: boolean;
  /** Constraints drawn on the stage (E4 step 12). */
  readonly constraints: boolean;
  /** While an animation is shown, the bones an IK constraint drives are neither drawn nor picked: they are not animated. */
  readonly hideIkBones: boolean;
  /** The rulers' background: "#rrggbb" or "auto" (the panel colour), and how opaque (0 = invisible, the default). Their ticks and numbers always show. */
  readonly rulerColour: string;
  readonly rulerOpacity: number;
  /** The rulers' numbers and ticks: "#rrggbb" or "auto" (the theme's text colour). */
  readonly rulerTextColour: string;
  /** Undo steps kept; the next document opened takes it. */
  readonly undoSteps: number;
  /** New reference images' opacity, 0..1. */
  readonly referenceOpacity: number;
  /** Connected to the AI bridge (E5 step 2): the toolbar's AI button. */
  readonly ai: boolean;
  /** A recovery copy of unsaved work kept in the browser (E6 step 4a), every `autosaveSeconds`. */
  readonly autosave: boolean;
  readonly autosaveSeconds: number;
  /** Onion skin (E6 step 4d): on, how many frames before and after, keyed frames only, colour-coded. */
  readonly onion: boolean;
  readonly onionBefore: number;
  readonly onionAfter: number;
  readonly onionKeyedOnly: boolean;
  readonly onionColour: boolean;
  /** The grid and snapping (E6 step 4e): the grid shown and its spacing; snapping on, and what it snaps to. */
  readonly grid: boolean;
  /** The stage behind the skeleton: a checkerboard of grid-sized squares, and the centre x and y axes. */
  readonly checker: boolean;
  readonly axes: boolean;
  /** Colours ("#rrggbb", or "auto" for the one that shows on the background) and thickness (screen pixels) of what the stage draws behind the skeleton. */
  readonly checkerColour: string;
  readonly gridColour: string;
  readonly gridThickness: number;
  readonly axisXColour: string;
  readonly axisYColour: string;
  readonly axisThickness: number;
  /** The panel tabs' colours ("#rrggbb", or "auto" for the theme's): the bar behind the tabs, and the tab shown. */
  readonly tabBarColour: string;
  readonly tabActiveColour: string;
  /** The tab text ("#rrggbb", or "auto" for the theme's): the shown tab's, and the other tabs'. */
  readonly tabTextColour: string;
  readonly tabDimTextColour: string;
  readonly gridSize: number;
  /** What an arrow key adds to the chosen tool's value: degrees or units, Scale's own step, and the factor Shift multiplies by. */
  readonly nudgeStep: number;
  readonly nudgeScaleStep: number;
  readonly nudgeBigFactor: number;
  readonly snap: boolean;
  readonly snapGrid: boolean;
  readonly snapGuides: boolean;
  readonly snapBones: boolean;
  readonly snapPixels: boolean;
}

/** The interface size, in percent. */
export const UI_SCALE_RANGE = [60, 140] as const;
/** 95: a twentieth smaller than the browser's own size; a browser under automation (the browser tests) keeps 100, so what they measure is in the pixels they see. */
const DEFAULT_UI_SCALE = typeof navigator !== "undefined" && navigator.webdriver ? 100 : 95;
export const DEFAULTS: PreferenceValues = { theme: "system", rulers: true, uiScale: DEFAULT_UI_SCALE, fontSize: "medium", toolbarLabels: "auto", toolbarPosition: "left", fewerTicks: false, defaultFps: 30, treeColours: true, treeIndent: 14, treeGuideColour: "auto", stagePanels: true, fullScreenOnStart: true, boneColour: "auto", boneSize: 1, selectedBoneColour: "auto", bones: true, constraints: true, hideIkBones: false, boneSelect: true, imageSelect: true, otherSelect: true, boneNames: false, pickGlow: true, compensate: false, rulerColour: "auto", rulerOpacity: 0, rulerTextColour: "auto", undoSteps: 500, referenceOpacity: 0.5, ai: false, autosave: true, autosaveSeconds: 30, saveTo: "browser", onion: false, onionBefore: 2, onionAfter: 2, onionKeyedOnly: false, onionColour: true,
  grid: false, nudgeStep: 0.35, nudgeScaleStep: 0.01, nudgeBigFactor: 10, checker: true, axes: true, checkerColour: "auto", gridColour: "auto", gridThickness: 1, axisXColour: "#303030", axisYColour: "#303030", axisThickness: 1, tabBarColour: "#201f24", tabActiveColour: "auto", tabTextColour: "auto", tabDimTextColour: "auto", gridSize: 50, snap: true, snapGrid: true, snapGuides: true, snapBones: true, snapPixels: false };
export { BONE_SIZE_RANGE } from "./stage/boneScale";
import { BONE_SIZE_RANGE } from "./stage/boneScale";
export type FontSize = "small" | "medium" | "large";
export const FONT_SIZES: Readonly<Record<FontSize, number>> = { small: 12, medium: 13, large: 14 };
export type ToolbarLabels = "auto" | "show" | "hide";
export type ToolbarPosition = "left" | "center" | "right";
export type SaveTo = "browser" | "file";
export const DEFAULT_FPS_RANGE = [1, 240] as const;
export const TREE_INDENT_RANGE = [6, 40] as const;
export const GRID_RANGE = [1, 1000] as const;
export const NUDGE_RANGE = [0.001, 1000] as const;
export const NUDGE_FACTOR_RANGE = [1, 1000] as const;
export const THICKNESS_RANGE = [0.5, 8] as const;
export const ONION_RANGE = [0, 10] as const;
export const AUTOSAVE_RANGE = [5, 600] as const;
export const UNDO_RANGE = [50, 5000] as const;
export const PREFERENCES_KEY = "boneburst.preferences";
export const PREFERENCES_VERSION = 2;

/** The preferences a theme owns (how things look: colours, sizes, the tree's look); the rest are the same in every theme. */
export const APPEARANCE_KEYS = ["fontSize", "uiScale", "treeColours", "treeIndent", "treeGuideColour", "boneColour", "boneSize", "selectedBoneColour", "rulerColour", "rulerOpacity", "rulerTextColour", "checkerColour", "gridColour", "gridThickness", "axisXColour", "axisYColour", "axisThickness", "tabBarColour", "tabActiveColour", "tabTextColour", "tabDimTextColour", "onionColour"] as const;
export type AppearanceValues = Pick<PreferenceValues, (typeof APPEARANCE_KEYS)[number]>;

/** A theme: a name, the colour scheme it starts from, and its own appearance values. Light and Dark are always there; the others are the person's. */
export interface ThemeProfile { readonly id: string; readonly name: string; readonly base: ThemeBase; readonly values: AppearanceValues }
export const BUILT_IN_THEMES: readonly { readonly id: ThemeBase; readonly name: string }[] = [{ id: "light", name: "Light" }, { id: "dark", name: "Dark" }];

/** What is stored: the behaviour preferences (`values`, whose appearance fields are not read), the themes and the one in use. */
export interface Settings { readonly values: PreferenceValues; readonly themes: readonly ThemeProfile[]; readonly theme: Theme }

export function pickAppearance(p: PreferenceValues): AppearanceValues {
  return Object.fromEntries(APPEARANCE_KEYS.map((k) => [k, p[k]])) as unknown as AppearanceValues;
}

const builtIns = (): ThemeProfile[] => BUILT_IN_THEMES.map((t) => ({ id: t.id, name: t.name, base: t.id, values: pickAppearance(DEFAULTS) }));


/** The storage the preferences live in: `localStorage`, or a stand-in. Either call may throw (blocked). */
export interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** One flat set of preferences from an object: each value that reads and is in range, else its default. */
function readFlat(v: Record<string, unknown>): PreferenceValues {
  const num = (k: string, lo: number, hi: number, d: number) => (typeof v[k] === "number" && (v[k] as number) >= lo && (v[k] as number) <= hi ? (v[k] as number) : d);
  const colour = (k: string, d: string) => (typeof v[k] === "string" && /^(auto|#[0-9a-fA-F]{6})$/.test(v[k] as string) ? (v[k] as string) : d);
  const choice = <T extends string>(k: string, options: readonly T[], d: T): T => (options.includes(v[k] as T) ? (v[k] as T) : d);
  const bool = (k: string, d: boolean) => (typeof v[k] === "boolean" ? (v[k] as boolean) : d);
  return {
    theme: typeof v.theme === "string" ? v.theme : DEFAULTS.theme,
    rulers: bool("rulers", DEFAULTS.rulers),
    bones: bool("bones", DEFAULTS.bones),
    constraints: bool("constraints", DEFAULTS.constraints),
    boneSelect: bool("boneSelect", DEFAULTS.boneSelect),
    imageSelect: bool("imageSelect", DEFAULTS.imageSelect),
    otherSelect: bool("otherSelect", DEFAULTS.otherSelect),
    boneNames: bool("boneNames", DEFAULTS.boneNames),
    pickGlow: bool("pickGlow", DEFAULTS.pickGlow),
    compensate: bool("compensate", DEFAULTS.compensate),
    hideIkBones: bool("hideIkBones", DEFAULTS.hideIkBones),
    rulerColour: colour("rulerColour", DEFAULTS.rulerColour),
    rulerOpacity: num("rulerOpacity", 0, 1, DEFAULTS.rulerOpacity),
    rulerTextColour: colour("rulerTextColour", DEFAULTS.rulerTextColour),
    undoSteps: Math.round(num("undoSteps", UNDO_RANGE[0], UNDO_RANGE[1], DEFAULTS.undoSteps)),
    referenceOpacity: num("referenceOpacity", 0, 1, DEFAULTS.referenceOpacity),
    ai: bool("ai", DEFAULTS.ai),
    autosave: bool("autosave", DEFAULTS.autosave),
    autosaveSeconds: Math.round(num("autosaveSeconds", AUTOSAVE_RANGE[0], AUTOSAVE_RANGE[1], DEFAULTS.autosaveSeconds)),
    onion: bool("onion", DEFAULTS.onion),
    onionBefore: Math.round(num("onionBefore", ONION_RANGE[0], ONION_RANGE[1], DEFAULTS.onionBefore)),
    onionAfter: Math.round(num("onionAfter", ONION_RANGE[0], ONION_RANGE[1], DEFAULTS.onionAfter)),
    onionKeyedOnly: bool("onionKeyedOnly", DEFAULTS.onionKeyedOnly),
    onionColour: bool("onionColour", DEFAULTS.onionColour),
    grid: bool("grid", DEFAULTS.grid),
    checker: bool("checker", DEFAULTS.checker),
    axes: bool("axes", DEFAULTS.axes),
    uiScale: num("uiScale", UI_SCALE_RANGE[0], UI_SCALE_RANGE[1], DEFAULTS.uiScale),
    fontSize: choice("fontSize", ["small", "medium", "large"] as const, DEFAULTS.fontSize),
    toolbarLabels: choice("toolbarLabels", ["auto", "show", "hide"] as const, DEFAULTS.toolbarLabels),
    toolbarPosition: choice("toolbarPosition", ["left", "center", "right"] as const, DEFAULTS.toolbarPosition),
    saveTo: choice("saveTo", ["browser", "file"] as const, DEFAULTS.saveTo),
    fewerTicks: bool("fewerTicks", DEFAULTS.fewerTicks),
    defaultFps: Math.round(num("defaultFps", DEFAULT_FPS_RANGE[0], DEFAULT_FPS_RANGE[1], DEFAULTS.defaultFps)),
    treeColours: bool("treeColours", DEFAULTS.treeColours),
    treeGuideColour: colour("treeGuideColour", DEFAULTS.treeGuideColour),
    treeIndent: Math.round(num("treeIndent", TREE_INDENT_RANGE[0], TREE_INDENT_RANGE[1], DEFAULTS.treeIndent)),
    stagePanels: bool("stagePanels", DEFAULTS.stagePanels),
    fullScreenOnStart: bool("fullScreenOnStart", DEFAULTS.fullScreenOnStart),
    boneColour: colour("boneColour", DEFAULTS.boneColour),
    boneSize: num("boneSize", BONE_SIZE_RANGE[0], BONE_SIZE_RANGE[1], DEFAULTS.boneSize),
    selectedBoneColour: colour("selectedBoneColour", DEFAULTS.selectedBoneColour),
    checkerColour: colour("checkerColour", DEFAULTS.checkerColour),
    gridColour: colour("gridColour", DEFAULTS.gridColour),
    gridThickness: num("gridThickness", THICKNESS_RANGE[0], THICKNESS_RANGE[1], DEFAULTS.gridThickness),
    axisXColour: colour("axisXColour", DEFAULTS.axisXColour),
    axisYColour: colour("axisYColour", DEFAULTS.axisYColour),
    axisThickness: num("axisThickness", THICKNESS_RANGE[0], THICKNESS_RANGE[1], DEFAULTS.axisThickness),
    tabBarColour: colour("tabBarColour", DEFAULTS.tabBarColour),
    tabActiveColour: colour("tabActiveColour", DEFAULTS.tabActiveColour),
    tabTextColour: colour("tabTextColour", DEFAULTS.tabTextColour),
    tabDimTextColour: colour("tabDimTextColour", DEFAULTS.tabDimTextColour),
    gridSize: num("gridSize", GRID_RANGE[0], GRID_RANGE[1], DEFAULTS.gridSize),
    nudgeStep: num("nudgeStep", NUDGE_RANGE[0], NUDGE_RANGE[1], DEFAULTS.nudgeStep),
    nudgeScaleStep: num("nudgeScaleStep", NUDGE_RANGE[0], NUDGE_RANGE[1], DEFAULTS.nudgeScaleStep),
    nudgeBigFactor: num("nudgeBigFactor", NUDGE_FACTOR_RANGE[0], NUDGE_FACTOR_RANGE[1], DEFAULTS.nudgeBigFactor),
    snap: bool("snap", DEFAULTS.snap),
    snapGrid: bool("snapGrid", DEFAULTS.snapGrid),
    snapGuides: bool("snapGuides", DEFAULTS.snapGuides),
    snapBones: bool("snapBones", DEFAULTS.snapBones),
    snapPixels: bool("snapPixels", DEFAULTS.snapPixels),
  };
}

const isObject = (o: unknown): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o);

/** Settings from stored text: the version 2 layout, or a version 1 file (its appearance values go to the built-in theme it named); anything else is the defaults. */
export function readSettings(text: string | null, systemDark = false): Settings {
  const none: Settings = { values: DEFAULTS, themes: builtIns(), theme: "system" };
  if (!text) return none;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return none; }
  if (!isObject(o)) return none;
  const flat = readFlat(o);
  if (o.version === 1) {
    // A file that followed the system had its appearance set under the system's scheme: it goes to that built-in theme only, so the other starts
    // from its defaults (a tab bar made dark for a dark system must not stay dark when Light is chosen).
    const named = o.theme === "light" || o.theme === "dark" ? o.theme : systemDark ? "dark" : "light";
    const mine = (id: string) => id === named;
    return { values: flat, themes: builtIns().map((t) => (mine(t.id) ? { ...t, values: pickAppearance(flat) } : t)), theme: o.theme === "light" || o.theme === "dark" ? o.theme : "system" };
  }
  if (o.version !== PREFERENCES_VERSION) return none;
  const themes = builtIns(), ids = new Set(themes.map((t) => t.id));
  for (const t of Array.isArray(o.themes) ? o.themes : []) {
    if (!isObject(t) || typeof t.id !== "string" || !t.id || typeof t.name !== "string" || !t.name.trim() || (t.base !== "light" && t.base !== "dark")) continue;
    const values = pickAppearance(readFlat(isObject(t.values) ? t.values : {}));
    const at = themes.findIndex((x) => x.id === t.id);
    if (at >= 0 && at < BUILT_IN_THEMES.length) themes[at] = { ...themes[at]!, values };
    else if (!ids.has(t.id)) { ids.add(t.id); themes.push({ id: t.id, name: t.name.trim(), base: t.base, values }); }
  }
  return { values: flat, themes, theme: typeof o.theme === "string" && (o.theme === "system" || ids.has(o.theme)) ? o.theme : "system" };
}

export function writeSettings(s: Settings): string {
  const rest: Record<string, unknown> = { ...s.values };
  for (const k of APPEARANCE_KEYS) delete rest[k];
  return JSON.stringify({ version: PREFERENCES_VERSION, ...rest, theme: s.theme, themes: s.themes });
}

/** The theme profile in use: the named one, or for "system" the built-in Dark or Light by `systemDark`. */
export function activeProfile(s: Settings, systemDark: boolean): ThemeProfile {
  const found = s.theme === "system" ? undefined : s.themes.find((t) => t.id === s.theme);
  return found ?? s.themes.find((t) => t.id === (systemDark ? "dark" : "light"))!;
}

/** The flat preferences in force: the behaviour values with the theme in use's appearance. */
export function resolveSettings(s: Settings, systemDark: boolean): PreferenceValues {
  return { ...s.values, ...activeProfile(s, systemDark).values, theme: s.theme };
}

/** Flat preferences from stored text, as seen with the operating system in light mode. */
export function readPreferences(text: string | null): PreferenceValues {
  return resolveSettings(readSettings(text), false);
}

/** Flat preferences as stored text: the appearance goes into the built-in theme the preferences name ("system" counts as Light). */
export function writePreferences(p: PreferenceValues): string {
  const id = p.theme === "dark" ? "dark" : "light";
  return writeSettings({ values: p, themes: builtIns().map((t) => (t.id === id ? { ...t, values: pickAppearance(p) } : t)), theme: p.theme });
}

const systemIsDark = (): boolean => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;

/** The preferences in use, kept in `store`, telling listeners of each change. Each theme holds its own appearance; `values` is the flat set in force. */
export class Preferences {
  private settings: Settings;
  private current: PreferenceValues;
  private readonly listeners = new Set<(p: PreferenceValues) => void>();

  constructor(private readonly store: Store | null, private readonly systemDark: () => boolean = systemIsDark) {
    let text: string | null = null;
    try { text = store?.getItem(PREFERENCES_KEY) ?? null; } catch { /* storage blocked: the defaults */ }
    this.settings = readSettings(text, this.systemDark());
    this.current = resolveSettings(this.settings, this.systemDark());
  }

  get values(): PreferenceValues { return this.current; }

  /** Every theme: Light and Dark first, then the person's own. */
  get themes(): readonly ThemeProfile[] { return this.settings.themes; }

  /** The theme whose appearance is in force (for "system", the built-in one the operating system picks). */
  get active(): ThemeProfile { return activeProfile(this.settings, this.systemDark()); }

  /** The colour scheme to force on the page, or null to follow the operating system. */
  get scheme(): ThemeBase | null { return this.settings.theme === "system" ? null : this.active.base; }

  onChange(f: (p: PreferenceValues) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** The operating system's scheme changed: when following it, the other built-in theme is now in force. */
  resync(): void { this.commit(this.settings); }

  /** Change some preferences: appearance ones go to the theme in use, the others are the same in every theme; a value out of range is brought into it (the dialog shows what was kept). `theme` switches the theme first. */
  set(patch: Partial<PreferenceValues>): void {
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const old = this.settings;
    const theme = patch.theme !== undefined && (patch.theme === "system" || old.themes.some((t) => t.id === patch.theme)) ? patch.theme : old.theme;
    const here: Settings = { ...old, theme }, from = resolveSettings(here, this.systemDark());
    const merged = { ...from, ...patch, theme };
    const next = readFlat({
      ...merged,
      undoSteps: Number.isFinite(merged.undoSteps) ? clamp(Math.round(merged.undoSteps), UNDO_RANGE[0], UNDO_RANGE[1]) : from.undoSteps,
      referenceOpacity: Number.isFinite(merged.referenceOpacity) ? clamp(merged.referenceOpacity, 0, 1) : from.referenceOpacity,
      autosaveSeconds: Number.isFinite(merged.autosaveSeconds) ? clamp(Math.round(merged.autosaveSeconds), AUTOSAVE_RANGE[0], AUTOSAVE_RANGE[1]) : from.autosaveSeconds,
      onionBefore: Number.isFinite(merged.onionBefore) ? clamp(Math.round(merged.onionBefore), ONION_RANGE[0], ONION_RANGE[1]) : from.onionBefore,
      onionAfter: Number.isFinite(merged.onionAfter) ? clamp(Math.round(merged.onionAfter), ONION_RANGE[0], ONION_RANGE[1]) : from.onionAfter,
      gridThickness: Number.isFinite(merged.gridThickness) ? clamp(merged.gridThickness, THICKNESS_RANGE[0], THICKNESS_RANGE[1]) : from.gridThickness,
      axisThickness: Number.isFinite(merged.axisThickness) ? clamp(merged.axisThickness, THICKNESS_RANGE[0], THICKNESS_RANGE[1]) : from.axisThickness,
      boneSize: Number.isFinite(merged.boneSize) ? clamp(merged.boneSize, BONE_SIZE_RANGE[0], BONE_SIZE_RANGE[1]) : from.boneSize,
      uiScale: Number.isFinite(merged.uiScale) ? clamp(Math.round(merged.uiScale), UI_SCALE_RANGE[0], UI_SCALE_RANGE[1]) : from.uiScale,
      defaultFps: Number.isFinite(merged.defaultFps) ? clamp(Math.round(merged.defaultFps), DEFAULT_FPS_RANGE[0], DEFAULT_FPS_RANGE[1]) : from.defaultFps,
      treeIndent: Number.isFinite(merged.treeIndent) ? clamp(Math.round(merged.treeIndent), TREE_INDENT_RANGE[0], TREE_INDENT_RANGE[1]) : from.treeIndent,
      nudgeStep: Number.isFinite(merged.nudgeStep) ? clamp(merged.nudgeStep, NUDGE_RANGE[0], NUDGE_RANGE[1]) : from.nudgeStep,
      nudgeScaleStep: Number.isFinite(merged.nudgeScaleStep) ? clamp(merged.nudgeScaleStep, NUDGE_RANGE[0], NUDGE_RANGE[1]) : from.nudgeScaleStep,
      nudgeBigFactor: Number.isFinite(merged.nudgeBigFactor) ? clamp(merged.nudgeBigFactor, NUDGE_FACTOR_RANGE[0], NUDGE_FACTOR_RANGE[1]) : from.nudgeBigFactor,
      gridSize: Number.isFinite(merged.gridSize) ? clamp(merged.gridSize, GRID_RANGE[0], GRID_RANGE[1]) : from.gridSize,
    });
    const id = activeProfile(here, this.systemDark()).id;
    this.commit({ values: next, theme, themes: old.themes.map((t) => (t.id === id ? { ...t, values: pickAppearance(next) } : t)) });
  }

  /** A new theme, a copy of the one in use (same base), made the one in use. Returns it. */
  addTheme(name: string): ThemeProfile {
    const from = this.active, taken = new Set(this.settings.themes.map((t) => t.id));
    let n = 1;
    while (taken.has(`theme-${n}`)) n++;
    const made: ThemeProfile = { id: `theme-${n}`, name: name.trim() || `${from.name} ${n}`, base: from.base, values: from.values };
    this.commit({ ...this.settings, themes: [...this.settings.themes, made], theme: made.id });
    return made;
  }

  /** Rename one of the person's own themes (Light and Dark keep their names). */
  renameTheme(id: string, name: string): void {
    if (!name.trim()) return;
    this.commit({ ...this.settings, themes: this.settings.themes.map((t, i) => (t.id === id && i >= BUILT_IN_THEMES.length ? { ...t, name: name.trim() } : t)) });
  }

  /** The colour scheme one of the person's own themes starts from. */
  setThemeBase(id: string, base: ThemeBase): void {
    this.commit({ ...this.settings, themes: this.settings.themes.map((t, i) => (t.id === id && i >= BUILT_IN_THEMES.length ? { ...t, base } : t)) });
  }

  /** Delete one of the person's own themes; if it was in use, the built-in one of its base is. */
  deleteTheme(id: string): void {
    const gone = this.settings.themes.find((t, i) => t.id === id && i >= BUILT_IN_THEMES.length);
    if (!gone) return;
    this.commit({ ...this.settings, themes: this.settings.themes.filter((t) => t !== gone), theme: this.settings.theme === id ? gone.base : this.settings.theme });
  }

  /** Every behaviour preference and the theme in use's appearance back to their defaults; the themes and the one in use stay. */
  reset(): void { this.set({ ...DEFAULTS, theme: this.settings.theme }); }

  private commit(next: Settings): void {
    const values = resolveSettings(next, this.systemDark());
    if (writeSettings(next) === writeSettings(this.settings) && writePreferences(values) === writePreferences(this.current)) return;
    this.settings = next;
    this.current = values;
    try { this.store?.setItem(PREFERENCES_KEY, writeSettings(next)); } catch { /* storage full or blocked: kept for this visit only */ }
    for (const f of this.listeners) f(values);
  }
}
