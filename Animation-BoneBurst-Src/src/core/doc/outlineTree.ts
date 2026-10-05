/**
 * The Outline's rows, Spine-tree style: which nodes show, how deep, whether a
 * branch is open, and the lines that join a row to its ancestors. Pure, so the
 * panel only paints what this decides.
 */

import type { NodeId } from "./ids";
import type { SymbolItem } from "./types";
import { createsCycle } from "@/core/history/commands";

export interface OutlineShow {
  bones: boolean;
  /** Images, symbols and everything else that is not a bone. */
  images: boolean;
}

export interface OutlineOptions {
  collapsed: ReadonlySet<NodeId>;
  /** Case-insensitive part of a name. While it is set every branch opens to
   *  show its matches; branches with none disappear. */
  query: string;
  show: OutlineShow;
  /** Only this node and what hangs under it (the Sub Tree panel). The root
   *  shows whatever the filters say; a search still has to match inside. */
  root?: NodeId | null;
}

export interface OutlineRow {
  id: NodeId;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  /** The name contains the query (false when there is no query). */
  match: boolean;
  /** For each depth above this row: does that ancestor's line continue below? */
  guides: boolean[];
  /** The last of its siblings: its connector turns the corner. */
  last: boolean;
}

/** Children in layer order, top first — the order the Outline always used. */
export function childrenByParent(sym: SymbolItem): Map<NodeId | null, NodeId[]> {
  const out = new Map<NodeId | null, NodeId[]>();
  const seen = new Set<NodeId>();
  for (const layer of sym.layers) {
    const node = sym.nodes[layer.nodeId];
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    // A broken parent link still gets a row, at the top level.
    const key = node.parentId && sym.nodes[node.parentId] ? node.parentId : null;
    (out.get(key) ?? out.set(key, []).get(key)!).push(node.id);
  }
  return out;
}

export function outlineRows(sym: SymbolItem, opts: OutlineOptions): OutlineRow[] {
  const children = childrenByParent(sym);
  const query = opts.query.trim().toLowerCase();
  const passes = (id: NodeId) => {
    const n = sym.nodes[id]!;
    return n.kind === "bone" ? opts.show.bones : opts.show.images;
  };
  const matches = (id: NodeId) => !!query && sym.nodes[id]!.name.toLowerCase().includes(query);

  // A node a filter hides hands its children up to the nearest shown ancestor.
  const shownChildren = new Map<NodeId | null, NodeId[]>();
  const shownUnder = (id: NodeId | null): NodeId[] => {
    const cached = shownChildren.get(id);
    if (cached) return cached;
    const out: NodeId[] = [];
    for (const c of children.get(id) ?? []) {
      if (passes(c)) out.push(c);
      else out.push(...shownUnder(c));
    }
    shownChildren.set(id, out);
    return out;
  };

  // With a query, a branch stays only if it holds a match.
  const keep = new Map<NodeId, boolean>();
  const holdsMatch = (id: NodeId): boolean => {
    const k = keep.get(id);
    if (k !== undefined) return k;
    const v = matches(id) || shownUnder(id).some(holdsMatch);
    keep.set(id, v);
    return v;
  };

  const rows: OutlineRow[] = [];
  const walk = (ids: NodeId[], depth: number, guides: boolean[]) => {
    const list = query ? ids.filter(holdsMatch) : ids;
    list.forEach((id, i) => {
      const last = i === list.length - 1;
      const kids = query ? shownUnder(id).filter(holdsMatch) : shownUnder(id);
      const open = kids.length > 0 && (!!query || !opts.collapsed.has(id));
      rows.push({ id, depth, hasChildren: kids.length > 0, open, match: matches(id), guides, last });
      if (open) walk(kids, depth + 1, [...guides, !last]);
    });
  };
  const start = opts.root === undefined || opts.root === null
    ? shownUnder(null)
    : sym.nodes[opts.root] ? [opts.root] : [];
  walk(start, 0, []);
  return rows;
}

/** Shift-click: every row from the anchor to the clicked one, in row order. */
export function rowRange(rows: readonly OutlineRow[], anchor: NodeId, to: NodeId): NodeId[] {
  const a = rows.findIndex((r) => r.id === anchor);
  const b = rows.findIndex((r) => r.id === to);
  if (a < 0 || b < 0) return [to];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return rows.slice(lo, hi + 1).map((r) => r.id);
}

/** The ancestors to open so `id`'s row shows. */
export function ancestorsOf(sym: SymbolItem, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  let p = sym.nodes[id]?.parentId ?? null;
  const seen = new Set<NodeId>();
  while (p && sym.nodes[p] && !seen.has(p)) {
    seen.add(p);
    out.push(p);
    p = sym.nodes[p]!.parentId ?? null;
  }
  return out;
}

/**
 * Where a dragged row may land: under another node (never itself or its own
 * descendant — that would close a loop), or `null` for the top level.
 */
export function canDropOn(sym: SymbolItem, dragged: NodeId, target: NodeId | null): boolean {
  if (target === dragged) return false;
  if (target === null) return !!sym.nodes[dragged]?.parentId;
  if (sym.nodes[dragged]?.parentId === target) return false;
  return !createsCycle(sym, dragged, target);
}
