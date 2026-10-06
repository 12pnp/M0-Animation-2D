import type { SerializedDockview, SerializedFloatingGroup, SerializedGridObject } from "dockview-core";
import { isPanelId, type PanelId } from "./panelIds";

/** One group's tabs as Dockview saves them (not exported by name). */
type GroupPanelViewState = NonNullable<SerializedFloatingGroup["data"]>;

/**
 * Where panels go, and what a saved layout restores to. No DOM: `tests/workspace.test.ts`.
 *
 * A saved layout may name panels this build does not have (one saved by a newer build, or a
 * panel still to come). Those entries are taken out before Dockview reads the layout, kept as
 * "deferred" (with a built panel they were tabbed with, if any), and applied when the panel
 * arrives. A layout that cannot be read gives way to the default, quietly.
 */

/** Where to add a panel: beside or within another, or at an edge of the whole dock. */
export type Placement =
  | { readonly referencePanel: PanelId; readonly direction: "left" | "right" | "above" | "below" | "within" }
  | { readonly direction: "left" | "right" | "above" | "below" };

/** Each panel's first-choice place, then where it goes when that panel is not there. */
const DEFAULTS: Readonly<Record<PanelId, readonly Placement[]>> = {
  rigTree: [{ direction: "left" }],
  stage: [{ referencePanel: "rigTree", direction: "right" }, { direction: "right" }],
  properties: [{ referencePanel: "stage", direction: "right" }, { direction: "right" }],
  timeline: [{ direction: "below" }],
  preview: [{ referencePanel: "stage", direction: "right" }, { direction: "right" }],
  reference: [{ referencePanel: "properties", direction: "within" }, { direction: "right" }],
  ai: [{ referencePanel: "properties", direction: "within" }, { direction: "right" }],
  // Behind the rig panel: the default layout looks as before (E7 step 1).
  history: [{ referencePanel: "rigTree", direction: "within" }, { direction: "left" }],
};

/** The order the default layout adds the panels in. */
export const DEFAULT_ORDER: readonly PanelId[] = ["rigTree", "stage", "properties", "timeline", "preview", "reference", "ai", "history"];

/** The default place for `id`, given the panels already in the dock. */
export function defaultPlacement(id: PanelId, present: ReadonlySet<string>): Placement {
  const options = DEFAULTS[id];
  return options.find((p) => !("referencePanel" in p) || present.has(p.referencePanel)) ?? options.at(-1)!;
}

/** Where a panel the saved layout deferred goes when it arrives: with the panel it was tabbed
 *  with, if that is in the dock, else its default place. */
export function arrivalPlacement(id: PanelId, deferred: Deferred, present: ReadonlySet<string>): Placement {
  const with_ = deferred[id]?.tabWith;
  return with_ && present.has(with_) ? { referencePanel: with_, direction: "within" } : defaultPlacement(id, present);
}

/** Panels a saved layout had and this build does not, with a panel each was tabbed with. */
export type Deferred = Partial<Record<PanelId, { readonly tabWith?: PanelId }>>;

/** What the browser keeps: Dockview's own layout, and the panels deferred from it. */
export interface SavedWorkspace {
  readonly format: "boneburst-workspace";
  readonly version: 1;
  readonly dockview: SerializedDockview;
  readonly deferred: Deferred;
  /** Panels this build has that were closed when it was saved: they stay closed (Window shows them again). */
  readonly closed?: readonly PanelId[];
}

export function saveWorkspace(dockview: SerializedDockview, deferred: Deferred, closed: readonly PanelId[] = []): SavedWorkspace {
  return { format: "boneburst-workspace", version: 1, dockview, deferred, ...(closed.length ? { closed } : {}) };
}

/**
 * A saved workspace as this build can lay it out: the panels it does not build taken out (with
 * any group or split left empty), and those panels deferred. Null when the text is not a
 * workspace this build reads, or nothing built is left in it.
 */
export function restoreWorkspace(text: string | null, built: ReadonlySet<PanelId>): { dockview: SerializedDockview; deferred: Deferred; closed: PanelId[] } | null {
  let saved: Partial<SavedWorkspace>;
  try {
    saved = text ? (JSON.parse(text) as Partial<SavedWorkspace>) : {};
  } catch {
    return null;
  }
  const d = saved.dockview;
  if (saved.format !== "boneburst-workspace" || saved.version !== 1 || !d?.grid?.root || !d.panels) return null;
  const keep = (id: string) => isPanelId(id) && built.has(id);
  const deferred: Deferred = {};
  for (const [id, v] of Object.entries(saved.deferred ?? {})) if (isPanelId(id) && !built.has(id)) deferred[id] = v ?? {};
  const note = (state: GroupPanelViewState) => {
    const kept = state.views.filter(keep);
    for (const v of state.views) if (!keep(v) && isPanelId(v)) deferred[v] = kept[0] && isPanelId(kept[0]) ? { tabWith: kept[0] } : {};
  };
  const groups = new Set<string>();
  const group = (state: GroupPanelViewState | undefined): GroupPanelViewState | null => {
    if (!state) return null;
    note(state);
    const views = state.views.filter(keep);
    if (!views.length) return null;
    groups.add(state.id);
    return { ...state, views, activeView: state.activeView && views.includes(state.activeView) ? state.activeView : views[0]! };
  };
  const grid = (node: SerializedGridObject<GroupPanelViewState>): SerializedGridObject<GroupPanelViewState> | null => {
    if (node.type === "leaf") {
      const data = group(node.data as GroupPanelViewState);
      return data ? { ...node, data } : null;
    }
    const children = (node.data as SerializedGridObject<GroupPanelViewState>[]).map(grid).filter((c): c is SerializedGridObject<GroupPanelViewState> => !!c);
    return children.length ? { ...node, data: children } : null;
  };
  try {
    const root = grid(d.grid.root);
    if (!root) return null;
    const floating = (d.floatingGroups ?? []).flatMap((f) => {
      const data = group(f.data);
      const g = f.grid ? grid(f.grid.root) : null;
      return data || g ? [{ ...f, ...(data ? { data } : {}), ...(g && f.grid ? { grid: { ...f.grid, root: g } } : {}) }] : [];
    });
    const popout = (d.popoutGroups ?? []).flatMap((f) => {
      const data = group(f.data);
      const g = f.grid ? grid(f.grid.root) : null;
      return data || g ? [{ ...f, ...(data ? { data } : {}), ...(g && f.grid ? { grid: { ...f.grid, root: g } } : {}) }] : [];
    });
    const panels = Object.fromEntries(Object.entries(d.panels).filter(([id]) => keep(id)));
    for (const id of Object.keys(d.panels)) if (isPanelId(id) && !keep(id) && !deferred[id]) deferred[id] = {};
    const { floatingGroups: _f, popoutGroups: _p, activeGroup, ...rest } = d;
    return {
      dockview: {
        ...rest, panels, grid: { ...d.grid, root },
        // An active group taken out with its panels is not handed to Dockview.
        ...(activeGroup && groups.has(activeGroup) ? { activeGroup } : {}),
        ...(floating.length ? { floatingGroups: floating } : {}),
        ...(popout.length ? { popoutGroups: popout } : {}),
      } as SerializedDockview,
      deferred,
      closed: (saved.closed ?? []).filter((id): id is PanelId => isPanelId(id) && built.has(id)),
    };
  } catch {
    return null;
  }
}
