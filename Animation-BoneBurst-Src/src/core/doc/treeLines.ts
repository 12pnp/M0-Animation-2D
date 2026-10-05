/**
 * The lines of a tree drawn as a flat list (the timeline's layer list): from
 * each row's depth alone, where a vertical line runs past it and whether its
 * own connector turns the corner. The Outline gets the same from
 * `outlineRows`; both colour a line by its depth (Preferences ▸ Interface ▸
 * Hierarchy lines).
 */

export interface TreeLine {
  /** For each depth above the row: does that level's line continue below? */
  guides: boolean[];
  /** The last of its siblings: its connector turns the corner. */
  last: boolean;
}

/** `depths` in display order, a child right below its parent, one deeper. */
export function treeLines(depths: readonly number[]): TreeLine[] {
  const n = depths.length;
  // A row is last when no sibling follows before the list climbs above it.
  const last = depths.map((d, i) => {
    for (let k = i + 1; k < n; k++) {
      if (depths[k]! < d) return true;
      if (depths[k] === d) return false;
    }
    return true;
  });
  const out: TreeLine[] = [];
  // `open[j]`: the row's ancestor at depth j has siblings still to come.
  const open: boolean[] = [];
  depths.forEach((d, i) => {
    open.length = d;
    out.push({ guides: [...open], last: last[i]! });
    open[d] = !last[i];
  });
  return out;
}

/** How many line colours the palette has; deeper levels repeat them. */
export const TREE_LINE_COLORS = 6;

/** Which palette colour the line at `depth` takes. */
export function lineColorIndex(depth: number): number {
  return ((depth % TREE_LINE_COLORS) + TREE_LINE_COLORS) % TREE_LINE_COLORS;
}
