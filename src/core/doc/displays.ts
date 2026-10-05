import type { ItemId } from "./ids";
import type { DisplayRef, LinkedMesh, MeshData, Node, NodeKind, Project } from "./types";

/**
 * A node's display list, the way a DragonBones slot has one: index 0 is the
 * node's own `itemId` and `pivot`, the rest are `extraDisplays`. A keyframe's
 * `displayIndex` picks one; -1 shows nothing. Bones, groups and empty layers
 * have no display at all.
 */
export function displaysOf(node: Node): DisplayRef[] {
  if (!node.itemId) return [];
  return [displayZero(node, node.itemId), ...(node.extraDisplays ?? [])];
}

export function displayAt(node: Node, index: number): DisplayRef | null {
  if (index < 0 || !node.itemId) return null;
  if (index === 0) return displayZero(node, node.itemId);
  return node.extraDisplays?.[index - 1] ?? null;
}

function displayZero(node: Node, itemId: ItemId): DisplayRef {
  const d: DisplayRef = { itemId, pivot: node.pivot };
  if (node.attachment) d.attachment = node.attachment;
  if (node.key) d.key = node.key;
  if (node.attachmentName) d.name = node.attachmentName;
  if (node.linked) d.linked = node.linked;
  if (node.mesh) d.mesh = node.mesh;
  if (node.skinOnly) d.skinOnly = true;
  if (node.sequence) d.sequence = node.sequence;
  if (node.region) d.region = node.region;
  return d;
}

/**
 * The mesh a display draws: its own, or the one it is linked to (with that
 * display's transform point, since the points are placed about it), and
 * whether it takes the node's deform keys. Null for a display that is not a mesh.
 */
export function meshOfDisplay(
  node: Node, display: DisplayRef, inSkin?: (skin: string, index: number) => DisplayRef | null | undefined,
): { mesh: MeshData; pivot: { x: number; y: number }; deform: boolean } | null {
  if (display.mesh) return { mesh: display.mesh, pivot: display.pivot, deform: true };
  if (!display.linked) return null;
  // A link naming a skin draws that skin's display (Spine's `skin`).
  const parent = display.linked.skin ? inSkin?.(display.linked.skin, display.linked.to) : displayAt(node, display.linked.to);
  return parent?.mesh ? { mesh: parent.mesh, pivot: parent.pivot, deform: display.linked.deform !== false } : null;
}

/** The node a node's transform hangs from: the bone a slot rides, else its
 *  parent. */
export function anchorOf(node: Node): Node["parentId"] {
  return node.slotBone ?? node.parentId;
}

/** Every library item the node can show — what usage counts, cycle checks
 *  and the export's dependency walk have to follow. */
export function itemsOf(node: Node): ItemId[] {
  return displaysOf(node).map((d) => d.itemId);
}

export function sameDisplay(a: DisplayRef, b: DisplayRef): boolean {
  return a.itemId === b.itemId && a.pivot.x === b.pivot.x && a.pivot.y === b.pivot.y;
}

/**
 * The index `ref` has in `displays`, appending it when no entry shows the
 * same item about the same point. The pivot is part of the identity: a
 * keyframe's transform places the bone at its display's transform point, so
 * the same image anchored elsewhere is a different display.
 */
export function findOrAddDisplay(
  displays: DisplayRef[], ref: DisplayRef,
): { displays: DisplayRef[]; index: number } {
  const found = displays.findIndex((d) => sameDisplay(d, ref));
  if (found >= 0) return { displays, index: found };
  return {
    displays: [...displays, { itemId: ref.itemId, pivot: { ...ref.pivot } }],
    index: displays.length,
  };
}

/** The node kind an item makes, for display 0. */
export function kindOfItem(project: Project, itemId: ItemId): NodeKind {
  return project.items[itemId]?.kind === "symbol" ? "symbol" : "image";
}

/** The node with display `index` linked as `link` (or no longer linked);
 *  the same node when `index` is not a display or `link` names itself. */
export function withLink(node: Node, index: number, link: LinkedMesh | undefined): Node {
  if (!displayAt(node, index) || link?.to === index) return node;
  if (index === 0) {
    const { linked: _l, ...rest } = node;
    return link ? { ...rest, linked: link } : rest;
  }
  const extras = [...node.extraDisplays!];
  const { linked: _l, ...ref } = extras[index - 1]!;
  extras[index - 1] = link ? { ...ref, linked: link } : ref;
  return { ...node, extraDisplays: extras };
}

/** Every display of the node that is an image without a mesh of its own:
 *  what can draw display `to`'s mesh. */
export function linkableDisplays(node: Node, to: number): number[] {
  return displaysOf(node).flatMap((d, i) => (i !== to && !d.mesh && !d.sequence && !d.attachment ? [i] : []));
}
