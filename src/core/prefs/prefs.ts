/**
 * Application preferences: the parameters the editor itself runs on, as
 * opposed to anything the document carries.
 *
 * Pure and DOM-free so the merge — which is also the migration path for a
 * blob written by an older build — can be tested in Node. The live container
 * that reads and writes localStorage is `app/Prefs.ts`.
 *
 * Every default here is the value that used to be hardcoded at the point of
 * use, so an editor with no saved preferences looks and behaves exactly as it
 * did before this file existed.
 */

import { type Overrides, sanitizeOverrides } from "@/core/keys/keymap";
import { UI_FONT_FAMILY_IDS, UI_FONT_SIZES, type UiFontFamily, type UiFontSize } from "@/core/prefs/fonts";
import type { Axes } from "@/core/math/axes";
import { DEFAULT_THEME_ID, THEME_IDS } from "@/core/prefs/themes";

export interface GeneralPrefs {
  autosave: boolean;
  autosaveSeconds: number;
  confirmDiscard: boolean;
  /** Refuse to re-parent a bone the IK solves (see `ikDrivenAmong`). */
  guardIkReparent: boolean;
  /** Ask before Delete removes library items and folders. */
  confirmLibraryDelete: boolean;
  /** Defaults for File ▸ New — not the current document. */
  newDocWidth: number;
  newDocHeight: number;
  newDocFps: number;
  newDocBackground: string;
}

export interface InterfacePrefs {
  /** One of `THEME_IDS`: the neutral chrome (surfaces, lines, text). The
   *  accents below are deliberately outside it, so switching does not clobber
   *  a palette tuned by hand. */
  theme: string;
  accent: string;
  /** The two accents derived from it: the darker one behind a selected row,
   *  the brighter one on an editable number. They are settings of their own
   *  rather than something `applyTheme` computes, so a palette can be tuned by
   *  hand; the dialog's "Derive from accent" recomputes both. */
  accentRow: string;
  accentHot: string;
  accentBlue: string;
  setup: string;
  /** Warnings and the no-export badge: deliberately NOT the accent, since it
   *  has to read as a different kind of signal. */
  warn: string;
  fontSize: UiFontSize;
  fontFamily: UiFontFamily;
  /** The installed font typed in for Font ▸ Custom. */
  fontCustom: string;
  /** Hierarchy lines (the Outline, the timeline's layers): one colour per
   *  depth, repeating after six; off, every line is the neutral grey. */
  treeLineColors: boolean;
  treeLine0: string;
  treeLine1: string;
  treeLine2: string;
  treeLine3: string;
  treeLine4: string;
  treeLine5: string;
}

export interface StagePrefs {
  showGrid: boolean;
  gridSize: number;
  /** Cells between two major grid lines. */
  gridSubdivisions: number;
  gridColor: string;
  gridMajorColor: string;
  /** Lines through the origin of what is being edited (Spine's axes). */
  showOrigin: boolean;
  originColor: string;
  stageEdgeColor: string;
  pasteboard: string;
  /** Fill the stage with the document's background; off, the stage is an
   *  outline on the pasteboard. */
  fillStage: boolean;
  /** What a plain mouse wheel does on the stage; the other is on Shift… see
   *  `Viewport`'s wheel handler. */
  wheel: "zoom" | "pan";
  /** An animation's reference art on the stage (`Animation.reference`). */
  showReference: boolean;
  referenceOpacity: number;
  /** Drawn over the rig rather than behind it. */
  referenceAbove: boolean;
  showRulers: boolean;
  rulerBg: string;
  rulerTick: string;
  rulerText: string;
  showGuides: boolean;
  guideColor: string;
  /** Guides cannot be dragged, moved or deleted while this is on. */
  lockGuides: boolean;
}

export interface SnapPrefs {
  enabled: boolean;
  /** Distance in SCREEN pixels within which a snap takes hold. */
  tolerancePx: number;
  toGrid: boolean;
  toGuides: boolean;
  toObjects: boolean;
  toStage: boolean;
  toPixel: boolean;
  showLines: boolean;
  lineColor: string;
}

export interface GizmoPrefs {
  showBones: boolean;
  showGizmos: boolean;
  /** The path each selected bone follows over the animation. */
  showBonePaths: boolean;
  bonePathPoint: "tip" | "origin";
  bonePathBones: "selected" | "all";
  /** "parent": a path shows the bone's motion against its parent, drawn in
   *  the parent's pose at the playhead; "world": where it goes on the stage. */
  bonePathSpace: "parent" | "world";
  /** The Local and World Path panels zoom together. */
  pathZoomLock: boolean;
  /** A grid under the Path panels' drawing. */
  pathGrid: boolean;
  /** Each Path panel's own onion skin, apart from the stage's: on/off, the
   *  frames before and after the playhead, the nearest ghost's opacity, how
   *  much each further one loses, the past and future colours and outline
   *  mode. "Keyframes only" is the timeline's. */
  localPathOnion: boolean;
  localPathOnionBefore: number;
  localPathOnionAfter: number;
  localPathOnionOpacity: number;
  localPathOnionPast: string;
  localPathOnionFuture: string;
  localPathOnionFalloff: number;
  localPathOnionOutline: boolean;
  worldPathOnion: boolean;
  worldPathOnionBefore: number;
  worldPathOnionAfter: number;
  worldPathOnionOpacity: number;
  worldPathOnionPast: string;
  worldPathOnionFuture: string;
  worldPathOnionFalloff: number;
  worldPathOnionOutline: boolean;
  /** The toolbar at the foot of the stage (Spine's), and what it holds. */
  showToolbar: boolean;
  /** Where its grip dragged it: pixels from its home at the stage's bottom
   *  left (`view/viewport/toolbarPlace.ts`). */
  toolbarX: number;
  toolbarY: number;
  /** Which frame Rotate / Translate values are read in (`core/math/axes.ts`). */
  axes: Axes;
  /** Transforming a node leaves its child bones / images where they are. */
  compensateBones: boolean;
  compensateImages: boolean;
  /** Translate and its fields round to whole pixels. */
  snapPixels: boolean;
  /** The visibility table: bones are shown by `showBones`. Names off by
   *  default, so the stage looks as it did before the table existed. */
  selectBones: boolean;
  nameBones: boolean;
  showImages: boolean;
  selectImages: boolean;
  nameImages: boolean;
  showIk: boolean;
  selectIk: boolean;
  /** Every IK constraint's name, not only the one the selection drives. */
  nameIk: boolean;
  /** The Primary row: bones marked primary (`Node.primary`) follow it
   *  instead of the Bones row (`boneRow`). */
  showPrimary: boolean;
  selectPrimary: boolean;
  namePrimary: boolean;
  handleSize: number;
  select: string;
  marquee: string;
  marqueeEdge: string;
  pivot: string;
  axisX: string;
  axisY: string;
  bone: string;
  boneIk: string;
  /** Laid over a bone named far or right (`boneSide`); alpha 0: none. */
  boneFar: string;
  ikTarget: string;
  ikLink: string;
}

export interface TimelinePrefs {
  frameWidth: number;
  /** The ONE playhead colour: the frame grid draws with it and `applyTheme`
   *  publishes it as `--playhead`. There used to be a second one under
   *  `interface`, which had its own swatch in the dialog and drove nothing —
   *  changing it looked like the setting was broken. */
  playhead: string;
  keyframe: string;
  tween: string;
  selected: string;
  /** Onion markers relative to the playhead while they are not anchored. */
  onionBefore: number;
  onionAfter: number;
  /** Opacity of the nearest ghost ("Starting opacity"). */
  onionOpacity: number;
  /** Fraction each further frame loses ("Decrease by"). */
  onionFalloff: number;
  /** Colour-code past and future ghosts. */
  onionTint: boolean;
  onionPastColor: string;
  onionFutureColor: string;
  onionKeyframesOnly: boolean;
  onionOutline: boolean;
  /** Playback speed: the timeline and the Preview (1 = the fps). */
  playSpeed: number;
  /** Redraws a second while playing (`playStep`): 30, 60 or 120. */
  playRate: number;
  /** A selected bone narrows the timeline to the selection (`focusRows`). */
  focusSelected: boolean;
}

export interface Prefs {
  general: GeneralPrefs;
  interface: InterfacePrefs;
  stage: StagePrefs;
  snap: SnapPrefs;
  gizmos: GizmoPrefs;
  timeline: TimelinePrefs;
  /** Keyboard shortcut OVERRIDES by command id; the defaults live in
   *  `core/keys/commands.ts`. */
  keys: Overrides;
}

export type PrefsCategory = keyof Prefs;

/** Spine's playhead colour. */
export const PLAYHEAD_DEFAULT = "#00e5ff";
const OLD_PLAYHEAD_DEFAULT = "#e8483f";

export const DEFAULT_PREFS: Prefs = {
  general: {
    autosave: true,
    autosaveSeconds: 30,
    confirmDiscard: true,
    guardIkReparent: true,
    confirmLibraryDelete: true,
    newDocWidth: 800,
    newDocHeight: 600,
    newDocFps: 24,
    newDocBackground: "#ffffff",
  },
  interface: {
    theme: DEFAULT_THEME_ID,
    accent: "#00bcd9",
    accentRow: "#006b86",
    accentHot: "#2ccde6",
    accentBlue: "#4a90d9",
    setup: "#4fd1c5",
    warn: "#d89a2e",
    fontSize: "small",
    fontFamily: "jetbrains",
    fontCustom: "",
    treeLineColors: true,
    treeLine0: "rgba(224,108,117,0.75)",
    treeLine1: "rgba(229,192,123,0.75)",
    treeLine2: "rgba(152,195,121,0.75)",
    treeLine3: "rgba(86,182,194,0.75)",
    treeLine4: "rgba(97,175,239,0.75)",
    treeLine5: "rgba(198,120,221,0.75)",
  },
  stage: {
    showGrid: true,
    gridSize: 20,
    gridSubdivisions: 5,
    gridColor: "rgba(255,255,255,0.055)",
    gridMajorColor: "rgba(255,255,255,0.11)",
    showOrigin: true,
    originColor: "rgba(255,255,255,0.3)",
    stageEdgeColor: "#222222",
    pasteboard: "#535353",
    fillStage: false,
    wheel: "zoom",
    showReference: true,
    referenceOpacity: 0.5,
    referenceAbove: false,
    showRulers: true,
    rulerBg: "#3c3c3c",
    rulerTick: "#8f8f8f",
    rulerText: "#a8a8a8",
    showGuides: true,
    guideColor: "#4fd1c5",
    lockGuides: false,
  },
  snap: {
    enabled: true,
    tolerancePx: 8,
    toGrid: true,
    toGuides: true,
    toObjects: true,
    toStage: true,
    toPixel: false,
    showLines: true,
    lineColor: "#ff2fd0",
  },
  gizmos: {
    showBones: true,
    showGizmos: true,
    showBonePaths: true,
    bonePathPoint: "tip",
    bonePathBones: "selected",
    bonePathSpace: "parent",
    pathZoomLock: false,
    pathGrid: false,
    localPathOnion: false,
    localPathOnionBefore: 2,
    localPathOnionAfter: 2,
    localPathOnionOpacity: 0.28,
    localPathOnionPast: "#3d6bff",
    localPathOnionFuture: "#35c05a",
    localPathOnionFalloff: 0.25,
    localPathOnionOutline: false,
    worldPathOnion: false,
    worldPathOnionBefore: 2,
    worldPathOnionAfter: 2,
    worldPathOnionOpacity: 0.28,
    worldPathOnionPast: "#3d6bff",
    worldPathOnionFuture: "#35c05a",
    worldPathOnionFalloff: 0.25,
    worldPathOnionOutline: false,
    showToolbar: true,
    toolbarX: 0,
    toolbarY: 0,
    axes: "parent",
    compensateBones: false,
    compensateImages: false,
    snapPixels: false,
    selectBones: true,
    nameBones: false,
    showImages: true,
    selectImages: true,
    nameImages: false,
    showIk: true,
    selectIk: true,
    nameIk: false,
    showPrimary: true,
    selectPrimary: true,
    namePrimary: false,
    handleSize: 5.5,
    select: "#0090a7",
    marquee: "rgba(74,144,217,0.18)",
    marqueeEdge: "#4a90d9",
    pivot: "#ffffff",
    axisX: "#e0483d",
    axisY: "#46c05a",
    bone: "rgba(255,214,102,0.9)",
    boneIk: "rgba(120,200,255,0.92)",
    boneFar: "rgba(0,0,0,0.4)",
    ikTarget: "rgba(90,230,160,0.95)",
    ikLink: "rgba(120,200,255,0.5)",
  },
  timeline: {
    frameWidth: 12,
    playhead: PLAYHEAD_DEFAULT,
    keyframe: "#161616",
    tween: "#7a7fb0",
    selected: "rgba(0,188,217,0.45)",
    onionBefore: 2,
    onionAfter: 2,
    onionOpacity: 0.28,
    onionFalloff: 0.25,
    onionTint: true,
    onionPastColor: "#3d6bff",
    onionFutureColor: "#35c05a",
    onionKeyframesOnly: false,
    onionOutline: false,
    playSpeed: 1,
    playRate: 60,
    focusSelected: true,
  },
  keys: {},
};

/** Range for every numeric field, so a hand-edited or stale blob cannot put
 *  the editor in a state it has no UI to escape from (a zero grid, a
 *  1000-frame onion skin). The dialog reads the same table for its fields. */
export const PREF_LIMITS: Record<string, { min: number; max: number; step?: number; decimals?: number }> = {
  "general.autosaveSeconds": { min: 5, max: 600 },
  "general.newDocWidth": { min: 1, max: 16384 },
  "general.newDocHeight": { min: 1, max: 16384 },
  "general.newDocFps": { min: 1, max: 120 },
  "stage.gridSize": { min: 1, max: 4096 },
  "stage.gridSubdivisions": { min: 1, max: 64 },
  "stage.referenceOpacity": { min: 0.05, max: 1, step: 0.05, decimals: 2 },
  "snap.tolerancePx": { min: 1, max: 64 },
  "gizmos.handleSize": { min: 3, max: 14, step: 0.5, decimals: 1 },
  "gizmos.localPathOnionBefore": { min: 0, max: 100 },
  "gizmos.localPathOnionAfter": { min: 0, max: 100 },
  "gizmos.worldPathOnionBefore": { min: 0, max: 100 },
  "gizmos.worldPathOnionAfter": { min: 0, max: 100 },
  "gizmos.localPathOnionOpacity": { min: 0.05, max: 1, step: 0.01, decimals: 2 },
  "gizmos.worldPathOnionOpacity": { min: 0.05, max: 1, step: 0.01, decimals: 2 },
  "gizmos.localPathOnionFalloff": { min: 0, max: 0.9, step: 0.01, decimals: 2 },
  "gizmos.worldPathOnionFalloff": { min: 0, max: 0.9, step: 0.01, decimals: 2 },
  "timeline.frameWidth": { min: 4, max: 40 },
  "timeline.onionBefore": { min: 0, max: 100 },
  "timeline.onionAfter": { min: 0, max: 100 },
  "timeline.onionOpacity": { min: 0.05, max: 1, step: 0.01, decimals: 2 },
  "timeline.onionFalloff": { min: 0, max: 0.9, step: 0.01, decimals: 2 },
  "timeline.playSpeed": { min: 0.01, max: 5, step: 0.01, decimals: 2 },
  "timeline.playRate": { min: 30, max: 120 },
};

/** The string settings that are a CHOICE, not free text. Every colour is free
 *  text — a garbage one costs that one swatch — but a font size outside the
 *  four steps has no UI to get back out of. */
export const PREF_ENUMS: Record<string, readonly string[]> = {
  "interface.fontSize": UI_FONT_SIZES,
  "interface.fontFamily": UI_FONT_FAMILY_IDS,
  "interface.theme": THEME_IDS,
  "stage.wheel": ["zoom", "pan"],
  "gizmos.bonePathPoint": ["tip", "origin"],
  "gizmos.bonePathBones": ["selected", "all"],
  "gizmos.bonePathSpace": ["parent", "world"],
  "gizmos.axes": ["local", "parent", "world"],
};

export function clampPref(path: string, value: number): number {
  const lim = PREF_LIMITS[path];
  if (!lim) return value;
  return Math.max(lim.min, Math.min(lim.max, value));
}

/**
 * Overlay the stored blob on the defaults, key by key.
 *
 * Anything of the wrong type, out of range or simply unknown is dropped
 * rather than rejected wholesale: a preference file written by a build that
 * had one field fewer must still start, and one corrupted colour must not
 * cost the user every other setting.
 */
export function mergePrefs(stored: unknown): Prefs {
  const out = structuredClone(DEFAULT_PREFS);
  if (!stored || typeof stored !== "object") return out;
  const src = stored as Record<string, unknown>;

  out.keys = sanitizeOverrides(src.keys);

  for (const cat of Object.keys(out) as PrefsCategory[]) {
    if (cat === "keys") continue;
    const from = src[cat];
    if (!from || typeof from !== "object") continue;
    const target = out[cat] as unknown as Record<string, unknown>;
    const patch = from as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      if (!(key in patch)) continue;
      const v = patch[key];
      const def = target[key];
      if (typeof v !== typeof def) continue;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) continue;
        target[key] = clampPref(`${cat}.${key}`, v);
      } else {
        const choices = PREF_ENUMS[`${cat}.${key}`];
        if (choices && !choices.includes(v as string)) continue;
        target[key] = v;
      }
    }
  }

  const tl = src.timeline as Record<string, unknown> | undefined;
  // The playhead was red by default. A stored copy of that default is not
  // a choice the user made, so it takes the new one; any other colour stays.
  if (tl?.playhead === OLD_PLAYHEAD_DEFAULT) out.timeline.playhead = PLAYHEAD_DEFAULT;

  // Before the markers, the onion skin was one symmetric `onionRange`.
  const legacy = tl?.onionRange;
  if (typeof legacy === "number" && Number.isFinite(legacy)) {
    if (!("onionBefore" in tl!)) out.timeline.onionBefore = clampPref("timeline.onionBefore", legacy);
    if (!("onionAfter" in tl!)) out.timeline.onionAfter = clampPref("timeline.onionAfter", legacy);
  }
  return out;
}

/** Put one category back to its defaults, leaving the others alone. */
export function resetCategory(prefs: Prefs, cat: PrefsCategory): Prefs {
  const out = structuredClone(prefs);
  (out as unknown as Record<string, unknown>)[cat] =
    structuredClone(DEFAULT_PREFS[cat]);
  return out;
}
