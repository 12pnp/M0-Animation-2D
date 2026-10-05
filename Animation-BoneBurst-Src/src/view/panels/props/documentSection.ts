import { h, on } from "@/view/widgets/dom";
import { NumberField } from "@/view/widgets/NumberField";
import {
  RenameNode
} from "@/core/history/commands";
import { type DocumentSettingsPatch, SetDocumentSettings } from "@/core/history/settingsCommands";
import {
  displayAtFrame
} from "@/app/TimelineOps";
import { frameDirections, SCENE_FRAME } from "@/view/viewport/nodeFrame";
import {
  isSymbol,
  type Node
} from "@/core/doc/types";
import type { PropertiesPanel } from "@/view/panels/PropertiesPanel";

/**
 * Properties ▸ Document and Instance, with the frame note.
 */

/**
 * With nothing selected the panel becomes the document's own settings —
 * frame rate, stage size, background — which is where Animate puts them
 * and therefore where people look for them.
 */
export function documentSection(api: PropertiesPanel): HTMLElement {
  const p = api.store.project;

  const docField = (
    glyph: string, read: () => number, min: number, max: number,
    write: (v: number) => DocumentSettingsPatch,
  ) => {
    const nf = new NumberField({
      glyph, min, max, step: 1, decimals: 0,
      onInput: (v, committing) => {
        api.scrubStep("doc.settings", committing);
        api.store.apply(new SetDocumentSettings(write(v)));
        api.store.emit("stage");
        api.store.emit("timeline");
        if (committing) api.store.history.endInteraction();
      },
    });
    nf.set(read());
    api.docSync.push(() => nf.show(read()));
    return nf.el;
  };

  const swatch = h("input", { type: "color", value: p.stage.background, class: "swatch" });
  on(swatch, "input", () => {
    api.store.apply(new SetDocumentSettings({ background: swatch.value }));
    api.store.emit("stage");
  });
  api.docSync.push(() => {
    if (document.activeElement !== swatch) swatch.value = api.store.project.stage.background;
  });

  // NOT the document's name on disk — the tab shows the file for that. This
  // is the name the exporter writes into `_ske.json`, uses for the atlas
  // pages and for the export's own file name, so it is the one thing about
  // the project that a runtime actually reads back.
  const nameInput = h("input", {
    type: "text", value: p.name,
    title: "Name of the exported files and of the armature inside them. Not the name of the project file.",
  });
  const commitName = () => {
    const next = nameInput.value.trim();
    if (!next || next === api.store.project.name) { nameInput.value = api.store.project.name; return; }
    api.store.apply(new SetDocumentSettings({ name: next }));
    api.store.emit("doc");
  };
  on(nameInput, "change", commitName);
  on(nameInput, "blur", commitName);
  on(nameInput, "keydown", (ev) => {
    const e = ev as unknown as KeyboardEvent;
    if (e.key === "Enter") { commitName(); nameInput.blur(); }
    if (e.key === "Escape") { nameInput.value = api.store.project.name; nameInput.blur(); }
    e.stopPropagation();
  });
  api.docSync.push(() => {
    if (document.activeElement !== nameInput) nameInput.value = api.store.project.name;
  });

  const frameValue = h("span", { class: "hint" }, `${api.store.ui.frame + 1}`);
  api.docSync.push(() => {
    const text = `${api.store.ui.frame + 1}`;
    if (frameValue.textContent !== text) frameValue.textContent = text;
  });

  return api.section("Document", true, [
    api.row("Name", [nameInput]),
    api.row("FPS", [docField("", () => api.store.project.frameRate, 1, 120, (v) => ({ frameRate: v }))]),
    api.linkedRow("Size", "stage",
      docField("W", () => api.store.project.stage.width, 1, 16384, (v) => ({ width: v })),
      docField("H", () => api.store.project.stage.height, 1, 16384, (v) => ({ height: v }))),
    api.row("Background", [swatch]),
    h("div", { class: "prow" }, h("label", null, "Frame"), h("div", { class: "fields" }, frameValue)),
    h("div", { class: "prow wide" },
      h("div", { class: "hint", style: "padding:6px 0 2px" },
        "Nothing selected. Drag an item from the Library onto the stage.")),
  ]);
}

export function instanceSection(api: PropertiesPanel, count: number): HTMLElement {
  const node = api.store.selectedNodes[0]!;
  const shown = displayAtFrame(api.store, node).display;
  const item = shown ? api.store.project.items[shown.itemId] : undefined;
  const name = h("input", { type: "text", value: count > 1 ? "" : node.name });
  if (count > 1) { name.placeholder = `${count} objects selected`; name.disabled = true; }
  api.nameInput = name;

  const commitName = () => {
    const next = name.value.trim();
    if (count > 1 || !next || next === node.name) { name.value = node.name; return; }
    api.store.apply(new RenameNode(api.store.currentSymbolId, node.id, next));
    api.store.emit("doc");
  };
  on(name, "change", commitName);
  on(name, "blur", commitName);
  on(name, "keydown", (ev) => {
    const e = ev as unknown as KeyboardEvent;
    if (e.key === "Enter") { commitName(); name.blur(); }
    if (e.key === "Escape") { name.value = node.name; name.blur(); }
    e.stopPropagation();
  });

  // An empty layer has no library item at all: saying "Of: empty / Type:
  // Bitmap" would describe artwork that is not there.
  const kindLabel =
    node.kind === "empty" ? "Empty layer"
    : node.kind === "bone" ? "Bone"
    : node.kind === "group" ? "Group"
    : node.kind === "box" ? "Bounding box"
    : node.kind === "point" ? "Point"
    : node.kind === "path" ? "Path"
    : isSymbol(item) ? "Symbol instance"
    : "Bitmap";

  // One line, not a section: the type where a row's label goes, the name
  // beside it. The library item it shows is the type's tooltip.
  const showsItem = !(node.kind === "empty" || node.kind === "group" || node.kind === "bone"
    || node.kind === "box" || node.kind === "point" || node.kind === "path");
  const short = kindLabel === "Symbol instance" ? "Symbol" : kindLabel === "Bounding box" ? "Box"
    : kindLabel === "Empty layer" ? "Empty" : kindLabel;
  const type = h("label", { title: showsItem ? `${kindLabel} of “${item ? item.name : "—"}”` : kindLabel }, short);
  name.title = "Name";
  return h("div", { class: "prow pident" }, type, h("div", { class: "fields" }, name));
}

export function noteRow(text: string): HTMLElement {
  return h("div", { class: "pnote" }, text);
}

// ── Builders ───────────────────────────────────────────────────────────

/**
 * "X and Y are not measured the way the screen is."
 *
 * A node's position is the translation of its LOCAL matrix, so it moves
 * along its PARENT's axes — and a bone chain rotates those. `hips` at -90
 * makes `chest`, `head` and everything under them measure y across the stage
 * rather than down it, which reads as a bug the first time you type a number
 * into the field. The badge names the frame and the angle; the stage draws
 * the same thing as a dashed pair of axes.
 */
export function makeFrameNote(api: PropertiesPanel): HTMLElement {
  api.frameNote = h("span", { class: "framenote" });
  api.frameNote.hidden = true;
  return api.frameNote;
}

/** One frame behind while scrubbing, since the viewport renders on rAF and
 *  this runs on the store event — invisible on a rounded degree value. */
export function syncFrameNote(api: PropertiesPanel, nodes: Node[]): void {
  const note = api.frameNote;
  if (!note) return;
  note.hidden = true;

  const pose = api.poseOf();
  if (!pose || nodes.length === 0) return;

  // Only when the whole selection shares one parent: two nodes in different
  // frames have no single answer, and a wrong badge is worse than none.
  const parentId = nodes[0]!.parentId;
  if (nodes.some((n) => n.parentId !== parentId)) return;

  const parentWorld = (parentId ? pose.byNode.get(parentId)?.world : null) ?? SCENE_FRAME;
  const dirs = frameDirections(parentWorld);
  if (!dirs) return;

  const sym = api.store.currentSymbol;
  const parentName = parentId ? sym.nodes[parentId]?.name ?? "the parent" : "the scene";
  const angle = `${dirs.rotation > 0 ? "+" : ""}${Math.round(dirs.rotation)}\u00b0`;
  note.textContent = `\u21bb ${angle}`;
  note.title =
    `X and Y follow ${parentName}, which is rotated ${angle}: ` +
    `+X points ${dirs.x}, +Y points ${dirs.y}. The dashed axes on the stage show the same directions.`;
  note.hidden = false;
}
