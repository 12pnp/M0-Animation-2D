import { adoptBefore, type Command, type TouchSet } from "./Command";
import type {
    BlendMode,
    ColorTransform,
    DisplayRef,
    Layer,
    Node,
    NodeKind,
    Project,
    SymbolItem,
} from "@/core/doc/types";
import { isDefaultColor } from "@/core/doc/types";
import type { Transform } from "@/core/math/Transform";
import { cloneTf } from "@/core/math/Transform";
import type { ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import {
    denormalize,
    type Normalization,
    normalizeLayerOrder,
} from "@/core/doc/layerTree";
import { durationFor } from "./timelineCommands";
import { symbolOf } from "./lookup";

/* ── Nodes and layers ────────────────────────────────────────────────────*/

export class AddNode implements Command {
  readonly kind = "node.add";
  readonly touches: TouchSet;
  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly node: Node,
    private readonly layer: Layer,
    /** Insert position in the layer list; 0 is the top layer. */
    private readonly at = 0,
  ) {
    this.touches = { symbols: [symbolId], nodes: [node.id], stage: true, timeline: true };
  }

  private norm: Normalization | null = null;

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    sym.nodes[this.node.id] = this.node;
    sym.layers.splice(Math.min(this.at, sym.layers.length), 0, this.layer);
    this.norm = normalizeLayerOrder(sym);
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    delete sym.nodes[this.node.id];
    sym.layers = sym.layers.filter((l) => l.id !== this.layer.id);
    for (const anim of sym.animations) delete anim.tracks[this.node.id];
    invalidateBounds([this.symbolId]);
  }
}

/**
 * Removing a node keeps the whole detached subtree — the node, its layer,
 * its animation tracks and any IK constraints referencing it — alive inside
 * the command. Ids are never remapped, so redo and every later command still
 * resolve their references.
 */
export class RemoveNodes implements Command {
  readonly kind = "node.remove";
  readonly touches: TouchSet;
  readonly label = "Delete";

  private removedNodes: Node[] = [];
  private removedLayers: Array<{ layer: Layer; index: number }> = [];
  private removedTracks: Array<{ animId: string; nodeId: NodeId; track: unknown }> = [];
  private removedIk: Array<{ index: number; constraint: unknown }> = [];
  /** The transform constraints as they were: one whose source goes is
   *  removed, one that loses bones keeps the rest. */
  private transformsBefore: SymbolItem["transforms"] | null = null;
  private reparented: Array<{ nodeId: NodeId; oldParent: NodeId | null }> = [];
  private durations: Array<{ animId: string; before: number }> = [];
  private norm: Normalization | null = null;

  constructor(private readonly symbolId: ItemId, private readonly ids: NodeId[]) {
    this.touches = { symbols: [symbolId], nodes: ids, stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const doomed = new Set<NodeId>();
    const collect = (id: NodeId) => {
      if (doomed.has(id)) return;
      doomed.add(id);
      for (const n of Object.values(sym.nodes)) {
        if (n.parentId === id) collect(n.id);
      }
    };
    for (const id of this.ids) collect(id);

    this.removedNodes = [];
    this.removedLayers = [];
    this.removedTracks = [];
    this.removedIk = [];
    this.reparented = [];

    // Indices in the list as it was, so re-inserting in ascending order
    // rebuilds it. Taken one removal at a time, a group and its children all
    // got the group's index and came back in reverse.
    sym.layers.forEach((layer, index) => {
      if (doomed.has(layer.nodeId) && sym.nodes[layer.nodeId]) this.removedLayers.push({ layer, index });
    });
    sym.layers = sym.layers.filter((l) => !this.removedLayers.some((r) => r.layer === l));

    for (const id of doomed) {
      const node = sym.nodes[id];
      if (!node) continue;
      this.removedNodes.push(node);
      delete sym.nodes[id];
      for (const anim of sym.animations) {
        const t = anim.tracks[id];
        if (t) {
          this.removedTracks.push({ animId: anim.id, nodeId: id, track: t });
          delete anim.tracks[id];
        }
      }
    }

    for (let i = sym.ik.length - 1; i >= 0; i--) {
      const k = sym.ik[i]!;
      if (doomed.has(k.boneId) || doomed.has(k.targetId)) {
        this.removedIk.push({ index: i, constraint: k });
        sym.ik.splice(i, 1);
      }
    }

    this.transformsBefore = sym.transforms ?? null;
    if (sym.transforms?.some((k) => doomed.has(k.sourceId) || k.boneIds.some((b) => doomed.has(b)))) {
      const kept = sym.transforms
        .filter((k) => !doomed.has(k.sourceId))
        .map((k) => (k.boneIds.some((b) => doomed.has(b)) ? { ...k, boneIds: k.boneIds.filter((b) => !doomed.has(b)) } : k))
        .filter((k) => k.boneIds.length);
      if (kept.length) sym.transforms = kept;
      else delete sym.transforms;
    }

    // The animation is as long as its longest track, so deleting the layer
    // that reached furthest shortens it. Leaving the number alone left the
    // timeline claiming frames nothing was on any more. `durationFor` keeps
    // the stored value when NOTHING is keyed, so deleting the last keyed
    // layer does not collapse the animation to one frame.
    this.durations = [];
    for (const anim of sym.animations) {
      this.durations.push({ animId: anim.id, before: anim.duration });
      anim.duration = durationFor(anim);
    }

    // Deleting a mask leaves its targets linked to nothing.
    this.norm = normalizeLayerOrder(sym);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.norm) denormalize(sym, this.norm);
    for (const { animId, before } of this.durations) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.duration = before;
    }
    for (const n of this.removedNodes) sym.nodes[n.id] = n;
    for (const { layer, index } of [...this.removedLayers].sort((a, b) => a.index - b.index)) {
      sym.layers.splice(Math.min(index, sym.layers.length), 0, layer);
    }
    for (const { animId, nodeId, track } of this.removedTracks) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) anim.tracks[nodeId] = track as never;
    }
    for (const { index, constraint } of [...this.removedIk].sort((a, b) => a.index - b.index)) {
      sym.ik.splice(Math.min(index, sym.ik.length), 0, constraint as never);
    }
    if (this.transformsBefore) sym.transforms = this.transformsBefore;
    else delete sym.transforms;
    for (const { nodeId, oldParent } of this.reparented) {
      const n = sym.nodes[nodeId];
      if (n) n.parentId = oldParent;
    }
    invalidateBounds([this.symbolId]);
  }

  estimateSize(): number { return this.removedNodes.length * 512; }
}

/**
 * Sets a node's bind transform. Merges during a drag so a 60fps gizmo lands
 * in history as a single undo entry.
 */
export class SetBindTransform implements Command {
  readonly kind = "node.transform";
  readonly touches: TouchSet;
  readonly label = "Transform";
  private before = new Map<NodeId, Transform>();
  private after: Map<NodeId, Transform>;

  constructor(private readonly symbolId: ItemId, next: Map<NodeId, Transform>) {
    this.after = new Map([...next].map(([k, v]) => [k, cloneTf(v)]));
    this.touches = { symbols: [symbolId], nodes: [...next.keys()], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before.size === 0) {
      for (const id of this.after.keys()) {
        const n = sym.nodes[id];
        if (n) this.before.set(id, cloneTf(n.bind));
      }
    }
    for (const [id, t] of this.after) {
      const n = sym.nodes[id];
      if (n) n.bind = cloneTf(t);
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, t] of this.before) {
      const n = sym.nodes[id];
      if (n) n.bind = cloneTf(t);
    }
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetBindTransform)) return false;
    if (next.symbolId !== this.symbolId) return false;
    this.touches.nodes?.push(...adoptBefore(this.before, next.before));
    for (const [id, t] of next.after) this.after.set(id, cloneTf(t));
    return true;
  }
}

/**
 * Bind-pose colour, the Setup-mode counterpart of a keyframe's `color`.
 *
 * Merges like SetBindTransform so dragging a colour slider is one undo entry
 * rather than one per pointermove.
 */
export class SetBindColor implements Command {
  readonly kind = "node.color";
  readonly touches: TouchSet;
  readonly label = "Colour";
  private before = new Map<NodeId, ColorTransform | undefined>();
  private after: Map<NodeId, ColorTransform | undefined>;

  constructor(private readonly symbolId: ItemId, next: Map<NodeId, ColorTransform | undefined>) {
    this.after = new Map([...next].map(([k, v]) => [k, v ? { ...v } : undefined]));
    this.touches = { symbols: [symbolId], nodes: [...next.keys()], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (this.before.size === 0) {
      for (const id of this.after.keys()) {
        const n = sym.nodes[id];
        if (n) this.before.set(id, n.color ? { ...n.color } : undefined);
      }
    }
    for (const [id, c] of this.after) {
      const n = sym.nodes[id];
      if (n) assignColor(n, c);
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, c] of this.before) {
      const n = sym.nodes[id];
      if (n) assignColor(n, c);
    }
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetBindColor)) return false;
    if (next.symbolId !== this.symbolId) return false;
    this.touches.nodes?.push(...adoptBefore(this.before, next.before));
    for (const [id, c] of next.after) this.after.set(id, c ? { ...c } : undefined);
    return true;
  }
}

/** A neutral colour is stored as absent, so `isDefaultColor` stays the one test. */
function assignColor(n: Node, c: ColorTransform | undefined): void {
  if (!c || isDefaultColor(c)) delete n.color;
  else n.color = { ...c };
}

/**
 * Blend mode is a SETUP-pose property: the runtime has no blendMode timeline
 * (`Slot.init` reads it once from `_slotData`), so it cannot be keyed.
 */
/** How dragging a bone's path turns it: alone, or with its parent. */
export class SetPathDrag implements Command {
  readonly kind = "node.pathDrag";
  readonly touches: TouchSet;
  readonly label = "Path Drag Option";
  private before = new Map<NodeId, "parent" | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeIds: NodeId[],
    private readonly value: "parent" | undefined,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...nodeIds] };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const id of this.nodeIds) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, n.pathDrag);
      if (this.value) n.pathDrag = this.value;
      else delete n.pathDrag;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, v] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (v) n.pathDrag = v;
      else delete n.pathDrag;
    }
  }
}

/** Mark bones as primary, or unmark them (`Node.primary`). */
export class SetBonePrimary implements Command {
  readonly kind = "node.primary";
  readonly touches: TouchSet;
  readonly label: string;
  private before = new Map<NodeId, true | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeIds: NodeId[],
    private readonly value: boolean,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...nodeIds] };
    this.label = value ? "Mark Primary" : "Unmark Primary";
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const id of this.nodeIds) {
      const n = sym.nodes[id];
      if (!n || n.kind !== "bone") continue;
      this.before.set(id, n.primary);
      if (this.value) n.primary = true;
      else delete n.primary;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, v] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (v) n.primary = v;
      else delete n.primary;
    }
  }
}

export class SetNodeBlendMode implements Command {
  readonly kind = "node.blendMode";
  readonly touches: TouchSet;
  readonly label = "Blend Mode";
  private before = new Map<NodeId, BlendMode | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeIds: NodeId[],
    private readonly value: BlendMode,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...nodeIds], stage: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const id of this.nodeIds) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, n.blendMode);
      if (this.value === "normal") delete n.blendMode;
      else n.blendMode = this.value;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, m] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (m === undefined) delete n.blendMode;
      else n.blendMode = m;
    }
  }
}

/**
 * Point a node at a different library item — Flash's "Swap Symbol", and the
 * same command that fills an empty layer when something is dropped on it.
 *
 * An instance differs from another in its display: `kind` and `itemId` for
 * display 0, an entry of `extraDisplays` otherwise; the bind pose, the transform point, colour, blend mode, the
 * layer, every keyframe and every IK constraint live elsewhere on the node or
 * the symbol and survive untouched. `kind` has to move with `itemId` because
 * the exporter reads it (`node.kind === "symbol"` picks the armature display),
 * even though the renderer resolves the item and would self-correct.
 *
 * Transform points are deliberately NOT compensated for a size change: the
 * intent is "same pose, different artwork", exactly as Flash behaves.
 * `wouldCreateCycle` is the caller's job, as it is on every other entry point
 * that can put a symbol inside another.
 */
export class SetNodeItem implements Command {
  readonly kind = "node.item";
  readonly touches: TouchSet;
  readonly label = "Swap Instance";
  private before = new Map<NodeId, { itemId?: ItemId; kind: NodeKind; extras?: DisplayRef[] }>();

  /** `display` ≥ 1 swaps that entry of `extraDisplays` and leaves `kind`,
   *  which describes display 0, alone. */
  constructor(
    private readonly symbolId: ItemId,
    private readonly next: Map<NodeId, { itemId: ItemId; kind: NodeKind; display?: number }>,
  ) {
    this.touches = {
      symbols: [symbolId], nodes: [...next.keys()], stage: true, timeline: true,
    };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const [id, to] of this.next) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, { itemId: n.itemId, kind: n.kind, extras: n.extraDisplays });
      const d = to.display ?? 0;
      if (d > 0 && n.extraDisplays?.[d - 1]) {
        n.extraDisplays = n.extraDisplays.map((e, i) =>
          (i === d - 1 ? { itemId: to.itemId, pivot: e.pivot } : e));
        continue;
      }
      n.itemId = to.itemId;
      n.kind = to.kind;
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, was] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (was.itemId === undefined) delete n.itemId;
      else n.itemId = was.itemId;
      n.kind = was.kind;
      if (was.extras) n.extraDisplays = was.extras;
      else delete n.extraDisplays;
    }
    invalidateBounds([this.symbolId]);
  }
}

/**
 * Replace a node's `extraDisplays` — how pasted frames bring artwork a
 * layer did not have. A value like a track: the new array goes in, the old
 * one comes back on undo, and neither is ever edited.
 */
export class SetNodeDisplays implements Command {
  readonly kind = "node.displays";
  readonly touches: TouchSet;
  readonly label = "Add Display";
  private before = new Map<NodeId, DisplayRef[] | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly next: Map<NodeId, DisplayRef[]>,
  ) {
    this.touches = { symbols: [symbolId], nodes: [...next.keys()], stage: true, timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    this.before.clear();
    for (const [id, extras] of this.next) {
      const n = sym.nodes[id];
      if (!n) continue;
      this.before.set(id, n.extraDisplays);
      if (extras.length) n.extraDisplays = extras;
      else delete n.extraDisplays;
    }
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    for (const [id, was] of this.before) {
      const n = sym.nodes[id];
      if (!n) continue;
      if (was) n.extraDisplays = was;
      else delete n.extraDisplays;
    }
    invalidateBounds([this.symbolId]);
  }
}

export class RenameNode implements Command {
  readonly kind = "node.rename";
  readonly touches: TouchSet;
  readonly label = "Rename";
  private before = "";
  private beforeLayer = "";
  constructor(
    private readonly symbolId: ItemId,
    private readonly nodeId: NodeId,
    private readonly name: string,
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], timeline: true, selection: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const n = sym.nodes[this.nodeId];
    if (!n) return;
    this.before = n.name;
    n.name = this.name;
    const layer = sym.layers.find((l) => l.nodeId === this.nodeId);
    if (layer) { this.beforeLayer = layer.name; layer.name = this.name; }
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const n = sym.nodes[this.nodeId];
    if (n) n.name = this.before;
    const layer = sym.layers.find((l) => l.nodeId === this.nodeId);
    if (layer) layer.name = this.beforeLayer;
  }
}

