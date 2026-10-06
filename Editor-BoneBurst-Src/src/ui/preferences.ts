/**
 * The editor's preferences (E4-PLAN step 10): how it looks and behaves for this person, never what
 * a document means. Kept in the browser's storage, versioned; what does not read is the default.
 * No DOM here: the storage is passed in, so vitest drives it.
 */

export type Theme = "system" | "light" | "dark";

export interface PreferenceValues {
  readonly theme: Theme;
  readonly rulers: boolean;
  /** The transform, space and show panels over the stage's foot. */
  readonly stagePanels: boolean;
  /** The colour bones are drawn in on the stage ("#rrggbb", or "auto" for the theme's); a bone with a colour of its own keeps it. */
  readonly boneColour: string;
  /** How big bones are drawn, a multiple of the default (BONE_SIZE_RANGE). */
  readonly boneSize: number;
  /** The highlight of the selected bone and its gizmo ("#rrggbb", or "auto" for the theme's accent). */
  readonly selectedBoneColour: string;
  readonly bones: boolean;
  /** Constraints drawn on the stage (E4 step 12). */
  readonly constraints: boolean;
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
  readonly snap: boolean;
  readonly snapGrid: boolean;
  readonly snapGuides: boolean;
  readonly snapBones: boolean;
  readonly snapPixels: boolean;
}

export const DEFAULTS: PreferenceValues = { theme: "system", rulers: true, stagePanels: true, boneColour: "auto", boneSize: 1, selectedBoneColour: "auto", bones: true, constraints: true, undoSteps: 500, referenceOpacity: 0.5, ai: false, autosave: true, autosaveSeconds: 30, onion: false, onionBefore: 2, onionAfter: 2, onionKeyedOnly: false, onionColour: true,
  grid: false, checker: true, axes: true, checkerColour: "auto", gridColour: "auto", gridThickness: 1, axisXColour: "#303030", axisYColour: "#303030", axisThickness: 1, tabBarColour: "#201f24", tabActiveColour: "auto", tabTextColour: "auto", tabDimTextColour: "auto", gridSize: 50, snap: true, snapGrid: true, snapGuides: true, snapBones: true, snapPixels: false };
export { BONE_SIZE_RANGE } from "./stage/boneScale";
import { BONE_SIZE_RANGE } from "./stage/boneScale";
export const GRID_RANGE = [1, 1000] as const;
export const THICKNESS_RANGE = [0.5, 8] as const;
export const ONION_RANGE = [0, 10] as const;
export const AUTOSAVE_RANGE = [5, 600] as const;
export const UNDO_RANGE = [50, 5000] as const;
export const PREFERENCES_KEY = "boneburst.preferences";
export const PREFERENCES_VERSION = 1;

/** The storage the preferences live in: `localStorage`, or a stand-in. Either call may throw (blocked). */
export interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** Preferences from stored text: each value that reads and is in range, else its default. */
export function readPreferences(text: string | null): PreferenceValues {
  if (!text) return DEFAULTS;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return DEFAULTS; }
  if (!o || typeof o !== "object" || (o as { version?: unknown }).version !== PREFERENCES_VERSION) return DEFAULTS;
  const v = o as Record<string, unknown>;
  const num = (k: string, lo: number, hi: number, d: number) => (typeof v[k] === "number" && (v[k] as number) >= lo && (v[k] as number) <= hi ? (v[k] as number) : d);
  const colour = (k: string, d: string) => (typeof v[k] === "string" && /^(auto|#[0-9a-fA-F]{6})$/.test(v[k] as string) ? (v[k] as string) : d);
  const bool = (k: string, d: boolean) => (typeof v[k] === "boolean" ? (v[k] as boolean) : d);
  return {
    theme: v.theme === "light" || v.theme === "dark" || v.theme === "system" ? v.theme : DEFAULTS.theme,
    rulers: bool("rulers", DEFAULTS.rulers),
    bones: bool("bones", DEFAULTS.bones),
    constraints: bool("constraints", DEFAULTS.constraints),
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
    stagePanels: bool("stagePanels", DEFAULTS.stagePanels),
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
    snap: bool("snap", DEFAULTS.snap),
    snapGrid: bool("snapGrid", DEFAULTS.snapGrid),
    snapGuides: bool("snapGuides", DEFAULTS.snapGuides),
    snapBones: bool("snapBones", DEFAULTS.snapBones),
    snapPixels: bool("snapPixels", DEFAULTS.snapPixels),
  };
}

export function writePreferences(p: PreferenceValues): string {
  return JSON.stringify({ version: PREFERENCES_VERSION, ...p });
}

/** The preferences in use, kept in `store`, telling listeners of each change. */
export class Preferences {
  private current: PreferenceValues;
  private readonly listeners = new Set<(p: PreferenceValues) => void>();

  constructor(private readonly store: Store | null) {
    let text: string | null = null;
    try { text = store?.getItem(PREFERENCES_KEY) ?? null; } catch { /* storage blocked: the defaults */ }
    this.current = readPreferences(text);
  }

  get values(): PreferenceValues { return this.current; }

  onChange(f: (p: PreferenceValues) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Change some preferences; a value out of range is brought into it (the dialog shows what was kept). */
  set(patch: Partial<PreferenceValues>): void {
    const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
    const merged = { ...this.current, ...patch };
    const next = readPreferences(writePreferences({
      ...merged,
      undoSteps: Number.isFinite(merged.undoSteps) ? clamp(Math.round(merged.undoSteps), UNDO_RANGE[0], UNDO_RANGE[1]) : this.current.undoSteps,
      referenceOpacity: Number.isFinite(merged.referenceOpacity) ? clamp(merged.referenceOpacity, 0, 1) : this.current.referenceOpacity,
      autosaveSeconds: Number.isFinite(merged.autosaveSeconds) ? clamp(Math.round(merged.autosaveSeconds), AUTOSAVE_RANGE[0], AUTOSAVE_RANGE[1]) : this.current.autosaveSeconds,
      onionBefore: Number.isFinite(merged.onionBefore) ? clamp(Math.round(merged.onionBefore), ONION_RANGE[0], ONION_RANGE[1]) : this.current.onionBefore,
      onionAfter: Number.isFinite(merged.onionAfter) ? clamp(Math.round(merged.onionAfter), ONION_RANGE[0], ONION_RANGE[1]) : this.current.onionAfter,
      gridThickness: Number.isFinite(merged.gridThickness) ? clamp(merged.gridThickness, THICKNESS_RANGE[0], THICKNESS_RANGE[1]) : this.current.gridThickness,
      axisThickness: Number.isFinite(merged.axisThickness) ? clamp(merged.axisThickness, THICKNESS_RANGE[0], THICKNESS_RANGE[1]) : this.current.axisThickness,
      boneSize: Number.isFinite(merged.boneSize) ? clamp(merged.boneSize, BONE_SIZE_RANGE[0], BONE_SIZE_RANGE[1]) : this.current.boneSize,
      gridSize: Number.isFinite(merged.gridSize) ? clamp(merged.gridSize, GRID_RANGE[0], GRID_RANGE[1]) : this.current.gridSize,
    }));
    if (writePreferences(next) === writePreferences(this.current)) return;
    this.current = next;
    try { this.store?.setItem(PREFERENCES_KEY, writePreferences(next)); } catch { /* storage full or blocked: kept for this visit only */ }
    for (const f of this.listeners) f(next);
  }

  reset(): void { this.set(DEFAULTS); }
}
