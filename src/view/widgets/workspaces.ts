/**
 * Named workspaces: a saved arrangement of both docks and the shell's region
 * sizes. DOM-free; `app/Workspaces.ts` reads and writes localStorage and
 * `Shell` applies one.
 */

import type { DockLayout } from "./dockDrop";

/** The shell's region sizes, as `Shell` stores them under `animo.sizes`. */
export interface ShellSizes {
  right?: number;
  bottom?: number;
  rightHidden?: boolean;
  /** The left panel's width and whether it shows. Named for the AI column it
   *  used to be, so sizes stored then still load. */
  ai?: number;
  aiOpen?: boolean;
  /** Columns in the right dock; absent: one. */
  rightColumns?: number;
}

export interface Workspace {
  /** The left panel; absent in a workspace saved before it was a dock. */
  left?: DockLayout;
  /** The right dock's first column. */
  right: DockLayout;
  /** Its further columns, left to right; absent in a workspace saved with one. */
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
    if (findWorkspace(out, e.name)) continue;
    out.push({
      name: e.name.trim(),
      workspace: {
        ...(w.left ? { left: withDefaults(w.left) } : {}),
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
    right: [[["properties", "library", "outline", "history", "preview"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "1x2", label: "1 × 2",
    left: [["ai"]],
    right: [[["properties", "outline", "history"], ["library", "preview"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "1x3", label: "1 × 3",
    left: [["ai"]],
    right: [[["properties", "history"], ["library", "outline"], ["preview"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "2x2", label: "2 × 2",
    left: [["ai"]],
    right: [[["properties"], ["history"]], [["library", "outline"], ["preview"]]],
    bottom: [["timeline", "reference", "poses"]],
  },
  {
    id: "2x3", label: "2 × 3",
    left: [["ai"]],
    right: [[["properties"], ["outline"], ["preview"]], [["library"], ["history"], ["poses"]]],
    bottom: [["timeline", "reference"]],
  },
];

/** Width of one right-dock column when a preset lays it out. */
export const PRESET_COLUMN_WIDTH = 268;

/**
 * How wide the right dock may be: wider with more columns, but never more
 * than half the window, so the stage keeps the other half.
 */
export function clampRightWidth(width: number, columns: number, viewportWidth: number): number {
  const min = 180 + 120 * (columns - 1);
  const max = Math.max(min, Math.min(Math.max(560, 300 * columns), viewportWidth * 0.5));
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
    sizes: { right: PRESET_COLUMN_WIDTH * p.right.length, rightHidden: false, rightColumns: p.right.length },
  };
}
