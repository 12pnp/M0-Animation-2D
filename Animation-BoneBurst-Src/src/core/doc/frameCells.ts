import type { NodeId } from "./ids";

/**
 * The timeline's frame selection is a list of cells, "nodeId:frame". Every
 * producer writes a rectangle, so reading the cells back as bounds is enough
 * for the range operations. A node id may hold a colon itself: the last one
 * splits.
 */

export function frameCell(id: NodeId, frame: number): string {
  return `${id}:${frame}`;
}

/** The cell's node and frame; null when the frame is not a number. */
export function parseFrameCell(cell: string): { id: NodeId; frame: number } | null {
  const cut = cell.lastIndexOf(":");
  const frame = Number(cell.slice(cut + 1));
  return cut >= 0 && Number.isFinite(frame) ? { id: cell.slice(0, cut) as NodeId, frame } : null;
}

/** The nodes the cells name, in first-seen order, and the frames they span;
 *  null when no cell reads. */
export function frameCellBounds(cells: readonly string[]): { ids: NodeId[]; from: number; to: number } | null {
  const ids: NodeId[] = [];
  let from = Infinity, to = -Infinity;
  for (const cell of cells) {
    const c = parseFrameCell(cell);
    if (!c) continue;
    if (!ids.includes(c.id)) ids.push(c.id);
    from = Math.min(from, c.frame);
    to = Math.max(to, c.frame);
  }
  return ids.length ? { ids, from, to } : null;
}
