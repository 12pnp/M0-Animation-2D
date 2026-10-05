import type { Command, TouchSet } from "./Command";
import type { Animation, DeformKey, MeshData, Node, Project, SymbolItem } from "@/core/doc/types";
import type { AnimId, ItemId, NodeId } from "@/core/doc/ids";
import { invalidateBounds } from "@/core/doc/pose";
import { assignDeforms, deformKeysOf, type DeformTarget, withDeformKeysOf } from "@/core/mesh/deform";
import { symbolOf } from "./lookup";
import { SetAnimKeys } from "./animKeysCommand";

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

/** The skins with skin `skin`'s display `index` of `nodeId` given `mesh`. */
function skinsWithMesh(sym: SymbolItem, skin: string, nodeId: NodeId, index: number, mesh: MeshData | undefined): SymbolItem["skins"] {
  return sym.skins?.map((def) => {
    const ref = def.name === skin ? def.displays?.[nodeId]?.[index] : undefined;
    if (!ref) return def;
    const out = { ...ref };
    if (mesh) out.mesh = mesh; else delete out.mesh;
    return { ...def, displays: { ...def.displays, [nodeId]: { ...def.displays![nodeId], [index]: out } } };
  });
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
    /** A skin's display (`shownDisplay`), else the node's own. */
    private readonly skin: string | null = null,
  ) {
    this.touches = { symbols: [symbolId], nodes: [nodeId], stage: true, timeline: deforms.size > 0 };
  }

  private read(sym: SymbolItem, node: Node): MeshData | undefined {
    return this.skin ? sym.skins?.find((d) => d.name === this.skin)?.displays?.[this.nodeId]?.[this.index]?.mesh : meshOf(node, this.index);
  }

  private write(sym: SymbolItem, node: Node, mesh: MeshData | undefined): void {
    if (this.skin) sym.skins = skinsWithMesh(sym, this.skin, this.nodeId, this.index, mesh);
    else sym.nodes[this.nodeId] = withMesh(node, this.index, mesh);
  }

  /** The deform keys of the display this edits, in its skin. */
  private get target(): DeformTarget { return { nodeId: this.nodeId, skin: this.skin, index: this.index }; }

  private writeDeforms(sym: SymbolItem, keys: Map<AnimId, DeformKey[] | undefined>): void {
    for (const [animId, list] of keys) {
      const anim = sym.animations.find((a) => a.id === animId);
      if (anim) assignDeforms(anim, withDeformKeysOf(anim, this.target, list));
    }
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const node = sym.nodes[this.nodeId];
    if (!node) return;
    if (!this.before) {
      const deforms = new Map<AnimId, DeformKey[] | undefined>();
      for (const id of this.deforms.keys()) deforms.set(id, deformKeysOf(sym.animations.find((a) => a.id === id), this.target));
      this.before = { mesh: this.read(sym, node), deforms };
    }
    this.write(sym, node, this.after);
    this.writeDeforms(sym, this.deforms);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    const node = sym.nodes[this.nodeId];
    if (!node || !this.before) return;
    this.write(sym, node, this.before.mesh);
    this.writeDeforms(sym, this.before.deforms);
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetMesh) || next.kind !== this.kind) return false;
    if (next.symbolId !== this.symbolId || next.nodeId !== this.nodeId || next.index !== this.index || next.skin !== this.skin) return false;
    this.after = next.after;
    for (const [id, keys] of next.deforms) this.deforms.set(id, keys);
    return true;
  }
}

/** One mesh display's deform keys in an animation replaced (`DeformTarget`; a
 *  node id alone is its default skin's display 0). Steps of one drag merge. */
export class SetDeformKeys extends SetAnimKeys<DeformKey[]> {
  private readonly target: DeformTarget;

  constructor(label: string, symbolId: ItemId, animId: AnimId, target: NodeId | DeformTarget, after: DeformKey[], kind = "timeline.deform") {
    const t = typeof target === "string" ? { nodeId: target, skin: null, index: 0 } : target;
    super(label, symbolId, animId, after, kind, [t.nodeId]);
    this.target = t;
  }
  protected read(anim: Animation): DeformKey[] | undefined { return deformKeysOf(anim, this.target); }
  protected write(anim: Animation, keys: DeformKey[] | undefined): void { assignDeforms(anim, withDeformKeysOf(anim, this.target, keys)); }
  protected sameList(next: this): boolean {
    const a = this.target, b = next.target;
    return a.nodeId === b.nodeId && a.skin === b.skin && a.index === b.index;
  }
}
