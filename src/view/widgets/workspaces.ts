/**
 * Named workspaces: a saved arrangement of both docks and the shell's region
 * sizes. DOM-free; `app/Workspaces.ts` reads and writes localStorage and
 * `Shell` applies one.
 */

import type { DockLayout } from "./dockDrop";

/** The shell's region sizes, as `Shell` stores them under `animo.sizes`. */
/**
 * The shell's region sizes, as stored under `animo.sizes`. Four side columns:
 * L1 and L2 left of the stage, R1 and R2 right of it, each with its own width
 * and its own toggle. The older names stay: `ai` / `aiOpen` are L1 (once the
 * AI column), `right` / `rightHidden` R1. Sizes saved before R2 had its own
 * width carry `rightColumns` and `right` as the whole dock (`columnSizes`).
 */
export interface ShellSizes {
  right?: number;
  bottom?: number;
  rightHidden?: boolean;
  ai?: number;
  aiOpen?: boolean;
  left2?: number;
  left2Open?: boolean;
  right2?: number;
  right2Open?: boolean;
  /** Old format: how many columns shared `right`. */
  rightColumns?: number;
}

export type ColumnKey = "l1" | "l2" | "r1" | "r2";
export interface ColumnSize { width: number; open: boolean }

/** Default widths: the AI panel wants room, a second column less. */
const COLUMN_DEFAULTS: Record<ColumnKey, ColumnSize> = {
  l1: { width: 380, open: false },
  l2: { width: 300, open: false },
  r1: { width: 268, open: true },
  r2: { width: 268, open: false },
};

/** Each column's width and visibility from stored sizes, old format included. */
export function columnSizes(s: ShellSizes): Record<ColumnKey, ColumnSize> {
  const out = structuredClone(COLUMN_DEFAULTS);
  if (s.ai) out.l1.width = s.ai;
  out.l1.open = !!s.aiOpen;
  if (s.left2) out.l2.width = s.left2;
  out.l2.open = !!s.left2Open;
  out.r1.open = !s.rightHidden;
  const legacyCols = s.right2 === undefined && (s.rightColumns ?? 1) >= 2;
  if (legacyCols) {
    // One width shared by the columns, and one toggle for all of them.
    const each = Math.round((s.right ?? 536) / s.rightColumns!);
    out.r1.width = each;
    out.r2 = { width: each, open: !s.rightHidden };
  } else {
    if (s.right) out.r1.width = s.right;
    if (s.right2) out.r2.width = s.right2;
    out.r2.open = !!s.right2Open;
  }
  return out;
}

/** The stored form of the four columns (the bottom height is the shell's). */
export function storedColumns(c: Record<ColumnKey, ColumnSize>): ShellSizes {
  return {
    ai: c.l1.width, aiOpen: c.l1.open,
    left2: c.l2.width, left2Open: c.l2.open,
    right: c.r1.width, rightHidden: !c.r1.open,
    right2: c.r2.width, right2Open: c.r2.open,
  };
}

export interface Workspace {
  /** The left panel; absent in a workspace saved before it was a dock. */
  left?: DockLayout;
  /** The second left column; absent before it existed. */
  left2?: DockLayout;
  /** The right dock's first column. */
  right: DockLayout;
  /** The second right column (R2) as `columns[0]`; absent in a workspace
   *  saved with one. Kept a list for workspaces saved before R2 had a name. */
  columns?: DockLayout[];
  bottom: DockLayout;
  sizes: ShellSizes;
}

export interface NamedWorkspace { name: string; workspace: Workspace }

export const MAX_WORKSPACE_NAME = 40;

const isLayout = (v: unknown): v is DockLayout =>
  !!v && typeof v === "object" && Array.isArray((v as DockLayout).groups)
  && (v as DockLayout).groups.every((g) => g && Array.isArray(g.panelIds));

// A layout written by hand or by an older build may lack the optional lists.
const withDefaults = (l: DockLayout): DockLayout =>
  ({ ...l, floats: l.floats ?? {}, closed: l.closed ?? [] });

/** The stored list, keeping only well-formed entries with distinct names. */
export function parseWorkspaces(raw: string | null): NamedWorkspace[] {
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : []; } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: NamedWorkspace[] = [];
  for (const e of data as Array<Partial<NamedWorkspace>>) {
    const w = e?.workspace;
    if (typeof e?.name !== "string" || !e.name.trim() || !w) continue;
    if (!isLayout(w.right) || !isLayout(w.bottom)) continue;
    if (w.columns !== undefined && !(Array.isArray(w.columns) && w.columns.every(isLayout))) continue;
    if (w.left !== undefined && !isLayout(w.left)) continue;
    if (w.left2 !== undefined && !isLayout(w.left2)) continue;
    if (findWorkspace(out, e.name)) continue;
    out.push({
      name: e.name.trim(),
      workspace: {
        ...(w.left ? { left: withDefaults(w.left) } : {}),
        ...(w.left2 ? { left2: withDefaults(w.left2) } : {}),
        right: withDefaults(w.right),
        ...(w.columns?.length ? { columns: w.columns.map(withDefaults) } : {}),
        bottom: withDefaults(w.bottom),
        sizes: w.sizes && typeof w.sizes === "object" ? w.sizes : {},
      },
    });
  }
  return out;
}

/** Names compare without case: "Animate" and "animate" are one workspace. */
export function findWorkspace(list: NamedWorkspace[], name: string): NamedWorkspace | undefined {
  const key = name.trim().toLowerCase();
  return list.find((e) => e.name.toLowerCase() === key);
}

/** Why a name cannot be used, or null. An existing name is fine: saving replaces it. */
export function workspaceNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name.";
  if (n.length > MAX_WORKSPACE_NAME) return `Use at most ${MAX_WORKSPACE_NAME} characters.`;
  return null;
}

/** Add, or replace the one with the same name in place (keeping its spot in the menu). */
export function putWorkspace(list: NamedWorkspace[], name: string, workspace: Workspace): NamedWorkspace[] {
  const n = name.trim();
  const old = findWorkspace(list, n);
  const entry = { name: n, workspace: structuredClone(workspace) };
  return old ? list.map((e) => (e === old ? entry : e)) : [...list, entry];
}

export function removeWorkspace(list: NamedWorkspace[], name: string): NamedWorkspace[] {
  const old = findWorkspace(list, name);
  return old ? list.filter((e) => e !== old) : list;
}

// ── Built-in presets ─────────────────────────────────────────────────────

export interface LayoutPreset {
  id: string;
  label: string;
  left: string[][];
  /** Right dock: columns of groups of panel ids. */
  right: string[][][];
  bottom: string[][];
}

/**
 * Columns × rows of panel groups in the right dock; the AI panel keeps the
 * left one (whether it shows is the left panel's own toggle). Every panel is placed, so
 * a preset also reopens what was closed and docks what was floating; the
 * tabs a group holds beyond its first are the ones used least.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: "1x1", label: "1 × 1",
    left: [["ai"]],
    right: [[["properties", "library", "outline", "animations", "skins", "history", "subtree", "preview", "path", "worldPath"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "1x2", label: "1 × 2",
    left: [["ai"]],
    right: [[["properties", "outline", "animations", "skins", "history", "subtree"], ["library", "preview", "path", "worldPath"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "1x3", label: "1 × 3",
    left: [["ai"]],
    right: [[["properties", "history", "subtree"], ["library", "outline", "animations", "skins"], ["preview", "path", "worldPath"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "2x2", label: "2 × 2",
    left: [["ai"]],
    right: [[["properties"], ["history", "subtree"]], [["library", "outline", "animations", "skins"], ["preview", "path", "worldPath"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "2x3", label: "2 × 3",
    left: [["ai"]],
    right: [[["properties"], ["outline", "animations", "skins"], ["preview", "path", "worldPath"]], [["library"], ["history", "subtree"], ["poses"]]],
    bottom: [["timeline", "reference"]],
  },
];

/** Width of one right-dock column when a preset lays it out. */
export const PRESET_COLUMN_WIDTH = 268;

/** The narrowest a side column is drawn, and the least the stage keeps. */
export const COLUMN_MIN = 180;
export const STAGE_MIN = 240;

/**
 * The widths the open columns are DRAWN at, so they fit beside the stage in
 * `room` pixels: each keeps the width it was given while they fit, and all
 * shrink in proportion when they do not, never under `COLUMN_MIN`. The
 * given widths are not changed, so the columns grow back with the window.
 */
export function fitColumns(
  cols: Readonly<Record<ColumnKey, ColumnSize>>, room: number,
): Record<ColumnKey, number> {
  const keys = Object.keys(cols) as ColumnKey[];
  const open = keys.filter((k) => cols[k].open);
  const total = open.reduce((sum, k) => sum + cols[k].width, 0);
  const out = Object.fromEntries(keys.map((k) => [k, cols[k].width])) as Record<ColumnKey, number>;
  if (total <= room || total === 0) return out;
  const spare = Math.max(0, room - COLUMN_MIN * open.length);
  const extra = open.reduce((sum, k) => sum + (cols[k].width - COLUMN_MIN), 0);
  for (const k of open) {
    out[k] = Math.floor(COLUMN_MIN + (extra > 0 ? (cols[k].width - COLUMN_MIN) * spare / extra : 0));
  }
  return out;
}

/** How wide one side column may be: never narrower than its content needs,
 *  never more than 45% of the window, so the stage keeps the rest. */
export function clampColumnWidth(width: number, viewportWidth: number): number {
  const min = COLUMN_MIN;
  const max = Math.max(min, Math.min(700, viewportWidth * 0.45));
  return Math.round(Math.max(min, Math.min(max, width)));
}

const layoutOf = (groups: string[][]): DockLayout => ({
  groups: groups.map((ids) => ({ panelIds: [...ids], activeId: ids[0]!, collapsed: false, weight: 1 })),
  floats: {},
  closed: [],
});

/** The workspace a preset stands for. Region sizes it does not decide (the
 *  timeline height, the AI column) are left out, so applying it keeps them. */
export function presetWorkspace(p: LayoutPreset): Workspace {
  const [first, ...rest] = p.right;
  return {
    left: layoutOf(p.left),
    right: layoutOf(first!),
    ...(rest.length ? { columns: rest.map(layoutOf) } : {}),
    bottom: layoutOf(p.bottom),
    sizes: {
      right: PRESET_COLUMN_WIDTH, rightHidden: false,
      right2: PRESET_COLUMN_WIDTH, right2Open: p.right.length > 1,
    },
  };
}
