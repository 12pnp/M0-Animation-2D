import type { Command, TouchSet } from "./Command";
import type { DeformKey, MeshData, Node, Project, SymbolItem } from "@/core/doc/types";
import { isSymbol } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";

function symbolOf(p: Project, id: ItemId): SymbolItem {
  const s = p.items[id];
  if (!isSymbol(s)) throw new Error(`Not a symbol: ${id}`);
  return s;
}

/** `node` with display `index`'s mesh replaced (none: back to an image). */
function withMesh(node: Node, index: number, mesh: MeshData | undefined): Node {
  if (index === 0) {
    const out: Node = { ...node };
    if (mesh) out.mesh = mesh; else delete out.mesh;
    return out;
  }
  const extras = (node.extraDisplays ?? []).map((d, i) => {
    if (i !== index - 1) return d;
    const out = { ...d };
    if (mesh) out.mesh = mesh; else delete out.mesh;
    return out;
  });
  return { ...node, extraDisplays: extras };
}

function meshOf(node: Node, index: number): MeshData | undefined {
  return index === 0 ? node.mesh : node.extraDisplays?.[index - 1]?.mesh;
}

/**
 * A node's mesh replaced (ARCHITECTURE ▸ Meshes): made, edited, bound,
 * removed; with the deform keys of the animations a change of points
 * touched. Steps of one drag share a `kind` and merge.
 */
export class SetMesh implements Command {
  readonly touches: TouchSet;
  private before: { mesh: MeshData | undefined; deforms: Map<AnimId, DeformKey[] | undefined> } | null = null;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly nodeId: NodeId,
    private readonly index: number,
    private after: MeshData | undefined,
    private deforms: Map<AnimId, DeformKey[]> = new Map(),
    readonly kind = "mesh.edit",
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], stage: true, timeline: deforms.size > 0 };
  }

  private writeDeforms(sym: SymbolItem, keys: Map<AnimId, DeformKey[] | undefined>): void {
    for (const [animId, list] of keys) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (!anim) continue;
      const out = { ...anim.deforms };
      if (list?.length) out[this.nodeId] = list; else delete out[this.nodeId];
      if (Object.keys(out).length) anim.deforms = out; else delete anim.deforms;
    }
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const node = sym.nodes[this.nodeId];
    if (!node) return;
    if (!this.before) {
      const deforms = new Map<AnimId, DeformKey[] | undefined>();
      for (const id of this.deforms.keys()) deforms.set(id, sym.animations.find((a) => a.id === id)?.deforms?.[this.nodeId]);
      this.before = { mesh: meshOf(node, this.index), deforms };
    }
    sym.nodes[this.nodeId] = withMesh(node, this.index, this.after);
    this.writeDeforms(sym, this.deforms);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const node = sym.nodes[this.nodeId];
    if (!node || !this.before) return;
    sym.nodes[this.nodeId] = withMesh(node, this.index, this.before.mesh);
    this.writeDeforms(sym, this.before.deforms);
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetMesh) || next.kind !== this.kind) return false;
    if (next.symbolId !== this.symbolId || next.nodeId !== this.nodeId || next.index !== this.index) return false;
    this.after = next.after;
    for (const [id, keys] of next.deforms) this.deforms.set(id, keys);
    return true;
  }
}

/** One mesh node's deform keys in an animation replaced. Steps of one drag merge. */
export class SetDeformKeys implements Command {
  readonly touches: TouchSet;
  private before: DeformKey[] | undefined;
  private captured = false;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private readonly nodeId: NodeId,
    private after: DeformKey[],
    readonly kind = "timeline.deform",
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], timeline: true, stage: true };
  }

  private write(p: Project, keys: DeformKey[] | undefined): void {
    const anim = symbolOf(p, this.symbolId).animations.find((a) => a.id === this.animId);
    if (!anim) return;
    const out = { ...anim.deforms };
    if (keys?.length) out[this.nodeId] = keys; else delete out[this.nodeId];
    if (Object.keys(out).length) anim.deforms = out; else delete anim.deforms;
    invalidateBounds([this.symbolId]);
  }

  apply(p: Project): void {
    if (!this.captured) {
      this.before = symbolOf(p, this.symbolId).animations.find((a) => a.id === this.animId)?.deforms?.[this.nodeId];
      this.captured = true;
    }
    this.write(p, this.after);
  }

  revert(p: Project): void { this.write(p, this.before); }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetDeformKeys) || next.kind !== this.kind) return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId || next.nodeId !== this.nodeId) return false;
    this.after = next.after;
    return true;
  }
}
