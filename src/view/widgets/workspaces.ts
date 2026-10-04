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
  ai?: number;
  aiOpen?: boolean;
}

export interface Workspace {
  right: DockLayout;
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
    if (findWorkspace(out, e.name)) continue;
    out.push({
      name: e.name.trim(),
      workspace: {
        right: withDefaults(w.right),
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
