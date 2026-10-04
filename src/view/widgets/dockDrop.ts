/**
 * Where a dragged panel tab lands, and what that does to the dock layouts.
 * DOM-free so vitest can table-test it; `Dock` measures the rectangles and
 * applies the result.
 */

export interface GroupState {
  panelIds: string[];
  activeId: string;
  collapsed: boolean;
  /** Flex weight when expanded. */
  weight: number;
}

export interface FloatRectLike { x: number; y: number; w: number; h: number }

export interface DockLayout {
  groups: GroupState[];
  /** Panels torn out of the column, by id. */
  floats: Record<string, FloatRectLike>;
  /** Panels the user closed. Kept so they are not silently re-added. */
  closed: string[];
  /**
   * For each closed panel, a panel it was grouped with. Reopening puts it
   * back beside that one instead of stranding it in a group of its own.
   */
  closedNear?: Record<string, string>;
}

export interface Rect { left: number; top: number; right: number; bottom: number }

export interface GroupRects {
  rect: Rect;
  strip: Rect;
  /** One per tab, in order. */
  tabs: Rect[];
}

export interface DockRects {
  /** The whole column, so an empty dock or the space below the last group still takes a drop. */
  rect: Rect;
  groups: GroupRects[];
}

export type DropTarget =
  /** A new group above or below `group`. */
  | { dock: number; group: number; edge: "before" | "after" }
  /** A tab in `group`, inserted before its `tab`-th tab. */
  | { dock: number; group: number; edge: "into"; tab: number }
  /** A new group in a dock that has none. */
  | { dock: number; edge: "empty" };

const inside = (r: Rect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/** The drop under (x, y), or null when the pointer is over no dock: the tab floats. */
export function dropTargetAt(docks: DockRects[], x: number, y: number): DropTarget | null {
  for (let d = 0; d < docks.length; d++) {
    const dock = docks[d]!;
    for (let g = 0; g < dock.groups.length; g++) {
      const grp = dock.groups[g]!;
      if (!inside(grp.rect, x, y)) continue;
      if (inside(grp.strip, x, y)) {
        const tab = grp.tabs.filter((t) => (t.left + t.right) / 2 < x).length;
        return { dock: d, group: g, edge: "into", tab };
      }
      const h = grp.rect.bottom - grp.rect.top;
      const band = Math.min(28, h * 0.28);
      if (y < grp.rect.top + band) return { dock: d, group: g, edge: "before" };
      if (y > grp.rect.bottom - band) return { dock: d, group: g, edge: "after" };
      return { dock: d, group: g, edge: "into", tab: grp.tabs.length };
    }
    if (!inside(dock.rect, x, y)) continue;
    if (dock.groups.length === 0) return { dock: d, edge: "empty" };
    const last = dock.groups.length - 1;
    if (y > dock.groups[last]!.rect.bottom) return { dock: d, group: last, edge: "after" };
  }
  return null;
}

/**
 * Move `panelId` from dock `from` to `target`. Returns new layouts (the
 * inputs are left alone), or null when the drop changes nothing.
 */
export function moveTab(
  layouts: DockLayout[],
  from: number,
  panelId: string,
  target: DropTarget,
): DockLayout[] | null {
  const src = layouts[from]?.groups.find((g) => g.panelIds.includes(panelId));
  if (!src) return null;
  const at = target.edge === "empty" ? null : layouts[target.dock]?.groups[target.group];
  if (target.edge !== "empty" && !at) return null;

  if (at === src) {
    if (target.edge !== "into") {
      // Its own group's edge: only a group with other tabs can split.
      if (src.panelIds.length === 1) return null;
    } else {
      const old = src.panelIds.indexOf(panelId);
      if (target.tab === old || target.tab === old + 1) {
        return src.activeId === panelId && !src.collapsed ? null : activate(layouts, from, panelId);
      }
    }
  }

  const next = structuredClone(layouts);
  const srcGroup = next[from]!.groups.find((g) => g.panelIds.includes(panelId))!;
  const dest = target.edge === "empty" ? null : next[target.dock]!.groups[target.group]!;
  let insertTab = target.edge === "into" ? target.tab : 0;
  if (dest === srcGroup && srcGroup.panelIds.indexOf(panelId) < insertTab) insertTab--;

  srcGroup.panelIds = srcGroup.panelIds.filter((id) => id !== panelId);
  if (srcGroup.activeId === panelId) srcGroup.activeId = srcGroup.panelIds[0] ?? "";

  const fresh = (): GroupState => ({ panelIds: [panelId], activeId: panelId, collapsed: false, weight: 1 });
  const groups = next[target.dock]!.groups;
  if (target.edge === "empty") {
    groups.push(fresh());
  } else if (target.edge === "into") {
    dest!.panelIds.splice(insertTab, 0, panelId);
    dest!.activeId = panelId;
    dest!.collapsed = false;
  } else {
    // By the group object, not its index: removing the tab may have emptied
    // a group ahead of it.
    const i = groups.indexOf(dest!);
    groups.splice(target.edge === "before" ? i : i + 1, 0, fresh());
  }
  for (const l of next) l.groups = l.groups.filter((g) => g.panelIds.length > 0);
  return next;
}

function activate(layouts: DockLayout[], dock: number, panelId: string): DockLayout[] {
  const next = structuredClone(layouts);
  const g = next[dock]!.groups.find((x) => x.panelIds.includes(panelId))!;
  g.activeId = panelId;
  g.collapsed = false;
  return next;
}

/** Does a stored layout place this panel anywhere: docked, floating or closed? */
export function placesPanel(layout: DockLayout | null, panelId: string): boolean {
  if (!layout) return false;
  return layout.groups.some((g) => g.panelIds.includes(panelId))
    || panelId in (layout.floats ?? {})
    || (layout.closed ?? []).includes(panelId);
}

/**
 * A whole group, every tab in it, from one dock to another: at the same place
 * in the column where it can be (else the end), with its open state and the
 * `weight` the caller worked out to keep its height. New layouts, or null when
 * the group is not there.
 */
export function moveGroup(
  layouts: DockLayout[], from: number, group: number, to: number, weight: number,
): DockLayout[] | null {
  if (from === to || !layouts[from]?.groups[group] || !layouts[to]) return null;
  const next = structuredClone(layouts);
  const [g] = next[from]!.groups.splice(group, 1);
  const dest = next[to]!.groups;
  dest.splice(Math.min(group, dest.length), 0, { ...g!, weight });
  return next;
}

/**
 * The flex weight that draws a group `height` pixels tall in a column
 * `columnHeight` tall, beside groups whose weights add up to `othersWeight`
 * (the space they share is what the moving group leaves them). Alone in its
 * column a group fills it, whatever its weight.
 */
export function weightForHeight(height: number, columnHeight: number, othersWeight: number): number {
  if (othersWeight <= 0 || columnHeight <= 0) return 1;
  const h = Math.max(1, Math.min(height, columnHeight - 1));
  return (h / (columnHeight - h)) * othersWeight;
}
