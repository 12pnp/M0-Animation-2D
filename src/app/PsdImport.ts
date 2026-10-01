import type { Store } from "./Store";
import { uniqueFolderName } from "@/core/doc/libraryTree";
import { AddFolder } from "@/core/history/libraryCommands";
import type { AssetStore } from "./AssetStore";
import { phase, type ReportProgress } from "./busy";
import { type PsdRaw, readPsdFile } from "@/io/import/psdReader";
import { buildFlatPsdImport, buildPsdImport, type PsdPlan } from "@/core/doc/psdImport";
import { AddLibraryItem, AddNode, SetDocumentSettings } from "@/core/history/commands";
import { createLayer, createNode } from "@/core/doc/defaults";

export interface PsdImportOutcome {
  /** The symbol wrapping the whole document. */
  symbolName: string;
  images: number;
  symbols: number;
  /** Set when the stage was resized to the document; null otherwise. */
  stage: { width: number; height: number } | null;
  warnings: string[];
  /** The library folder holding everything imported. */
  folderName: string;
}

/**
 * Import a `.psd` as library items, and drop one instance of the document on
 * the stage; or, `flat`, every layer straight into the symbol being edited,
 * ready to rig (`buildFlatPsdImport`).
 *
 * The whole thing is one undo entry. Half an imported PSD is not a state
 * anyone wants to be left in, and `Store.transaction` already gives us that
 * for free by folding the commands into a composite.
 */
export async function importPsd(
  store: Store, assets: AssetStore, file: File,
  /** Where the document's canvas origin lands. Defaults to the symbol's own. */
  at: { x: number; y: number } = { x: 0, y: 0 },
  report: ReportProgress = () => {},
  opts: { flat?: boolean } = {},
): Promise<PsdImportOutcome> {
  const doc = await readPsdFile(file, phase(report, 0, 0.85));
  const registered = phase(report, 0.85, 1);
  const layerCount = (raw: PsdRaw[]): number =>
    raw.reduce((n, r) => n + (r.kind === "group" ? layerCount(r.children) : 1), 0);
  const totalImages = Math.max(1, layerCount(doc.children));

  // Assets are registered before the transaction opens: they live outside the
  // document (the project stores only an AssetId), and decoding is async,
  // which a command must never be.
  let images = 0;
  const toPlan = async (raw: PsdRaw[]): Promise<PsdPlan[]> => {
    const out: PsdPlan[] = [];
    for (const node of raw) {
      if (node.kind === "group") {
        out.push({
          kind: "group", name: node.name, visible: node.visible,
          children: await toPlan(node.children),
        });
        continue;
      }
      const asset = await assets.addFromBlob(node.blob, node.name || "layer");
      registered(++images / totalImages);
      out.push({
        kind: "image",
        name: node.name,
        x: node.x, y: node.y, width: node.width, height: node.height,
        assetId: asset.id,
        visible: node.visible,
        blendMode: node.blendMode,
      });
    }
    return out;
  };

  const plan = await toPlan(doc.children);
  const taken = new Set(Object.values(store.project.items).map((i) => i.name));
  const hostId = store.currentSymbolId;
  // A PSD is usually bigger than an 800x600 stage, and landing mostly
  // off-stage looks broken. In an empty project the document defines the
  // frame, so adopt its canvas; in a project with work in it, touching the
  // stage would be presumptuous.
  const empty = hostId === store.project.rootSymbolId
    && store.currentSymbol.layers.length === 0
    && store.project.itemOrder.length === 1;
  const resizeStage = empty
    && (doc.width !== store.project.stage.width || doc.height !== store.project.stage.height);
  const folderName = uniqueFolderName(store.project, null, doc.name);

  if (opts.flat) {
    // Node names are unique in the symbol as well as in the library: the
    // rig names its bones and slots after them.
    const nodeNames = new Set(Object.values(store.currentSymbol.nodes).map((n) => n.name));
    const flat = buildFlatPsdImport(plan, (name) => taken.has(name) || nodeNames.has(name), folderName);
    store.transaction(`Import ${file.name}`, () => {
      store.apply(new AddFolder(flat.folder));
      for (const item of flat.items) store.apply(new AddLibraryItem(`Import ${item.name}`, item));
      // Back to front, each on top: the front layer ends up first.
      for (const { node, visible } of [...flat.layers].reverse()) {
        node.bind = { ...node.bind, x: node.bind.x + at.x, y: node.bind.y + at.y };
        const layer = createLayer(node.id, node.name, store.currentSymbol.layers.length);
        layer.visible = visible;
        store.apply(new AddNode(`Import ${node.name}`, hostId, node, layer, 0));
      }
      if (resizeStage) store.apply(new SetDocumentSettings({ width: doc.width, height: doc.height }));
    });
    store.selectNodes(flat.layers.map((l) => l.node.id));
    store.emit("library");
    store.emit("doc");
    if (resizeStage) store.emit("stage");
    return {
      symbolName: store.currentSymbol.name, images, symbols: 0,
      stage: resizeStage ? { width: doc.width, height: doc.height } : null,
      warnings: doc.warnings, folderName,
    };
  }

  // Its groups become library folders under one named after the file: a PSD
  // brings dozens of items, and loose they bury the rest of the library.
  const { items, root, folders } = buildPsdImport(doc.name, plan, (name) => taken.has(name), folderName);
  const instance = createNode("symbol", root.name, { itemId: root.id, x: at.x, y: at.y });
  const layer = createLayer(instance.id, instance.name, store.currentSymbol.layers.length);

  store.transaction(`Import ${file.name}`, () => {
    for (const f of folders) store.apply(new AddFolder(f));
    // Children before parents, so a symbol never references an item the
    // library has not seen yet.
    for (const item of items) store.apply(new AddLibraryItem(`Import ${item.name}`, item));
    store.apply(new AddNode(`Import ${root.name}`, hostId, instance, layer, 0));
    if (resizeStage) {
      store.apply(new SetDocumentSettings({ width: doc.width, height: doc.height }));
    }
  });

  store.selectNodes([instance.id]);
  store.emit("library");
  store.emit("doc");

  if (resizeStage) store.emit("stage");

  return {
    symbolName: root.name,
    images,
    symbols: items.length - images,
    stage: resizeStage ? { width: doc.width, height: doc.height } : null,
    warnings: doc.warnings,
    folderName: folders[0]!.name,
  };
}
